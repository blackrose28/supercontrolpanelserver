import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchCommandAudit,
  fetchCommands,
  fetchDeviceDetails,
  fetchDevices,
  buildTelemetryExportUrl,
  fetchRecentLogs,
  fetchRuntimeSummary,
  fetchTelemetry,
  fetchTransfers,
  requestRecentLogs,
  requestStatusSnapshot,
  stopTransfer,
  dismissTransfer,
  forceRemoveTransfer,
  dismissFinishedTransfers,
  resumeTransfer,
  subscribeTelemetryStream,
  subscribeCommandsStream,
  subscribeTransfersStream,
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
});
