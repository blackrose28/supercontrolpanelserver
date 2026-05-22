import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AgentGateway } from './agent.gateway';

describe('AgentGateway request methods', () => {
  const ws = { send: vi.fn() };
  const deviceStore = {
    getSessionByDeviceId: vi.fn(),
    findDeviceByAgentToken: vi.fn(),
    addSession: vi.fn(),
    removeSession: vi.fn(),
    updateDeviceStatus: vi.fn(),
    updateDeviceOs: vi.fn(),
  } as any;
  const logStore = { append: vi.fn() } as any;
  const commandStore = {
    findByReqSeq: vi.fn(),
    getCommand: vi.fn(),
    findPendingCommand: vi.fn(),
    markFailed: vi.fn(),
    appendAuditIfMissing: vi.fn(),
    hasAuditEvent: vi.fn(),
    markExecuting: vi.fn(),
    markSucceeded: vi.fn(),
  } as any;
  const ptySessionStore = {
    createOpening: vi.fn(),
    trackPendingReq: vi.fn(),
    markClosing: vi.fn(),
    consumePendingReq: vi.fn(),
    markOpen: vi.fn(),
    markOpenFailed: vi.fn(),
    markClosed: vi.fn(),
    noteOutput: vi.fn(),
    expireDeviceSessions: vi.fn(() => []),
  } as any;
  const ptyHub = { appendOutput: vi.fn(), broadcast: vi.fn() } as any;
  const ptyAudit = { append: vi.fn() } as any;
  const fileTransferStore = { get: vi.fn(), updateProgress: vi.fn(), markState: vi.fn() } as any;

  let gateway: AgentGateway;

  beforeEach(() => {
    vi.clearAllMocks();
    gateway = new AgentGateway(
      deviceStore,
      logStore,
      commandStore,
      ptySessionStore,
      ptyHub,
      ptyAudit,
      fileTransferStore,
    );
  });

  it('requestStatusSnapshot returns DEVICE_NOT_CONNECTED when missing session', () => {
    deviceStore.getSessionByDeviceId.mockReturnValue(null);

    const result = gateway.requestStatusSnapshot('device-1', 'cmd-1');

    expect(result).toEqual({ ok: false, reason: 'DEVICE_NOT_CONNECTED' });
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('requestStatusSnapshot sends request envelope and returns reqSeq/requestedAt', () => {
    deviceStore.getSessionByDeviceId.mockReturnValue({ ws });

    const result = gateway.requestStatusSnapshot('device-1', 'cmd-1');

    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe('device-1');
    expect(result.reqSeq).toBe(1);
    expect(typeof result.requestedAt).toBe('string');

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sentPayload = JSON.parse(String(ws.send.mock.calls[0][0]));
    expect(sentPayload.type).toBe('request_status_snapshot');
    expect(sentPayload.commandId).toBe('cmd-1');
    expect(sentPayload.payload).toBeNull();
    expect(sentPayload.deviceId).toBe('server');
    expect(sentPayload.seq).toBe(1);
    expect(typeof sentPayload.ts).toBe('string');
  });

  it('dispatchFileOpCommand sends envelope and returns reqSeq/requestedAt', () => {
    deviceStore.getSessionByDeviceId.mockReturnValue({ ws });

    const result = gateway.dispatchFileOpCommand('device-1', 'open_remote_browser', { serverId: 'srv-1' }, 'cmd-9');

    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe('device-1');
    expect(result.reqSeq).toBe(1);
    expect(typeof result.requestedAt).toBe('string');

    const sentPayload = JSON.parse(String(ws.send.mock.calls[0][0]));
    expect(sentPayload.type).toBe('open_remote_browser');
    expect(sentPayload.commandId).toBe('cmd-9');
    expect(sentPayload.payload).toEqual({ serverId: 'srv-1' });
  });

  it('requestStartServerTunnel sends request envelope and server id', () => {
    deviceStore.getSessionByDeviceId.mockReturnValue({ ws });

    const result = gateway.requestStartServerTunnel('device-1', 'srv-1', 'cmd-start');

    expect(result).toMatchObject({
      ok: true,
      deviceId: 'device-1',
      serverId: 'srv-1',
      reqSeq: 1,
    });

    const sentPayload = JSON.parse(String(ws.send.mock.calls[0][0]));
    expect(sentPayload.type).toBe('request_start_server_tunnel');
    expect(sentPayload.commandId).toBe('cmd-start');
    expect(sentPayload.payload).toEqual({ serverId: 'srv-1' });
  });

  it('requestStopServerTunnel sends request envelope and server id', () => {
    deviceStore.getSessionByDeviceId.mockReturnValue({ ws });

    const result = gateway.requestStopServerTunnel('device-1', 'srv-2', 'cmd-stop');

    expect(result).toMatchObject({
      ok: true,
      deviceId: 'device-1',
      serverId: 'srv-2',
      reqSeq: 1,
    });

    const sentPayload = JSON.parse(String(ws.send.mock.calls[0][0]));
    expect(sentPayload.type).toBe('request_stop_server_tunnel');
    expect(sentPayload.commandId).toBe('cmd-stop');
    expect(sentPayload.payload).toEqual({ serverId: 'srv-2' });
  });

  it('requestStartServerSsh creates an attached PTY session and sends SSH start request', () => {
    deviceStore.getSessionByDeviceId.mockReturnValue({ ws });

    const result = gateway.requestStartServerSsh('device-1', {
      serverId: ' srv-ssh ',
      sessionId: 'ccpty:device-1:11111111-1111-4111-8111-111111111111',
      cols: 120,
      rows: 32,
      actorType: 'admin_session',
      actorId: 'admin-1',
    });

    expect(result).toMatchObject({
      ok: true,
      deviceId: 'device-1',
      serverId: 'srv-ssh',
      sessionId: 'ccpty:device-1:11111111-1111-4111-8111-111111111111',
      reqSeq: 1,
    });
    expect(ptySessionStore.createOpening).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ccpty:device-1:11111111-1111-4111-8111-111111111111',
      deviceId: 'device-1',
      cols: 120,
      rows: 32,
      recordingEnabled: false,
      openedByActorType: 'admin_session',
      openedByActorId: 'admin-1',
      attachedActorType: 'admin_session',
      attachedActorId: 'admin-1',
    }));
    expect(ptySessionStore.trackPendingReq).toHaveBeenCalledWith('device-1', 1, 'ccpty:device-1:11111111-1111-4111-8111-111111111111', 'open');

    const sentPayload = JSON.parse(String(ws.send.mock.calls[0][0]));
    expect(sentPayload.type).toBe('request_start_server_ssh');
    expect(sentPayload.payload).toEqual({
      serverId: 'srv-ssh',
      sessionId: 'ccpty:device-1:11111111-1111-4111-8111-111111111111',
      cols: 120,
      rows: 32,
    });
  });

  it('requestAttachServerSsh creates an attached remote PTY session and sends local adoption request', () => {
    deviceStore.getSessionByDeviceId.mockReturnValue({ ws });

    const canonicalAttach = 'ccpty:device-1:11111111-1111-4111-8111-111111111111';
    const result = gateway.requestAttachServerSsh('device-1', {
      serverId: ' srv-ssh ',
      sessionId: canonicalAttach,
      localSessionId: ' 11111111-1111-4111-8111-111111111111 ',
      cols: 120,
      rows: 32,
      actorType: 'admin_session',
      actorId: 'admin-1',
    });

    expect(result).toMatchObject({
      ok: true,
      deviceId: 'device-1',
      serverId: 'srv-ssh',
      sessionId: canonicalAttach,
      reqSeq: 1,
    });
    expect(ptySessionStore.createOpening).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: canonicalAttach,
      deviceId: 'device-1',
      cols: 120,
      rows: 32,
      recordingEnabled: false,
      openedByActorType: 'admin_session',
      openedByActorId: 'admin-1',
      attachedActorType: 'admin_session',
      attachedActorId: 'admin-1',
    }));
    expect(ptySessionStore.trackPendingReq).toHaveBeenCalledWith('device-1', 1, canonicalAttach, 'open');

    const sentPayload = JSON.parse(String(ws.send.mock.calls[0][0]));
    expect(sentPayload.type).toBe('request_attach_server_ssh');
    expect(sentPayload.payload).toEqual({
      serverId: 'srv-ssh',
      sessionId: canonicalAttach,
      localSessionId: '11111111-1111-4111-8111-111111111111',
      cols: 120,
      rows: 32,
    });
  });

  it('openPty tracks pending open request and creates opening session', () => {
    deviceStore.getSessionByDeviceId.mockReturnValue({ ws });

    const result = gateway.openPty(
      'device-1',
      {
        sessionId: 'pty-1',
        cols: 120,
        rows: 40,
        recording: true,
        actorType: 'admin_session',
        actorId: null,
      },
      'cmd-open',
    );

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe('pty-1');
    expect(result.reqSeq).toBe(1);
    expect(ptySessionStore.createOpening).toHaveBeenCalledTimes(1);
    expect(ptySessionStore.createOpening.mock.calls[0][0]).toMatchObject({
      sessionId: 'pty-1',
      deviceId: 'device-1',
      cols: 120,
      rows: 40,
      recordingEnabled: true,
      openedByActorType: 'admin_session',
      openedByActorId: null,
      attachedActorType: 'admin_session',
      attachedActorId: null,
    });
    expect(ptySessionStore.trackPendingReq).toHaveBeenCalledWith('device-1', 1, 'pty-1', 'open');

    const sentPayload = JSON.parse(String(ws.send.mock.calls[0][0]));
    expect(sentPayload.type).toBe('open_pty');
    expect(sentPayload.payload).toEqual({
      sessionId: 'pty-1',
      cols: 120,
      rows: 40,
      recording: true,
    });
  });

  it('handleAck resolves pending req response', async () => {
    const pending = gateway.awaitReqResponse('device-1', 42, 1000);

    (gateway as any).handleAck(
      { reqSeq: 42, payload: { ok: 1 }, ts: '2026-01-01T00:00:00.000Z' },
      { deviceId: 'device-1' },
    );

    await expect(pending).resolves.toEqual({
      ok: true,
      payload: { ok: 1 },
      ts: '2026-01-01T00:00:00.000Z',
    });
  });

  it('awaitReqResponse resolves when ack arrived before waiter registration', async () => {
    (gateway as any).handleAck(
      { reqSeq: 43, payload: { ok: 1 }, ts: '2026-01-01T00:00:00.000Z' },
      { deviceId: 'device-1' },
    );

    await expect(gateway.awaitReqResponse('device-1', 43, 1000)).resolves.toEqual({
      ok: true,
      payload: { ok: 1 },
      ts: '2026-01-01T00:00:00.000Z',
    });
  });

  it('handleTransferStatus updates transfer state and sends ack', () => {
    fileTransferStore.get.mockReturnValue({
      transferId: 't1',
      deviceId: 'device-1',
      state: 'running',
      phase: null,
      reasonCode: null,
      reasonDetail: null,
      message: null,
      attempt: 1,
      maxAttempts: 3,
      resumeSupported: true,
      retryScheduled: false,
      resumeToken: null,
      resumeOffsetBytes: null,
      tempPathHint: null,
    });

    (gateway as any).handleTransferStatus(
      {
        seq: 9,
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          transferId: 't1',
          state: 'failed',
          reasonCode: 'ERR',
          reasonDetail: 'broken',
        },
      },
      { deviceId: 'device-1', send: ws.send },
    );

    expect(fileTransferStore.markState).toHaveBeenCalledTimes(1);
    expect(fileTransferStore.markState.mock.calls[0][0]).toBe('t1');
    expect(fileTransferStore.markState.mock.calls[0][1]).toBe('failed');

    const lastSent = JSON.parse(String(ws.send.mock.calls[ws.send.mock.calls.length - 1][0]));
    expect(lastSent.type).toBe('ack');
    expect(lastSent.reqSeq).toBe(9);
  });

  it('handleTransferProgress updates progress and sends ack', () => {
    fileTransferStore.get.mockReturnValue({
      transferId: 't2',
      deviceId: 'device-1',
      state: 'running',
      reasonCode: null,
      attempt: 1,
      maxAttempts: 3,
      resumeSupported: true,
      retryScheduled: false,
      resumeToken: null,
      resumeOffsetBytes: null,
      tempPathHint: null,
      bytesTransferred: 10,
      bytesTotal: 100,
      percent: 10,
      throughputBps: 50,
      etaSec: 20,
      phase: null,
      message: null,
    });

    (gateway as any).handleTransferProgress(
      {
        seq: 11,
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          transferId: 't2',
          bytesTransferred: 20,
          percent: 20,
          message: 'copying',
        },
      },
      { deviceId: 'device-1', send: ws.send },
    );

    expect(fileTransferStore.updateProgress).toHaveBeenCalledTimes(1);
    expect(fileTransferStore.updateProgress.mock.calls[0][0]).toBe('t2');

    const lastSent = JSON.parse(String(ws.send.mock.calls[ws.send.mock.calls.length - 1][0]));
    expect(lastSent.type).toBe('ack');
    expect(lastSent.reqSeq).toBe(11);
  });


  it('handleTransferStatus fills transferred bytes from total when transfer succeeds', () => {
    fileTransferStore.get.mockReturnValue({
      transferId: 't-success',
      deviceId: 'device-1',
      state: 'running',
      phase: 'transfer',
      reasonCode: null,
      reasonDetail: null,
      message: null,
      attempt: 1,
      maxAttempts: 3,
      resumeSupported: false,
      retryScheduled: false,
      resumeToken: null,
      resumeOffsetBytes: null,
      tempPathHint: null,
      bytesTransferred: 0,
      bytesTotal: 86682104,
      percent: null,
      throughputBps: null,
      etaSec: null,
    });

    (gateway as any).handleTransferStatus(
      {
        seq: 12,
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          transferId: 't-success',
          state: 'succeeded',
          phase: 'finalize',
        },
      },
      { deviceId: 'device-1', send: ws.send },
    );

    expect(fileTransferStore.updateProgress).toHaveBeenCalledWith(
      't-success',
      '2026-01-01T00:00:00.000Z',
      expect.objectContaining({
        bytesTransferred: 86682104,
        bytesTotal: 86682104,
        percent: 100,
        phase: 'finalize',
      }),
    );
    expect(fileTransferStore.markState).toHaveBeenCalledWith(
      't-success',
      'succeeded',
      '2026-01-01T00:00:00.000Z',
      expect.any(Object),
    );
  });

  it('handleCommandStatus marks command succeeded and appends audit', () => {
    commandStore.getCommand.mockReturnValue({
      commandId: 'cmd-1',
      deviceId: 'device-1',
      commandType: 'restart_openvpn',
      state: 'executing',
    });

    (gateway as any).handleCommandStatus(
      {
        commandId: 'cmd-1',
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          state: 'succeeded',
          outcome: 'ok',
        },
      },
      { deviceId: 'device-1' },
    );

    expect(commandStore.markSucceeded).toHaveBeenCalledWith('cmd-1', 'ok', '2026-01-01T00:00:00.000Z');
    expect(commandStore.appendAuditIfMissing).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'cmd-1',
        eventType: 'succeeded',
        source: 'agent',
      }),
    );
  });

  it('handleFunctionStatus logs event, sends ack, and advances restart progression', () => {
    const advanceRestart = vi.spyOn(gateway as any, 'advanceRestartCommandFromFunctionStatus');

    (gateway as any).handleFunctionStatus(
      {
        seq: 13,
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          functionId: 'openvpn-connect',
          state: 'running',
          message: 'ok',
        },
      },
      { deviceId: 'device-1', sessionId: 'sess-1', send: ws.send },
    );

    expect(logStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        type: 'function-status',
        functionId: 'openvpn-connect',
      }),
    );

    const lastSent = JSON.parse(String(ws.send.mock.calls[ws.send.mock.calls.length - 1][0]));
    expect(lastSent.type).toBe('ack');
    expect(lastSent.reqSeq).toBe(13);

    expect(advanceRestart).toHaveBeenCalledWith(
      'device-1',
      '2026-01-01T00:00:00.000Z',
      expect.objectContaining({ functionId: 'openvpn-connect', state: 'running' }),
    );
  });

  it('handlePtyOutput logs output, tracks session output, and broadcasts to hub', () => {
    (gateway as any).handlePtyOutput(
      {
        seq: 21,
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          sessionId: 'pty-1',
          data: 'hello',
        },
      },
      { deviceId: 'device-1', sessionId: 'sess-1' },
    );

    expect(logStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        type: 'pty-output',
        sessionId: 'pty-1',
      }),
    );
    expect(ptySessionStore.noteOutput).toHaveBeenCalledWith('pty-1', '2026-01-01T00:00:00.000Z');
    expect(ptyHub.appendOutput).toHaveBeenCalledWith('pty-1', 'hello');
    expect(ptyHub.broadcast).toHaveBeenCalledWith('pty-1', {
      type: 'pty_output',
      payload: {
        sessionId: 'pty-1',
        data: 'hello',
      },
    });
  });

  it('handlePtyExit logs exit, closes session, audits, and broadcasts', () => {
    ptySessionStore.markClosed.mockReturnValue({
      sessionId: 'pty-1',
      deviceId: 'device-1',
      closedAt: '2026-01-01T00:00:00.000Z',
    });

    (gateway as any).handlePtyExit(
      {
        seq: 22,
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          sessionId: 'pty-1',
          reason: 'done',
          exitCode: 0,
        },
      },
      { deviceId: 'device-1', sessionId: 'sess-1' },
    );

    expect(logStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        type: 'pty-exit',
        sessionId: 'pty-1',
      }),
    );
    expect(ptySessionStore.markClosed).toHaveBeenCalledWith('pty-1', '2026-01-01T00:00:00.000Z', 'done');
    expect(ptyAudit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'pty-1',
        deviceId: 'device-1',
        eventType: 'pty_closed',
      }),
    );
    expect(ptyHub.broadcast).toHaveBeenCalledWith('pty-1', {
      type: 'pty_exit',
      payload: {
        sessionId: 'pty-1',
        reason: 'done',
        exitCode: 0,
      },
    });
  });

  it('handleRecentLogs logs payload, sends ack, and completes refresh command', () => {
    const completeRefresh = vi.spyOn(gateway as any, 'completeRefreshCommand');

    (gateway as any).handleRecentLogs(
      {
        seq: 30,
        ts: '2026-01-01T00:00:00.000Z',
        payload: { logs: [{ ts: 'x', msg: 'hello' }] },
      },
      { deviceId: 'device-1', sessionId: 'sess-1', send: ws.send },
    );

    expect(logStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        type: 'recent_logs',
        sessionId: 'sess-1',
      }),
    );

    const lastSent = JSON.parse(String(ws.send.mock.calls[ws.send.mock.calls.length - 1][0]));
    expect(lastSent.type).toBe('ack');
    expect(lastSent.reqSeq).toBe(30);

    expect(completeRefresh).toHaveBeenCalledWith(
      'device-1',
      'request_recent_logs',
      '2026-01-01T00:00:00.000Z',
      'recent logs received',
    );
  });

  it('handleRecentLogs expands individual events from recent_logs payload', () => {
    (gateway as any).handleRecentLogs(
      {
        seq: 40,
        ts: '2026-01-01T00:00:00.000Z',
        payload: {
          count: 2,
          events: [
            {
              type: 'function-status',
              sessionId: 'pty-recent-1',
              functionId: 'server-tunnel-srv-expand-test',
              seq: 100,
              ts: '2026-01-01T00:00:01.000Z',
              payload: {
                functionId: 'server-tunnel-srv-expand-test',
                state: 'running',
                message: 'Tunnel active',
                sessionId: 'pty-recent-1',
                updatedAtMs: 1700000000000,
              },
            },
            {
              type: 'pty-output',
              sessionId: 'pty-recent-1',
              functionId: null,
              seq: 101,
              ts: '2026-01-01T00:00:02.000Z',
              payload: { id: 'pty-recent-1', data: 'recent tunnel output\r\n' },
            },
          ],
        },
      },
      { deviceId: 'device-1', sessionId: 'sess-1', send: ws.send },
    );

    // Should have the original recent_logs append + 2 expanded events
    const appendCalls = logStore.append.mock.calls;
    const expandedCalls = appendCalls.filter(
      (call: any[]) => call[0].type === 'function-status' || call[0].type === 'pty-output',
    );
    expect(expandedCalls.length).toBe(2);

    const fsCall = expandedCalls.find((c: any[]) => c[0].type === 'function-status');
    expect(fsCall[0].functionId).toBe('server-tunnel-srv-expand-test');
    expect(fsCall[0].sessionId).toBe('pty-recent-1');
    expect(fsCall[0].payload).toEqual(
      expect.objectContaining({
        functionId: 'server-tunnel-srv-expand-test',
        state: 'running',
        sessionId: 'pty-recent-1',
      }),
    );

    const ptyCall = expandedCalls.find((c: any[]) => c[0].type === 'pty-output');
    expect(ptyCall[0].sessionId).toBe('pty-recent-1');
    expect(ptyCall[0].payload).toEqual(
      expect.objectContaining({
        id: 'pty-recent-1',
        data: 'recent tunnel output\r\n',
      }),
    );
  });

  it('handleInventory logs payload, sends ack, and completes refresh command', () => {
    const completeRefresh = vi.spyOn(gateway as any, 'completeRefreshCommand');

    (gateway as any).handleInventory(
      {
        seq: 31,
        ts: '2026-01-01T00:00:00.000Z',
        payload: { servers: [{ id: 'srv-1' }] },
      },
      { deviceId: 'device-1', sessionId: 'sess-1', send: ws.send },
    );

    expect(logStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        type: 'inventory',
        sessionId: 'sess-1',
      }),
    );

    const lastSent = JSON.parse(String(ws.send.mock.calls[ws.send.mock.calls.length - 1][0]));
    expect(lastSent.type).toBe('ack');
    expect(lastSent.reqSeq).toBe(31);

    expect(completeRefresh).toHaveBeenCalledWith(
      'device-1',
      'request_inventory',
      '2026-01-01T00:00:00.000Z',
      'inventory received',
    );
  });

  it('handleStatusSnapshot logs payload, sends ack, and completes refresh command', () => {
    const completeRefresh = vi.spyOn(gateway as any, 'completeRefreshCommand');

    (gateway as any).handleStatusSnapshot(
      {
        seq: 32,
        ts: '2026-01-01T00:00:00.000Z',
        payload: { status: 'ok' },
      },
      { deviceId: 'device-1', sessionId: 'sess-1', send: ws.send },
    );

    expect(logStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        type: 'status_snapshot',
        sessionId: 'sess-1',
      }),
    );

    const lastSent = JSON.parse(String(ws.send.mock.calls[ws.send.mock.calls.length - 1][0]));
    expect(lastSent.type).toBe('ack');
    expect(lastSent.reqSeq).toBe(32);

    expect(completeRefresh).toHaveBeenCalledWith(
      'device-1',
      'request_status_snapshot',
      '2026-01-01T00:00:00.000Z',
      'status snapshot received',
    );
  });

  it('handleHeartbeat updates status/os and sends ack', () => {
    (gateway as any).handleHeartbeat(
      {
        seq: 33,
        payload: { os: 'linux' },
      },
      { deviceId: 'device-1', send: ws.send },
    );

    expect(deviceStore.updateDeviceStatus).toHaveBeenCalledWith('device-1', 'connected');
    expect(deviceStore.updateDeviceOs).toHaveBeenCalledWith('device-1', 'linux');

    const lastSent = JSON.parse(String(ws.send.mock.calls[ws.send.mock.calls.length - 1][0]));
    expect(lastSent.type).toBe('ack');
    expect(lastSent.reqSeq).toBe(33);
  });

  it('handleNack rejects pending response with payload error code', async () => {
    const pending = gateway.awaitReqResponse('device-1', 77, 1000);

    (gateway as any).handleNack(
      {
        reqSeq: 77,
        ts: '2026-01-01T00:00:00.000Z',
        payload: { error: 'DENIED' },
      },
      { deviceId: 'device-1' },
    );

    await expect(pending).rejects.toEqual({
      code: 'DENIED',
      payload: { error: 'DENIED' },
      ts: '2026-01-01T00:00:00.000Z',
    });
  });

  it('awaitReqResponse rejects when nack arrived before waiter registration', async () => {
    (gateway as any).handleNack(
      {
        reqSeq: 78,
        ts: '2026-01-01T00:00:00.000Z',
        payload: { error: 'DENIED' },
      },
      { deviceId: 'device-1' },
    );

    await expect(gateway.awaitReqResponse('device-1', 78, 1000)).rejects.toEqual({
      code: 'DENIED',
      payload: { error: 'DENIED' },
      ts: '2026-01-01T00:00:00.000Z',
    });
  });

  it('handleRawMessage routes ack envelopes to handleAck', () => {
    const handleAckSpy = vi.spyOn(gateway as any, 'handleAck');

    (gateway as any).handleRawMessage(
      JSON.stringify({ type: 'ack', reqSeq: 1, seq: 9, payload: { status: 'ok' } }),
      { deviceId: 'device-1' },
    );

    expect(handleAckSpy).toHaveBeenCalledTimes(1);
    expect(handleAckSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ack', reqSeq: 1 }),
      expect.objectContaining({ deviceId: 'device-1' }),
    );
  });

});
