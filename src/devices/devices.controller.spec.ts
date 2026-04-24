import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesController } from './devices.controller';

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
