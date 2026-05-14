import { HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PtyController } from './pty.controller';

describe('PtyController server SSH terminal', () => {
  it('maps an agent NACK to a conflict response with the agent error details', async () => {
    const deviceStore = { getDevice: vi.fn(() => ({ id: 'dev-1' })) } as any;
    const agentGateway = {
      requestStartServerSsh: vi.fn((_deviceId: string, input: { serverId: string; sessionId: string }) => ({
        ok: true,
        deviceId: 'dev-1',
        serverId: input.serverId,
        sessionId: input.sessionId,
        reqSeq: 7,
      })),
      awaitReqResponse: vi.fn(async () => {
        throw {
          code: 'PTY_SPAWN_ERROR',
          payload: { error: 'PTY_SPAWN_ERROR', message: 'Boundary tunnel is not running for this server.' },
          ts: '2026-04-24T00:00:00.000Z',
        };
      }),
    } as any;
    const ptySessions = {
      expireDetachedSessions: vi.fn(() => []),
      pruneTerminalSessions: vi.fn(() => []),
    } as any;
    const ptyHub = { clearScrollback: vi.fn() } as any;
    const ptyAudit = {} as any;
    const adminSessions = { isValid: vi.fn(() => true) } as any;
    const adminApiTokens = { authenticateToken: vi.fn(() => null) } as any;
    const logStore = { listPtyOutputBySession: vi.fn(() => []) } as any;
    const controller = new PtyController(
      deviceStore,
      agentGateway,
      ptySessions,
      ptyHub,
      ptyAudit,
      adminSessions,
      adminApiTokens,
      logStore,
    );

    let caught: unknown;
    try {
      await controller.requestStartServerSsh(
        'dev-1',
        'srv-1',
        120,
        32,
        'csrf-123',
        undefined,
        'cc_admin_session=session; cc_admin_csrf=csrf-123',
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpException);
    const exception = caught as HttpException;
    expect(exception.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(exception.getResponse()).toMatchObject({
      ok: false,
      code: 'PTY_SPAWN_ERROR',
      message: 'Boundary tunnel is not running for this server.',
      agentError: { error: 'PTY_SPAWN_ERROR', message: 'Boundary tunnel is not running for this server.' },
    });
  });

  it('adopts an existing local SSH PTY and seeds remote scrollback from local history', async () => {
    const canonicalSessionId = 'ccpty:dev-1:local-ssh-session-1';
    const deviceStore = { getDevice: vi.fn(() => ({ id: 'dev-1' })) } as any;
    const agentGateway = {
      requestAttachServerSsh: vi.fn((_deviceId: string, input: { serverId: string; sessionId: string }) => ({
        ok: true,
        deviceId: 'dev-1',
        serverId: input.serverId,
        sessionId: input.sessionId,
        reqSeq: 9,
      })),
      awaitReqResponse: vi.fn(async () => ({
        ok: true,
        payload: { status: 'ok', sessionId: canonicalSessionId, localSessionId: 'local-ssh-session-1' },
        ts: '2026-04-24T00:00:00.000Z',
      })),
    } as any;
    const ptySessions = {
      expireDetachedSessions: vi.fn(() => []),
      pruneTerminalSessions: vi.fn(() => []),
    } as any;
    const ptyHub = { appendOutput: vi.fn(), clearScrollback: vi.fn() } as any;
    const ptyAudit = {} as any;
    const adminSessions = { isValid: vi.fn(() => true) } as any;
    const adminApiTokens = { authenticateToken: vi.fn(() => null) } as any;
    const logStore = {
      listPtyOutputBySession: vi.fn(() => [
        { payload: { data: 'previous prompt$ ' } },
        { payload: { data: 'uptime\r\n' } },
      ]),
    } as any;
    const controller = new PtyController(
      deviceStore,
      agentGateway,
      ptySessions,
      ptyHub,
      ptyAudit,
      adminSessions,
      adminApiTokens,
      logStore,
    );

    const result = await controller.requestAttachServerSsh(
      'dev-1',
      'srv-1',
      'local-ssh-session-1',
      undefined,
      120,
      32,
      'csrf-123',
      undefined,
      'cc_admin_session=session; cc_admin_csrf=csrf-123',
    );

    expect(agentGateway.requestAttachServerSsh).toHaveBeenCalledWith('dev-1', expect.objectContaining({
      serverId: 'srv-1',
      sessionId: canonicalSessionId,
      localSessionId: 'local-ssh-session-1',
      cols: 120,
      rows: 32,
    }));
    expect(agentGateway.awaitReqResponse).toHaveBeenCalledWith('dev-1', 9);
    expect(logStore.listPtyOutputBySession).toHaveBeenCalledWith('dev-1', 'local-ssh-session-1', 200);
    expect(ptyHub.appendOutput).toHaveBeenCalledWith(canonicalSessionId, 'previous prompt$ ');
    expect(ptyHub.appendOutput).toHaveBeenCalledWith(canonicalSessionId, 'uptime\r\n');
    expect(result).toMatchObject({
      ok: true,
      sessionId: canonicalSessionId,
      agentAck: { localSessionId: 'local-ssh-session-1' },
    });
  });

  it('waits for the agent ACK before returning the SSH PTY session', async () => {
    const deviceStore = { getDevice: vi.fn(() => ({ id: 'dev-1' })) } as any;
    const agentGateway = {
      requestStartServerSsh: vi.fn((_deviceId: string, input: { serverId: string; sessionId: string }) => ({
        ok: true,
        deviceId: 'dev-1',
        serverId: input.serverId,
        sessionId: input.sessionId,
        reqSeq: 7,
      })),
      awaitReqResponse: vi.fn(async (_deviceId: string) => {
        const input = agentGateway.requestStartServerSsh.mock.calls[0]?.[1] as { sessionId: string } | undefined;
        const sessionId = input?.sessionId ?? 'missing-session';
        return { ok: true, payload: { status: 'ok', sessionId }, ts: '2026-04-24T00:00:00.000Z' };
      }),
    } as any;
    const ptySessions = {
      expireDetachedSessions: vi.fn(() => []),
      pruneTerminalSessions: vi.fn(() => []),
    } as any;
    const ptyHub = { clearScrollback: vi.fn() } as any;
    const ptyAudit = {} as any;
    const adminSessions = { isValid: vi.fn(() => true) } as any;
    const adminApiTokens = { authenticateToken: vi.fn(() => null) } as any;
    const logStore = { listPtyOutputBySession: vi.fn(() => []) } as any;
    const controller = new PtyController(
      deviceStore,
      agentGateway,
      ptySessions,
      ptyHub,
      ptyAudit,
      adminSessions,
      adminApiTokens,
      logStore,
    );

    const result = await controller.requestStartServerSsh(
      'dev-1',
      'srv-1',
      120,
      32,
      'csrf-123',
      undefined,
      'cc_admin_session=session; cc_admin_csrf=csrf-123',
    );

    expect(agentGateway.requestStartServerSsh).toHaveBeenCalledWith('dev-1', expect.objectContaining({
      serverId: 'srv-1',
      sessionId: expect.stringMatching(/^ccpty:dev-1:/),
      cols: 120,
      rows: 32,
    }));
    expect(agentGateway.awaitReqResponse).toHaveBeenCalledWith('dev-1', 7);
    expect(result.sessionId).toMatch(/^ccpty:dev-1:/);
    expect(result).toMatchObject({
      ok: true,
      agentAck: { status: 'ok', sessionId: result.sessionId },
    });
  });
});
