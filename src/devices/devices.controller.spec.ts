import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesController } from './devices.controller';

function makeStatusChangeStream() {
  return new Subject<{ deviceId: string; status: string; lastSeenAt: string }>();
}

describe('DevicesController tunnel actions', () => {
  const deviceStore = {} as any;
  const rateLimitService = {} as any;
  const adminSessions = {
    isValid: vi.fn(() => true),
  } as any;
  const adminApiTokens = {
    authenticateToken: vi.fn(() => null),
  } as any;
  const commandDispatch = {
    dispatchGenericCommand: vi.fn(() => ({ ok: true })),
  } as any;

  let controller: DevicesController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new DevicesController(
      deviceStore,
      rateLimitService,
      adminSessions,
      adminApiTokens,
      commandDispatch,
    );
  });

  it('dispatches start_server_tunnel for authorized requests', () => {
    controller.requestStartServerTunnel(
      'dev-1',
      'srv-1',
      undefined,
      'csrf-123',
      undefined,
      'cc_admin_session=session; cc_admin_csrf=csrf-123',
    );

    expect(commandDispatch.dispatchGenericCommand).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'dev-1',
      commandType: 'start_server_tunnel',
      payload: { serverId: 'srv-1' },
    }));
  });

  it('dispatches stop_server_tunnel for authorized requests', () => {
    controller.requestStopServerTunnel(
      'dev-1',
      'srv-1',
      undefined,
      'csrf-123',
      undefined,
      'cc_admin_session=session; cc_admin_csrf=csrf-123',
    );

    expect(commandDispatch.dispatchGenericCommand).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'dev-1',
      commandType: 'stop_server_tunnel',
      payload: { serverId: 'srv-1' },
    }));
  });
});

describe('DevicesController stream endpoint', () => {
  it('returns an Observable that emits device-connected events from the status change stream', async () => {
    const statusStream = makeStatusChangeStream();
    const deviceStore = {
      statusChangeStream: vi.fn(() => statusStream.asObservable()),
      getAllDevices: vi.fn(() => []),
    } as any;
    const adminSessions = { isValid: vi.fn(() => true) } as any;
    const adminApiTokens = { authenticateToken: vi.fn(() => null) } as any;

    const controller = new DevicesController(
      deviceStore,
      {} as any,
      adminSessions,
      adminApiTokens,
      {} as any,
    );

    const observable = controller.streamDevices(undefined, 'cc_admin_session=sess; cc_admin_csrf=csrf');

    const emitted: unknown[] = [];
    const sub = observable.subscribe((event) => emitted.push(event));

    statusStream.next({ deviceId: 'dev-1', status: 'connected', lastSeenAt: new Date().toISOString() });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(emitted.length).toBeGreaterThanOrEqual(1);
    const lastEvent = emitted[emitted.length - 1] as { type: string; data: string };
    expect(lastEvent.type).toBe('device-connected');
    const parsedData = JSON.parse(lastEvent.data);
    expect(parsedData.deviceId).toBe('dev-1');
    expect(parsedData.status).toBe('connected');

    sub.unsubscribe();
  });

  it('returns an Observable that emits device-disconnected events from the status change stream', async () => {
    const statusStream = makeStatusChangeStream();
    const deviceStore = {
      statusChangeStream: vi.fn(() => statusStream.asObservable()),
      getAllDevices: vi.fn(() => []),
    } as any;
    const adminSessions = { isValid: vi.fn(() => true) } as any;
    const adminApiTokens = { authenticateToken: vi.fn(() => null) } as any;

    const controller = new DevicesController(
      deviceStore,
      {} as any,
      adminSessions,
      adminApiTokens,
      {} as any,
    );

    const observable = controller.streamDevices(undefined, 'cc_admin_session=sess; cc_admin_csrf=csrf');

    const emitted: unknown[] = [];
    const sub = observable.subscribe((event) => emitted.push(event));

    statusStream.next({ deviceId: 'dev-2', status: 'disconnected', lastSeenAt: new Date().toISOString() });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(emitted.length).toBeGreaterThanOrEqual(1);
    const lastEvent = emitted[emitted.length - 1] as { type: string; data: string };
    expect(lastEvent.type).toBe('device-disconnected');

    sub.unsubscribe();
  });
});
