import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { subscribeTelemetryStream, subscribeTransfersStream } from '../api/adminApi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceListSection } from '../components/DeviceListSection';
import { useAdminDashboard } from './useAdminDashboard';

function HookHarness() {
  const model = useAdminDashboard();

  return (
    <>
      <DeviceListSection
        devices={model.devices}
        loading={model.loading}
        error={model.error}
        onRefresh={model.refreshDevices}
        onSelectDevice={model.selectDevice}
        onViewLogs={model.selectDevice}
        onRequestSnapshot={model.requestStatusSnapshot}
        onRequestRecentLogs={model.requestRecentLogs}
        onRequestRestartOpenvpn={model.requestRestartOpenvpn}
        onRequestRestartBoundaryAuth={model.requestRestartBoundaryAuth}
        onRequestRestartServerTunnel={() => {}}
        deviceActionLoadingId={model.deviceActionLoadingId}
        deviceActionError={model.deviceActionError}
      />
      <button type="button" onClick={() => model.selectDevice('dev-1')}>
        Select dev-1
      </button>
      <button type="button" onClick={() => model.requestStatusSnapshot('dev-1')}>
        Request snapshot dev-1
      </button>
      <button type="button" onClick={() => model.requestRecentLogs('dev-1')}>
        Request recent logs dev-1
      </button>
      <button type="button" onClick={() => model.requestRestartBoundaryAuth('dev-1')}>
        Request restart boundary auth dev-1
      </button>
      <button type="button" onClick={() => model.requestStartServerTunnel('dev-1', 'srv-1')}>
        Request start server tunnel dev-1 srv-1
      </button>
      <button type="button" onClick={() => model.requestStopServerTunnel('dev-1', 'srv-1')}>
        Request stop server tunnel dev-1 srv-1
      </button>
      <button type="button" onClick={() => model.selectTunnelServer('srv-1')}>
        View tunnel logs dev-1 srv-1
      </button>
      <button type="button" onClick={model.refreshTunnelLogs}>
        Refresh tunnel logs
      </button>
      <p>Selected tunnel server: {model.selectedTunnelServerId || '-'}</p>
      <p>Tunnel logs loading: {model.tunnelLogsLoading ? 'yes' : 'no'}</p>
      <p>Tunnel logs count: {model.tunnelLogs.length}</p>
      {model.tunnelLogs.map((entry, index) => (
        <p key={`${entry.ts || 'log'}-${index}`}>Tunnel log: {entry.data}</p>
      ))}
      {model.tunnelLogsError ? <p>{model.tunnelLogsError}</p> : null}
      <button type="button" onClick={model.retryRuntimeSummary}>
        Retry runtime summary
      </button>
      <button type="button" onClick={model.retryRecentLogs}>
        Retry recent logs
      </button>
      <p>Commands loading: {model.commandsLoading ? 'yes' : 'no'}</p>
      <p>Commands count: {model.commands.length}</p>
      <p>Selected command: {model.selectedCommandId || '-'}</p>
      <p>Command audit count: {model.commandAudit.length}</p>
      <button type="button" onClick={model.refreshCommands}>Refresh commands</button>
      <button type="button" onClick={() => model.selectCommand('cmd-2')}>Select command cmd-2</button>
      <button type="button" onClick={model.refreshTransfers}>Refresh transfers</button>
      <button type="button" onClick={() => model.stopTransfer('tr-1')}>Stop transfer</button>
      <button type="button" onClick={() => model.dismissTransfer('tr-1')}>Dismiss transfer</button>
      <button type="button" onClick={() => model.forceRemoveTransfer('tr-1')}>Force remove transfer</button>
      <button type="button" onClick={() => model.resumeTransfer('tr-1')}>Resume transfer</button>
      <button type="button" onClick={model.dismissFinishedTransfers}>Clear finished transfers</button>
      <p>Transfers count: {model.transfers.length}</p>
      <p>Active transfer action: {model.activeTransferId || '-'}</p>
      <button type="button" onClick={model.refreshTelemetry}>Refresh telemetry</button>
      <input
        aria-label="Telemetry type filter"
        value={model.telemetryTypeFilter}
        onChange={(event) => model.setTelemetryTypeFilter(event.target.value)}
      />
      <input
        aria-label="Telemetry text filter"
        value={model.telemetryTextFilter}
        onChange={(event) => model.setTelemetryTextFilter(event.target.value)}
      />
      <input
        aria-label="Telemetry from filter"
        value={model.telemetryFromTsFilter}
        onChange={(event) => model.setTelemetryFromTsFilter(event.target.value)}
      />
      <input
        aria-label="Telemetry to filter"
        value={model.telemetryToTsFilter}
        onChange={(event) => model.setTelemetryToTsFilter(event.target.value)}
      />
      <p>Telemetry count: {model.telemetry.length}</p>
      <p>Telemetry export URL: {model.telemetryExportUrl || '-'}</p>
      {model.commandsError ? <p>{model.commandsError}</p> : null}
      {model.commandAuditError ? <p>{model.commandAuditError}</p> : null}
      {model.transfersError ? <p>{model.transfersError}</p> : null}
      {model.telemetryError ? <p>{model.telemetryError}</p> : null}
      {model.runtimeSummaryError ? <p>{model.runtimeSummaryError}</p> : null}
      {model.recentLogsError ? <p>{model.recentLogsError}</p> : null}
      {model.deviceActionError ? <p>{model.deviceActionError}</p> : null}
    </>
  );
}

describe('useAdminDashboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

    const eventSourceCtor = vi.fn(function(this: { onmessage: null | (() => void) }) {
      this.onmessage = null;
      return { close: vi.fn() };
    });
    vi.stubGlobal('EventSource', eventSourceCtor as unknown as typeof EventSource);
  });

  afterEach(() => {
    cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads device list on mount', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }],
    }));

    render(<HookHarness />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });
  });

  it('refreshes device list when user clicks refresh', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null },
          { id: 'dev-2', name: 'Device Two', status: 'disconnected', os: null, lastSeenAt: null },
        ],
      });

    vi.stubGlobal('fetch', fetchMock);

    render(<HookHarness />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /refresh devices/i }));

    await waitFor(() => {
      expect(screen.getByText('Device Two')).toBeInTheDocument();
    });
  });

  it('shows error message when initial devices fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    render(<HookHarness />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load devices')).toBeInTheDocument();
    });
  });

  it('retries runtime summary without refetching logs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: { 'vpn-agent': { state: 'running' } } }),
      });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to load runtime summary')).toBeInTheDocument();
    });

    const beforeRetryCalls = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Retry runtime summary' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBe(beforeRetryCalls + 1);
    });

    expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0]).toBe('/v1/device-summary?deviceId=dev-1');
  });

  it('retries recent logs without refetching summary', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }),
      })
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 'log-1', type: 'function_status' }] });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));

    await waitFor(() => {
      expect(screen.getByText('Failed to load recent logs')).toBeInTheDocument();
    });

    const beforeRetryCalls = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Retry recent logs' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBe(beforeRetryCalls + 1);
    });

    expect(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[0]).toBe('/v1/logs?deviceId=dev-1&limit=20');
  });

  it('loads command history after selecting a device', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }],
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [{ commandId: 'cmd-1', commandType: 'request_status_snapshot', state: 'queued', submittedAt: '2026-04-20T00:00:00.000Z' }] }),
      });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));

    await waitFor(() => {
      expect(screen.getByText('Commands count: 1')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith('/v1/commands?deviceId=dev-1&limit=20', {
      credentials: 'same-origin',
    });
  });

  it('loads command audit for first command after command list loads', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              { commandId: 'cmd-1', commandType: 'request_status_snapshot', state: 'queued', submittedAt: '2026-04-20T00:00:00.000Z' },
              { commandId: 'cmd-2', commandType: 'restart_openvpn', state: 'queued', submittedAt: '2026-04-20T00:01:00.000Z' },
            ],
          }),
        });
      }
      if (url === '/v1/commands/cmd-1/audit') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ eventType: 'queued', ts: '2026-04-21T00:00:00.000Z', summary: 'Queued' }] }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=100') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));

    await waitFor(() => {
      expect(screen.getByText('Selected command: cmd-1')).toBeInTheDocument();
      expect(screen.getByText('Command audit count: 1')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith('/v1/commands/cmd-1/audit', {
      credentials: 'same-origin',
    });
  });

  it('loads command audit for explicitly selected command', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              { commandId: 'cmd-1', commandType: 'request_status_snapshot', state: 'queued', submittedAt: '2026-04-20T00:00:00.000Z' },
              { commandId: 'cmd-2', commandType: 'restart_openvpn', state: 'queued', submittedAt: '2026-04-20T00:01:00.000Z' },
            ],
          }),
        });
      }
      if (url === '/v1/commands/cmd-1/audit') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/commands/cmd-2/audit') return Promise.resolve({ ok: true, json: async () => ({ items: [{ eventType: 'queued', ts: '2026-04-21T00:00:00.000Z', summary: 'Queued cmd-2' }] }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));

    await waitFor(() => expect(screen.getByText('Selected command: cmd-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select command cmd-2' }));

    await waitFor(() => {
      expect(screen.getByText('Selected command: cmd-2')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith('/v1/commands/cmd-2/audit', {
        credentials: 'same-origin',
      });
    });
  });

  it('keeps selected command after command refresh when command still exists', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=100') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              { commandId: 'cmd-1', commandType: 'request_status_snapshot', state: 'queued', submittedAt: '2026-04-20T00:00:00.000Z' },
              { commandId: 'cmd-2', commandType: 'restart_openvpn', state: 'queued', submittedAt: '2026-04-20T00:01:00.000Z' },
            ],
          }),
        });
      }
      if (url === '/v1/commands/cmd-1/audit') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ eventType: 'queued', ts: '2026-04-21T00:00:00.000Z', summary: 'Queued' }] }) });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));

    await waitFor(() => {
      expect(screen.getByText('Selected command: cmd-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh commands' }));

    await waitFor(() => {
      expect(screen.getByText('Selected command: cmd-1')).toBeInTheDocument();
    });
  });

  it('loads transfer activity when user refreshes transfers for selected device', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'running', updatedAt: '2026-04-21T00:00:00.000Z' }] }),
        });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh transfers' }));

    await waitFor(() => {
      expect(screen.getByText('Transfers count: 1')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers?deviceId=dev-1&limit=50', {
      credentials: 'same-origin',
    });
  });

  it('loads telemetry for selected device', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=100') {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 'evt-1', type: 'function_status', ts: '2026-04-21T00:00:00.000Z', functionId: 'vpn-agent' }],
        });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));

    await waitFor(() => {
      expect(screen.getByText('Telemetry count: 1')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith('/v1/logs?deviceId=dev-1&limit=100', {
      credentials: 'same-origin',
    });
  });

  it('applies telemetry filters when loading telemetry', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      if (url.includes('/v1/logs?deviceId=dev-1&limit=100&type=function_status&q=vpn')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      if (url === '/v1/logs?deviceId=dev-1&limit=100') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/logs?deviceId=dev-1&limit=100', {
        credentials: 'same-origin',
      });
    });

    fireEvent.change(screen.getByLabelText('Telemetry type filter'), { target: { value: 'function_status' } });
    fireEvent.change(screen.getByLabelText('Telemetry text filter'), { target: { value: 'vpn' } });
    fireEvent.change(screen.getByLabelText('Telemetry from filter'), { target: { value: '2026-04-20T00:00:00.000Z' } });
    fireEvent.change(screen.getByLabelText('Telemetry to filter'), { target: { value: '2026-04-21T00:00:00.000Z' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/logs?deviceId=dev-1&limit=100&type=function_status&q=vpn&fromTs=2026-04-20T00%3A00%3A00.000Z&toTs=2026-04-21T00%3A00%3A00.000Z', {
        credentials: 'same-origin',
      });
      expect(screen.getByText('Telemetry export URL: /v1/logs/export?deviceId=dev-1&limit=100&type=function_status&q=vpn&fromTs=2026-04-20T00%3A00%3A00.000Z&toTs=2026-04-21T00%3A00%3A00.000Z')).toBeInTheDocument();
    });
  });

  it('runs stop transfer action and refreshes transfers', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return {
          getAttribute: () => 'csrf-123',
        } as unknown as Element;
      }

      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') return Promise.resolve({ ok: true, json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'running', updatedAt: '2026-04-21T00:00:00.000Z' }] }) });
      if (url === '/v1/file-transfers/stop' && init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ ok: true, transferId: 'tr-1' }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop transfer' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers/stop', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-1', csrfToken: 'csrf-123' }),
      });
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers?deviceId=dev-1&limit=50', {
        credentials: 'same-origin',
      });
    });
  });

  it('requests recent logs and refreshes recent logs + commands', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return {
          getAttribute: () => 'csrf-123',
        } as unknown as Element;
      }

      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [{ id: 'log-1', type: 'function_status' }] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/devices/dev-1/request-recent-logs' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, command: { commandId: 'cmd-2' } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Request recent logs dev-1' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/request-recent-logs', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken: 'csrf-123' }),
      });
      expect(fetchMock).toHaveBeenCalledWith('/v1/logs?deviceId=dev-1&limit=20', {
        credentials: 'same-origin',
      });
    });
  });

  it('requests restart boundary auth and refreshes commands', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return {
          getAttribute: () => 'csrf-456',
        } as unknown as Element;
      }

      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [{ id: 'log-1', type: 'function_status' }] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/devices/dev-1/request-restart-boundary-auth' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, command: { commandId: 'cmd-3' } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Request restart boundary auth dev-1' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/request-restart-boundary-auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken: 'csrf-456' }),
      });
    });
  });


  it('requests start server tunnel and refreshes runtime summary', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return {
          getAttribute: () => 'csrf-start',
        } as unknown as Element;
      }

      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      if (url === '/v1/devices/dev-1/request-start-server-tunnel' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, command: { commandId: 'cmd-5' } }) });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-23T10:00:00.000Z', functions: { 'server-tunnel-srv-1': { state: 'running', sessionId: 'sess-new' } }, inventory: {} }) });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Request start server tunnel dev-1 srv-1' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/request-start-server-tunnel', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken: 'csrf-start', serverId: 'srv-1' }),
      });
    });

    // Should have refreshed runtime summary after starting tunnel
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/device-summary?deviceId=dev-1', {
        credentials: 'same-origin',
      });
    });
  });

  it('requests stop server tunnel and refreshes runtime summary', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return {
          getAttribute: () => 'csrf-stop',
        } as unknown as Element;
      }

      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      if (url === '/v1/devices/dev-1/request-stop-server-tunnel' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, command: { commandId: 'cmd-6' } }) });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-23T10:00:00.000Z', functions: { 'server-tunnel-srv-1': { state: 'idle' } }, inventory: {} }) });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Request stop server tunnel dev-1 srv-1' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/request-stop-server-tunnel', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csrfToken: 'csrf-stop', serverId: 'srv-1' }),
      });
    });

    // Should have refreshed runtime summary after stopping tunnel
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/device-summary?deviceId=dev-1', {
        credentials: 'same-origin',
      });
    });
  });

  it('loads tunnel logs for the selected tunnel server', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: { 'server-tunnel-srv-1': { state: 'running', sessionId: 'sess-1' } }, inventory: { servers: [{ id: 'srv-1', name: 'Boundary Bastion', connectionMethod: 'boundary' }] } }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url.includes('/tunnels/srv-1/logs')) return Promise.resolve({ ok: true, json: async () => ({ entries: [{ ts: '2026-04-23T03:33:23.000Z', sessionId: 'sess-1', data: 'Tunnel ready' }], total: 1 }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'View tunnel logs dev-1 srv-1' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/tunnels/srv-1/logs?limit=200&offset=0', {
        credentials: 'same-origin',
      });
      expect(screen.getByText('Selected tunnel server: srv-1')).toBeInTheDocument();
      expect(screen.getByText('Tunnel log: Tunnel ready')).toBeInTheDocument();
    });
  });

  it('runs dismiss transfer action and refreshes transfers', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return {
          getAttribute: () => 'csrf-123',
        } as unknown as Element;
      }

      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') return Promise.resolve({ ok: true, json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'succeeded', updatedAt: '2026-04-21T00:00:00.000Z' }] }) });
      if (url === '/v1/file-transfers/dismiss' && init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ ok: true, transferId: 'tr-1' }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss transfer' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers/dismiss', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-1', csrfToken: 'csrf-123' }),
      });
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers?deviceId=dev-1&limit=50', {
        credentials: 'same-origin',
      });
    });
  });

  it('runs force remove transfer action and refreshes transfers', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return {
          getAttribute: () => 'csrf-123',
        } as unknown as Element;
      }

      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') return Promise.resolve({ ok: true, json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'running', updatedAt: '2026-04-21T00:00:00.000Z' }] }) });
      if (url === '/v1/file-transfers/force-remove' && init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ ok: true, transferId: 'tr-1' }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Force remove transfer' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers/force-remove', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-1', csrfToken: 'csrf-123' }),
      });
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers?deviceId=dev-1&limit=50', {
        credentials: 'same-origin',
      });
    });
  });

  it('runs resume transfer action via commands endpoint and refreshes transfers', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-123' } as unknown as Element;
      }
      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'failed', resumeSupported: true, resumeToken: 'resume-1', resumeOffsetBytes: 100, tempPathHint: '/tmp/a.partial', localPath: '/tmp/a', remotePath: '/var/a', updatedAt: '2026-04-21T00:00:00.000Z' }] }) });
      }
      if (url === '/v1/commands' && init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ ok: true, command: { commandId: 'cmd-r1' } }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh transfers' }));

    await waitFor(() => {
      expect(screen.getByText('Transfers count: 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Resume transfer' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/commands', expect.objectContaining({ method: 'POST' }));
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers?deviceId=dev-1&limit=50', {
        credentials: 'same-origin',
      });
    });
  });

  it('runs clear finished transfers action and refreshes transfers', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-123' } as unknown as Element;
      }
      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }] });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: null }) });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') return Promise.resolve({ ok: true, json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'succeeded', updatedAt: '2026-04-21T00:00:00.000Z' }] }) });
      if (url === '/v1/file-transfers/dismiss-finished' && init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ ok: true, deletedCount: 1 }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<HookHarness />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Select dev-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear finished transfers' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers/dismiss-finished', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-1', csrfToken: 'csrf-123' }),
      });
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers?deviceId=dev-1&limit=50', {
        credentials: 'same-origin',
      });
    });
  });
});
