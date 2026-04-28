import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCommandAudit,
  fetchCommands,
  fetchDeviceDetails,
  fetchDevices,
  fetchPtySessions,
  buildTelemetryExportUrl,
  fetchRecentLogs,
  fetchRuntimeSummary,
  fetchTelemetry,
  fetchTransfers,
  requestRecentLogs,
  requestAttachServerSshPty,
  requestStartServerSshPty,
  requestStatusSnapshot,
  stopTransfer,
  dismissTransfer,
  forceRemoveTransfer,
  dismissFinishedTransfers,
  resumeTransfer,
  startScpTransfer,
  subscribeTelemetryStream,
  subscribeCommandsStream,
  subscribeTransfersStream,
  subscribeDevicesStream,
} from './adminApi';

describe('adminApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchDevices returns array payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }],
    }));

    await expect(fetchDevices()).resolves.toEqual([
      { id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null },
    ]);
  });

  it('fetchDevices throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    await expect(fetchDevices()).rejects.toThrow('Failed to load devices');
  });

  it('fetchDevices redirects to /admin/login on unauthorized response', async () => {
    const assign = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));
    Object.defineProperty(window, 'location', {
      value: { assign },
      configurable: true,
    });

    await expect(fetchDevices()).rejects.toThrow('Redirecting to admin login');
    expect(assign).toHaveBeenCalledWith('/admin/login');
  });

  it('fetchDeviceDetails uses expected endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchDeviceDetails('dev-1');

    expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1', { credentials: 'same-origin' });
  });

  it('fetchRuntimeSummary throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    await expect(fetchRuntimeSummary('dev-1')).rejects.toThrow('Failed to load runtime summary');
  });

  it('requestStatusSnapshot posts csrf token to the device endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, command: { commandId: 'cmd-1', commandType: 'request_status_snapshot' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      ...document,
      querySelector: vi.fn().mockReturnValue({ getAttribute: () => 'csrf-123' }),
      cookie: '',
    } as unknown as Document);

    await expect(requestStatusSnapshot('dev-1')).resolves.toEqual({
      ok: true,
      command: { commandId: 'cmd-1', commandType: 'request_status_snapshot' },
    });

    expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/request-status-snapshot', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrfToken: 'csrf-123' }),
    });
  });

  it('requestRecentLogs posts csrf token to the device endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, command: { commandId: 'cmd-2', commandType: 'request_recent_logs' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      ...document,
      querySelector: vi.fn().mockReturnValue({ getAttribute: () => 'csrf-123' }),
      cookie: '',
    } as unknown as Document);

    await expect(requestRecentLogs('dev-1')).resolves.toEqual({
      ok: true,
      command: { commandId: 'cmd-2', commandType: 'request_recent_logs' },
    });

    expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/request-recent-logs', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrfToken: 'csrf-123' }),
    });
  });

  it('fetchPtySessions returns device PTY sessions', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { sessionId: 'server-ssh-srv-1-11111111-1111-4111-8111-111111111111', state: 'open' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPtySessions('dev-1')).resolves.toEqual([
      { sessionId: 'server-ssh-srv-1-11111111-1111-4111-8111-111111111111', state: 'open' },
    ]);

    expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/pty-sessions', {
      credentials: 'same-origin',
    });
  });

  it('requestStartServerSshPty includes server conflict details in errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        code: 'PTY_SPAWN_ERROR',
        message: 'Boundary tunnel is not running for this server.',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      ...document,
      querySelector: vi.fn().mockReturnValue({ getAttribute: () => 'csrf-ssh' }),
      cookie: '',
    } as unknown as Document);

    await expect(requestStartServerSshPty('dev-1', 'srv-1', 100, 30)).rejects.toThrow(
      'Failed to request server SSH terminal: PTY_SPAWN_ERROR - Boundary tunnel is not running for this server.',
    );
  });

  it('requestStartServerSshPty posts server id and terminal size', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        deviceId: 'dev-1',
        serverId: 'srv-1',
        sessionId: 'requested-ssh-sess-1',
        agentAck: { localSessionId: 'local-ssh-sess-1' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      ...document,
      querySelector: vi.fn().mockReturnValue({ getAttribute: () => 'csrf-ssh' }),
      cookie: '',
    } as unknown as Document);

    await expect(requestStartServerSshPty('dev-1', 'srv-1', 100, 30)).resolves.toMatchObject({
      ok: true,
      sessionId: 'requested-ssh-sess-1',
    });

    expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/request-start-server-ssh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrfToken: 'csrf-ssh', serverId: 'srv-1', cols: 100, rows: 30 }),
    });
  });

  it('requestAttachServerSshPty posts local PTY id for adoption', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        deviceId: 'dev-1',
        serverId: 'srv-1',
        sessionId: 'server-ssh-srv-1-11111111-1111-4111-8111-111111111111',
        agentAck: { localSessionId: 'local-ssh-session-1' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      ...document,
      querySelector: vi.fn().mockReturnValue({ getAttribute: () => 'csrf-ssh' }),
      cookie: '',
    } as unknown as Document);

    await expect(requestAttachServerSshPty('dev-1', 'srv-1', 'local-ssh-session-1', 100, 30)).resolves.toMatchObject({
      ok: true,
      sessionId: 'server-ssh-srv-1-11111111-1111-4111-8111-111111111111',
    });

    expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/request-attach-server-ssh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csrfToken: 'csrf-ssh', serverId: 'srv-1', localSessionId: 'local-ssh-session-1', cols: 100, rows: 30 }),
    });
  });

  it('fetchRecentLogs encodes deviceId and returns array', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'log-1', type: 'function_status' }],
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRecentLogs('dev 1', 20)).resolves.toEqual([{ id: 'log-1', type: 'function_status' }]);

    expect(fetchMock).toHaveBeenCalledWith('/v1/logs?deviceId=dev%201&limit=20', {
      credentials: 'same-origin',
    });
  });

  it('fetchCommands encodes deviceId and returns command items', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            commandId: 'cmd-1',
            commandType: 'request_status_snapshot',
            state: 'queued',
            submittedAt: '2026-04-20T00:00:00.000Z',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCommands('dev 1')).resolves.toEqual([
      {
        commandId: 'cmd-1',
        commandType: 'request_status_snapshot',
        state: 'queued',
        submittedAt: '2026-04-20T00:00:00.000Z',
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith('/v1/commands?deviceId=dev+1&limit=20', {
      credentials: 'same-origin',
    });
  });

  it('fetchCommands throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    await expect(fetchCommands('dev-1')).rejects.toThrow('Failed to load commands');
  });

  it('fetchDevices throws friendly error on non-JSON response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token '<', \"<!doctype ...\" is not valid JSON");
      },
    }));

    await expect(fetchDevices()).rejects.toThrow('Failed to parse devices response');
  });

  it('fetchRecentLogs throws friendly error on malformed JSON payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }));

    await expect(fetchRecentLogs('dev-1', 20)).rejects.toThrow('Failed to parse recent logs response');
  });

  it('fetchCommands throws friendly error on malformed JSON payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token } in JSON at position 10');
      },
    }));

    await expect(fetchCommands('dev-1')).rejects.toThrow('Failed to parse commands response');
  });

  it('fetchCommandAudit encodes commandId and returns audit items', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            eventType: 'queued',
            ts: '2026-04-21T00:00:00.000Z',
            summary: 'Queued',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCommandAudit('cmd 1')).resolves.toEqual([
      {
        eventType: 'queued',
        ts: '2026-04-21T00:00:00.000Z',
        summary: 'Queued',
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith('/v1/commands/cmd%201/audit', {
      credentials: 'same-origin',
    });
  });

  it('fetchCommandAudit throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    await expect(fetchCommandAudit('cmd-1')).rejects.toThrow('Failed to load command audit');
  });

  it('fetchTransfers encodes deviceId and returns transfer items', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            transferId: 'tr-1',
            direction: 'upload',
            state: 'running',
            updatedAt: '2026-04-21T00:00:00.000Z',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTransfers('dev 1')).resolves.toEqual([
      {
        transferId: 'tr-1',
        direction: 'upload',
        state: 'running',
        updatedAt: '2026-04-21T00:00:00.000Z',
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers?deviceId=dev+1&limit=50', {
      credentials: 'same-origin',
    });
  });

  it('fetchTransfers throws on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    await expect(fetchTransfers('dev-1')).rejects.toThrow('Failed to load transfers');
  });

  it('startScpTransfer posts a start_scp command with transfer options', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, command: { commandId: 'cmd-transfer', payload: { transferId: 'tr-1' } } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      ...document,
      querySelector: vi.fn().mockReturnValue({ getAttribute: () => 'csrf-transfer' }),
      cookie: '',
    } as unknown as Document);

    await expect(startScpTransfer('dev-1', 'upload', {
      serverId: 'srv-1',
      localPath: '/tmp/report.csv',
      remotePath: '/var/tmp/report.csv',
      recursive: true,
      overwritePolicy: 'force',
      verifyChecksum: true,
      followSymlinks: true,
      preserveMtime: true,
      preserveMode: true,
      rateLimitKbps: 512,
    })).resolves.toMatchObject({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith('/v1/commands', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csrfToken: 'csrf-transfer',
        deviceId: 'dev-1',
        commandType: 'start_scp_upload',
        payload: {
          serverId: 'srv-1',
          localPath: '/tmp/report.csv',
          remotePath: '/var/tmp/report.csv',
          recursive: true,
          overwritePolicy: 'force',
          verifyChecksum: true,
          followSymlinks: true,
          preserveMtime: true,
          preserveMode: true,
          rateLimitKbps: 512,
        },
      }),
    });
  });

  it('startScpTransfer uses start_scp_download for downloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      ...document,
      querySelector: vi.fn().mockReturnValue({ getAttribute: () => 'csrf-transfer' }),
      cookie: '',
    } as unknown as Document);

    await startScpTransfer('dev-1', 'download', {
      serverId: 'srv-1',
      localPath: '/tmp/report.csv',
      remotePath: '/var/tmp/report.csv',
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.commandType).toBe('start_scp_download');
    expect(body.payload).toMatchObject({
      serverId: 'srv-1',
      localPath: '/tmp/report.csv',
      remotePath: '/var/tmp/report.csv',
    });
  });

  it('fetchTelemetry encodes deviceId and telemetry filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ([
        { id: 'evt-1', ts: '2026-04-21T00:00:00.000Z', type: 'function_status', functionId: 'vpn-agent' },
      ]),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTelemetry('dev 1', {
      limit: 150,
      type: 'function_status',
      q: 'vpn',
      fromTs: '2026-04-20T00:00:00.000Z',
      toTs: '2026-04-21T00:00:00.000Z',
    })).resolves.toEqual([
      { id: 'evt-1', ts: '2026-04-21T00:00:00.000Z', type: 'function_status', functionId: 'vpn-agent' },
    ]);

    expect(fetchMock).toHaveBeenCalledWith('/v1/logs?deviceId=dev+1&limit=150&type=function_status&q=vpn&fromTs=2026-04-20T00%3A00%3A00.000Z&toTs=2026-04-21T00%3A00%3A00.000Z', {
      credentials: 'same-origin',
    });
  });

  it('fetchTelemetry returns events when wrapped in events field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: [{ id: 'evt-2', type: 'heartbeat' }] }),
    }));

    await expect(fetchTelemetry('dev-1', { limit: 100 })).resolves.toEqual([{ id: 'evt-2', type: 'heartbeat' }]);
  });

  it('buildTelemetryExportUrl encodes telemetry filters', () => {
    expect(buildTelemetryExportUrl('dev 1', {
      limit: 150,
      type: 'function_status',
      q: 'vpn',
      fromTs: '2026-04-20T00:00:00.000Z',
      toTs: '2026-04-21T00:00:00.000Z',
    }))
      .toBe('/v1/logs/export?deviceId=dev+1&limit=150&type=function_status&q=vpn&fromTs=2026-04-20T00%3A00%3A00.000Z&toTs=2026-04-21T00%3A00%3A00.000Z');
  });

  it('buildTelemetryExportUrl uses default limit', () => {
    expect(buildTelemetryExportUrl('dev-1')).toBe('/v1/logs/export?deviceId=dev-1&limit=100');
  });

  it('stopTransfer posts deviceId, transferId and csrfToken', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, transferId: 'tr-1' }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      ...document,
      querySelector: vi.fn().mockReturnValue({ getAttribute: () => 'csrf-123' }),
      cookie: '',
    } as unknown as Document);

    await expect(stopTransfer('dev-1', 'tr-1')).resolves.toEqual({ ok: true, transferId: 'tr-1' });

    expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers/stop', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-1', csrfToken: 'csrf-123' }),
    });
  });

  it('dismissTransfer and forceRemoveTransfer use the expected endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, transferId: 'tr-1' }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      ...document,
      querySelector: vi.fn().mockReturnValue({ getAttribute: () => 'csrf-123' }),
      cookie: '',
    } as unknown as Document);

    await dismissTransfer('dev-1', 'tr-1');
    await forceRemoveTransfer('dev-1', 'tr-1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/file-transfers/dismiss');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/v1/file-transfers/force-remove');
  });

  it('dismissFinishedTransfers posts deviceId and csrfToken', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, deletedCount: 2 }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      ...document,
      querySelector: vi.fn().mockReturnValue({ getAttribute: () => 'csrf-123' }),
      cookie: '',
    } as unknown as Document);

    await dismissFinishedTransfers('dev-1');

    expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers/dismiss-finished', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-1', csrfToken: 'csrf-123' }),
    });
  });

  it('resumeTransfer dispatches start command payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, command: { commandId: 'cmd-1' } }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('document', {
      ...document,
      querySelector: vi.fn().mockReturnValue({ getAttribute: () => 'csrf-123' }),
      cookie: '',
    } as unknown as Document);

    await resumeTransfer('dev-1', {
      transferId: 'tr-1',
      direction: 'upload',
      localPath: '/tmp/a',
      remotePath: '/var/a',
      resumeToken: 'resume-1',
      resumeOffsetBytes: 100,
      tempPathHint: '/tmp/a.partial',
    });

    expect(fetchMock).toHaveBeenCalledWith('/v1/commands', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        csrfToken: 'csrf-123',
        deviceId: 'dev-1',
        commandType: 'start_scp_upload',
        payload: {
          transferId: 'tr-1',
          localPath: '/tmp/a',
          remotePath: '/var/a',
          resumeToken: 'resume-1',
          resumeOffsetBytes: 100,
          tempPathHint: '/tmp/a.partial',
        },
      }),
    });
  });

  it('subscribeTelemetryStream opens stream and unsubscribes', async () => {
    const close = vi.fn();
    const ctor = vi.fn(function(this: { onmessage: null | (() => void) }) {
      this.onmessage = null;
      return { close };
    });

    vi.stubGlobal('EventSource', ctor as unknown as typeof EventSource);
    const onMessage = vi.fn();

    const sub = subscribeTelemetryStream('dev 1', onMessage);

    expect(ctor).toHaveBeenCalledWith('/v1/logs/stream?deviceId=dev%201', { withCredentials: true });

    const instance = ctor.mock.instances[0] as { onmessage: null | (() => void) };
    instance.onmessage?.();
    expect(onMessage).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
    expect(close).toHaveBeenCalledTimes(1);
  });


  it('subscribeTelemetryStream passes parsed telemetry records to subscribers', async () => {
    const close = vi.fn();
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const ctor = vi.fn(function(_url: string) {
      return {
        addEventListener: (name: string, handler: EventListener) => {
          listeners.set(name, handler as (event: MessageEvent) => void);
        },
        close,
      };
    });

    vi.stubGlobal('EventSource', ctor as unknown as typeof EventSource);
    const onMessage = vi.fn();

    const sub = subscribeTelemetryStream('dev 1', onMessage);

    listeners.get('telemetry')?.({ data: JSON.stringify({ id: 'evt-1', type: 'pty-output', payload: { data: 'a' } }) } as MessageEvent);

    expect(onMessage).toHaveBeenCalledWith({ id: 'evt-1', type: 'pty-output', payload: { data: 'a' } });
    sub.unsubscribe();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('subscribeTransfersStream opens stream and unsubscribes', async () => {
    const close = vi.fn();
    const ctor = vi.fn(function(this: { onmessage: null | (() => void) }) {
      this.onmessage = null;
      return { close };
    });

    vi.stubGlobal('EventSource', ctor as unknown as typeof EventSource);
    const onMessage = vi.fn();

    const sub = subscribeTransfersStream('dev 1', onMessage);

    expect(ctor).toHaveBeenCalledWith('/v1/file-transfers/stream?deviceId=dev%201', { withCredentials: true });

    const instance = ctor.mock.instances[0] as { onmessage: null | (() => void) };
    instance.onmessage?.();
    expect(onMessage).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
    expect(close).toHaveBeenCalledTimes(1);
  });


  it('subscribeTransfersStream listens to file_transfer events with parsed records', async () => {
    const close = vi.fn();
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const ctor = vi.fn(function(_url: string) {
      return {
        addEventListener: (name: string, handler: EventListener) => {
          listeners.set(name, handler as (event: MessageEvent) => void);
        },
        close,
      };
    });

    vi.stubGlobal('EventSource', ctor as unknown as typeof EventSource);
    const onMessage = vi.fn();

    const sub = subscribeTransfersStream('dev 1', onMessage);

    listeners.get('file_transfer')?.({ data: JSON.stringify({ transferId: 'tr-1', percent: 52 }) } as MessageEvent);

    expect(onMessage).toHaveBeenCalledWith({ transferId: 'tr-1', percent: 52 });
    sub.unsubscribe();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('subscribeCommandsStream opens stream and unsubscribes', async () => {
    const close = vi.fn();
    const ctor = vi.fn(function(this: { onmessage: null | (() => void) }) {
      this.onmessage = null;
      return { close };
    });

    vi.stubGlobal('EventSource', ctor as unknown as typeof EventSource);
    const onMessage = vi.fn();

    const sub = subscribeCommandsStream('dev 1', onMessage);

    expect(ctor).toHaveBeenCalledWith('/v1/commands/stream?deviceId=dev%201', { withCredentials: true });

    const instance = ctor.mock.instances[0] as { onmessage: null | (() => void) };
    instance.onmessage?.();
    expect(onMessage).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('subscribeCommandsStream returns no-op when EventSource is unavailable', () => {
    vi.stubGlobal('EventSource', undefined);
    const onMessage = vi.fn();
    const sub = subscribeCommandsStream('dev-1', onMessage);
    expect(typeof sub.unsubscribe).toBe('function');
    sub.unsubscribe();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('subscribeDevicesStream opens stream and dispatches device-connected events', async () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const close = vi.fn();
    const ctor = vi.fn(function(_url: string) {
      return {
        addEventListener: (name: string, handler: EventListener) => {
          listeners.set(name, handler as (event: MessageEvent) => void);
        },
        close,
      };
    });

    vi.stubGlobal('EventSource', ctor as unknown as typeof EventSource);
    const onMessage = vi.fn();

    const sub = subscribeDevicesStream(onMessage);

    expect(ctor).toHaveBeenCalledWith('/v1/devices/stream', { withCredentials: true });

    listeners.get('device-connected')?.({ data: JSON.stringify({ deviceId: 'dev-1', status: 'connected', lastSeenAt: '2026-04-28T00:00:00.000Z' }) } as MessageEvent);

    expect(onMessage).toHaveBeenCalledWith({ deviceId: 'dev-1', status: 'connected', lastSeenAt: '2026-04-28T00:00:00.000Z' });

    sub.unsubscribe();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('subscribeDevicesStream dispatches device-disconnected events', async () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const close = vi.fn();
    const ctor = vi.fn(function(_url: string) {
      return {
        addEventListener: (name: string, handler: EventListener) => {
          listeners.set(name, handler as (event: MessageEvent) => void);
        },
        close,
      };
    });

    vi.stubGlobal('EventSource', ctor as unknown as typeof EventSource);
    const onMessage = vi.fn();

    const sub = subscribeDevicesStream(onMessage);
    listeners.get('device-disconnected')?.({ data: JSON.stringify({ deviceId: 'dev-2', status: 'disconnected', lastSeenAt: '2026-04-28T01:00:00.000Z' }) } as MessageEvent);

    expect(onMessage).toHaveBeenCalledWith({ deviceId: 'dev-2', status: 'disconnected', lastSeenAt: '2026-04-28T01:00:00.000Z' });

    sub.unsubscribe();
  });
});
