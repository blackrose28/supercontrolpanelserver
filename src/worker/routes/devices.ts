import type { WorkerEnv } from '../types';
import { D1DeviceStore } from '../db/d1-device-store';
import { nowMs } from '../env-helpers';
import { jsonResponse, sseFrame, sseStreamResponse, streamPollMs } from '../http';
import { requireAdminAuth, requireAdminAndDevice, getBearerToken } from '../auth';

export function publicDevice(device: { id: string; name: string; lastSeenAt: string; status: string; os?: string | null }) {
  return {
    id: device.id,
    name: device.name,
    lastSeenAt: device.lastSeenAt,
    status: device.status,
    os: device.os ?? undefined,
  };
}

export async function handleListDevices(request: Request, env: WorkerEnv): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:read']);
  if (auth instanceof Response) return auth;
  const devices = await new D1DeviceStore(auth.db).getAllDevices();
  return jsonResponse(devices.map(publicDevice));
}

export async function handleGetDevice(request: Request, env: WorkerEnv, deviceId: string): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:read']);
  if (auth instanceof Response) return auth;
  const device = await new D1DeviceStore(auth.db).getDevice(deviceId);
  if (!device) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  return jsonResponse(publicDevice(device));
}

export async function handleDeleteDevice(request: Request, env: WorkerEnv, deviceId: string): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:control']);
  if (auth instanceof Response) return auth;
  const removed = await new D1DeviceStore(auth.db).removeDevice(deviceId);
  if (!removed) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  return jsonResponse({ removed: true });
}

export async function handleRevokeDevice(request: Request, env: WorkerEnv): Promise<Response> {
  const token = getBearerToken(request);
  if (!token) return jsonResponse({ error: 'Missing agent authorization header' }, { status: 401 });
  const db = (await import('../env-helpers')).requireD1(env);
  if (db instanceof Response) return db;
  const devices = new D1DeviceStore(db);
  const device = await devices.findDeviceByAgentToken(token);
  if (!device) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  await devices.removeDevice(device.id);
  return jsonResponse({ removed: true });
}

export async function handleDevicesStream(request: Request, env: WorkerEnv): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:read']);
  if (auth instanceof Response) return auth;
  const store = new D1DeviceStore(auth.db);
  const devices = await store.getAllDevices();
  const lastStatus = new Map(devices.map((device) => [device.id, device.status]));
  const frameFor = (device: { id: string; name: string; lastSeenAt: string; status: string; os?: string | null }) => sseFrame(
    device.status === 'connected' ? 'device-connected' : 'device-disconnected',
    publicDevice(device),
  );
  return sseStreamResponse([], {
    intervalMs: streamPollMs(env),
    next: async () => {
      const current = await store.getAllDevices();
      const frames: string[] = [];
      for (const device of current) {
        const previous = lastStatus.get(device.id);
        if (previous !== device.status) {
          frames.push(frameFor(device));
          lastStatus.set(device.id, device.status);
        }
      }
      return frames;
    },
  });
}

export async function handleDeviceSummary(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'));
  if (required instanceof Response) return required;
  const { D1LogStore } = await import('../db/d1-log-store');
  return jsonResponse(await new D1LogStore(required.db).getDeviceRuntimeSummary(required.deviceId));
}
