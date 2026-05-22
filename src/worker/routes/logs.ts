import type { WorkerEnv } from '../types';
import { D1LogStore, WorkerTelemetryFilter } from '../db/d1-log-store';
import { D1DeviceStore } from '../db/d1-device-store';
import { D1RateLimitStore } from '../db/d1-rate-totp-store';
import { D1CommandStore } from '../db/d1-command-store';
import { D1PtySessionStore } from '../db/d1-pty-store';
import { nowMs, makeUuid, requireD1 } from '../env-helpers';
import {
  jsonResponse,
  clampNumber,
  sseFrame,
  sseStreamResponse,
  streamPollMs,
  getClientId,
  decompressGzipBody,
} from '../http';
import {
  requireAdminAuth,
  requireAdminAndDevice,
  authenticateAgentRequest,
} from '../auth';
import { BoundedSeenIds } from '../stream-dedupe';

export function resolveLogFilter(url: URL): WorkerTelemetryFilter {
  return {
    type: url.searchParams.get('type')?.trim() || undefined,
    functionId: url.searchParams.get('functionId')?.trim() || undefined,
    q: url.searchParams.get('q')?.trim() || undefined,
  };
}

type LogIngestBody = {
  events?: Array<Partial<{ type: string; sessionId: string | null; functionId: string | null; seq: number; ts: string; payload: unknown }>>;
} & Partial<{ type: string; sessionId: string | null; functionId: string | null; seq: number; ts: string; payload: unknown }>;

export function normalizeIngestEvents(body: LogIngestBody): Array<Partial<{ type: string; sessionId: string | null; functionId: string | null; seq: number; ts: string; payload: unknown }>> {
  if (Array.isArray(body.events)) return body.events;
  if (body.type) return [body];
  return [];
}

export async function handleListLogs(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'), ['logs:read']);
  if (required instanceof Response) return required;
  const limit = clampNumber(url.searchParams.get('limit'), 100, 1, 1000);
  const logs = await new D1LogStore(required.db).listByDevice(required.deviceId, limit, resolveLogFilter(url));
  return jsonResponse(logs);
}

export async function handleExportLogs(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'), ['logs:export']);
  if (required instanceof Response) return required;
  const limit = clampNumber(url.searchParams.get('limit'), 5000, 1, 50000);
  const filter = resolveLogFilter(url);
  const logs = await new D1LogStore(required.db).listByDevice(required.deviceId, limit, filter);
  const safeDeviceId = required.deviceId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const exportedAt = new Date(typeof env.now === 'function' ? env.now() : Date.now()).toISOString();
  return jsonResponse({
    fileName: `cc-logs-${safeDeviceId}-${exportedAt.replace(/[:.]/g, '-')}.json`,
    exportedAt,
    deviceId: required.deviceId,
    filter,
    count: logs.length,
    logs,
  });
}

export async function handleLogSettings(request: Request, env: WorkerEnv): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['logs:read']);
  if (auth instanceof Response) return auth;
  return jsonResponse(new D1LogStore(auth.db).getRetentionSettings());
}

export async function handleTelemetry(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['logs:read']);
  if (auth instanceof Response) return auth;
  const db = auth.db;
  const deviceId = url.searchParams.get('deviceId')?.trim() || undefined;
  if (deviceId && !(await new D1DeviceStore(db).getDevice(deviceId))) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  const filter = {
    ...resolveLogFilter(url),
    deviceId,
    fromTs: url.searchParams.get('fromTs')?.trim() || undefined,
    toTs: url.searchParams.get('toTs')?.trim() || undefined,
  };
  const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000);
  const logStore = new D1LogStore(db);
  const events = await logStore.listAll(limit, filter);
  const stats = await logStore.getTelemetryTypeStats(filter);
  return jsonResponse({ events, stats, filter, count: events.length });
}

export async function handleTelemetryStream(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'), ['logs:read']);
  if (required instanceof Response) return required;
  const store = new D1LogStore(required.db);
  const limit = clampNumber(url.searchParams.get('limit'), 100, 1, 500);
  const filter = resolveLogFilter(url);
  const events = await store.listByDevice(required.deviceId, limit, filter);
  const seen = new BoundedSeenIds(limit);
  seen.rememberFresh(events.map((event) => event.id));
  return sseStreamResponse([], {
    intervalMs: streamPollMs(env),
    next: async () => {
      const current = await store.listByDevice(required.deviceId, limit, filter);
      const freshIds = new Set(seen.rememberFresh(current.map((event) => event.id)));
      const fresh = current.filter((event) => freshIds.has(event.id));
      return fresh.map((event) => sseFrame('telemetry', event));
    },
  });
}

export async function handleIngestLogs(request: Request, env: WorkerEnv): Promise<Response> {
  const auth = await authenticateAgentRequest(request, env);
  if (auth instanceof Response) return auth;
  const now = typeof env.now === 'function' ? env.now : () => Date.now();
  const rateLimits = new D1RateLimitStore(auth.db, { now });
  await rateLimits.initialize();
  const clientId = getClientId(request);
  const limit = await rateLimits.checkDetailed(`ingest:${auth.device.id}:${clientId}`, 600, 60 * 1000);
  if (limit.ok === false) {
    const retryAfterMs = limit.retryAfterMs;
    return jsonResponse(
      { type: 'nack', payload: { code: 'rate_limited', rate_limited: true, retryAfterMs } },
      { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } },
    );
  }
  let body: LogIngestBody;
  try {
    const text = await decompressGzipBody(request);
    const parsed = JSON.parse(text);
    body = parsed && typeof parsed === 'object' ? parsed : {};
  } catch { body = {}; }
  const incoming = normalizeIngestEvents(body);
  if (!incoming.length) return jsonResponse({ error: 'events payload is required' }, { status: 400 });
  const nowIso = new Date(now()).toISOString();
  const logStore = new D1LogStore(auth.db);
  let lastSeq: number | null = null;
  for (let i = 0; i < incoming.length; i++) {
    const event = incoming[i];
    const seq = typeof event.seq === 'number' ? event.seq : now() + i;
    await logStore.append({
      id: makeUuid(env), deviceId: auth.device.id,
      type: event.type ?? 'unknown', sessionId: event.sessionId ?? null,
      functionId: event.functionId ?? null, seq,
      ts: event.ts || nowIso, payload: event.payload ?? null,
    });
    lastSeq = seq;
  }
  return jsonResponse({ accepted: incoming.length, deviceId: auth.device.id, lastSeq });
}

export async function handleListPtySessions(request: Request, env: WorkerEnv, deviceId: string, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, deviceId, ['device:read']);
  if (required instanceof Response) return required;
  const limit = clampNumber(url.searchParams.get('limit'), 50, 1, 500);
  const ptyStore = new D1PtySessionStore(required.db);
  const now = new Date(nowMs(env)).toISOString();
  await ptyStore.expireOpeningSessions(now, required.deviceId);
  const sessions = (await ptyStore.listByDevice(required.deviceId, limit))
    .filter((session) => !(session.state === 'failed' && ['PTY_NOT_FOUND', 'PTY_SESSION_NOT_FOUND'].includes(session.failureCode ?? '')))
    .filter((session) => !(session.state === 'expired' && session.failureCode === 'PTY_OPEN_TIMEOUT'));
  const commands = new D1CommandStore(required.db);
  const items = await Promise.all(sessions.map(async (session) => {
    const command = await commands.getCommand(session.sessionId);
    const payload = command?.payload && typeof command.payload === 'object' ? command.payload as Record<string, unknown> : {};
    const serverIdFromCommand = ['start_server_ssh', 'request_attach_server_ssh'].includes(command?.commandType ?? '') && typeof payload.serverId === 'string' && payload.serverId.trim()
      ? payload.serverId.trim()
      : null;
    const rowServerId = session.serverId && session.serverId.trim() ? session.serverId.trim() : null;
    const serverId = rowServerId ?? serverIdFromCommand;
    return serverId ? { ...session, serverId } : session;
  }));
  return jsonResponse({ items });
}

export async function handleTunnelLogs(request: Request, env: WorkerEnv, deviceId: string, serverId: string, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, deviceId, ['logs:read']);
  if (required instanceof Response) return required;
  const resolvedServerId = serverId.trim();
  if (!resolvedServerId) return jsonResponse({ error: 'serverId is required' }, { status: 400 });
  const store = new D1LogStore(required.db);
  const limit = clampNumber(url.searchParams.get('limit'), 200, 1, 5000);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const functionId = `server-tunnel-${resolvedServerId}`;
  const sessionId = await store.getLastSessionIdForFunction(required.deviceId, functionId);
  if (!sessionId) return jsonResponse({ entries: [], total: 0 });
  const logs = await store.listPtyOutputBySession(required.deviceId, sessionId, limit, offset);
  const total = await store.countPtyOutputBySession(required.deviceId, sessionId);
  return jsonResponse({
    entries: logs.map((entry) => {
      const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload as Record<string, unknown> : {};
      return { ts: entry.ts, sessionId: entry.sessionId ?? null, data: typeof payload.data === 'string' ? payload.data : '' };
    }),
    total,
  });
}
