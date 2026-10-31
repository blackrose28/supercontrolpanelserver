import { describe, expect, it, vi } from 'vitest';
import { dispatchGenericCommandGroup } from './command-dispatch.generic';

const principal = { kind: 'session', scopes: null } as const;

describe('dispatchGenericCommandGroup', () => {
  it('dispatches start_server_tunnel with required serverId', () => {
    const dispatchSafeCommand = vi.fn(() => ({ ok: true }));
    const requestStartServerTunnel = vi.fn(() => ({ ok: true, reqSeq: 1, requestedAt: '2026-04-23T00:00:00.000Z' }));

    const result = dispatchGenericCommandGroup(
      {
        deviceId: 'dev-1',
        commandType: 'start_server_tunnel',
        payload: { serverId: 'srv-1' },
        principal,
      },
      {
        dispatchSafeCommand,
        agentGateway: {
          requestStartServerTunnel,
        } as any,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(dispatchSafeCommand).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'dev-1',
      commandType: 'start_server_tunnel',
      payload: { serverId: 'srv-1' },
      payloadSummary: 'Start server tunnel for srv-1',
    }));
    expect(dispatchSafeCommand.mock.calls[0][0].dispatch('cmd-1')).toEqual({
      ok: true,
      reqSeq: 1,
      requestedAt: '2026-04-23T00:00:00.000Z',
    });
    expect(requestStartServerTunnel).toHaveBeenCalledWith('dev-1', 'srv-1', 'cmd-1');
  });

  it('dispatches stop_server_tunnel with required serverId', () => {
    const dispatchSafeCommand = vi.fn(() => ({ ok: true }));
    const requestStopServerTunnel = vi.fn(() => ({ ok: true, reqSeq: 2, requestedAt: '2026-04-23T00:00:00.000Z' }));

    const result = dispatchGenericCommandGroup(
      {
        deviceId: 'dev-1',
        commandType: 'stop_server_tunnel',
        payload: { serverId: 'srv-2' },
        principal,
      },
      {
        dispatchSafeCommand,
        agentGateway: {
          requestStopServerTunnel,
        } as any,
      },
    );

    expect(result).toEqual({ ok: true });
    expect(dispatchSafeCommand).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'dev-1',
      commandType: 'stop_server_tunnel',
      payload: { serverId: 'srv-2' },
      payloadSummary: 'Stop server tunnel for srv-2',
    }));
    expect(dispatchSafeCommand.mock.calls[0][0].dispatch('cmd-2')).toEqual({
      ok: true,
      reqSeq: 2,
      requestedAt: '2026-04-23T00:00:00.000Z',
    });
    expect(requestStopServerTunnel).toHaveBeenCalledWith('dev-1', 'srv-2', 'cmd-2');
  });

  it('rejects start_server_tunnel without serverId', () => {
    expect(() =>
      dispatchGenericCommandGroup(
        {
          deviceId: 'dev-1',
          commandType: 'start_server_tunnel',
          payload: {},
          principal,
        },
        {
          dispatchSafeCommand: vi.fn(),
          agentGateway: {} as any,
        },
      ),
    ).toThrow('payload.serverId is required');
  });
});
