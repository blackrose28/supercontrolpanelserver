import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecentLogEntry, RuntimeSummary } from './api/adminApi';
import type { DeviceSummary } from './types/device';
import App from './App';

type FetchResponse<T> = {
  ok: boolean;
  json: () => Promise<T>;
};

const initialDevices: DeviceSummary[] = [
  { id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: '2026-04-18T00:00:00.000Z' },
  { id: 'dev-2', name: 'Device Two', status: 'disconnected', os: null, lastSeenAt: null },
];

type PendingDeviceResponse = FetchResponse<DeviceSummary>;
type PendingSummaryResponse = FetchResponse<RuntimeSummary>;
type PendingLogsResponse = FetchResponse<RecentLogEntry[]>;

describe('App shell', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Admin Next heading', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }));

    render(<App />);
    expect(screen.getByRole('heading', { name: /admin next/i })).toBeInTheDocument();
  });

  it('shows empty state when device list is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('No devices found.')).toBeInTheDocument();
    });
  });

  it('shows device actions and can request a snapshot from the list', async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="csrf-123" />';

    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1/request-status-snapshot') {
        expect(options).toMatchObject({
          method: 'POST',
          credentials: 'same-origin',
        });
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, command: { commandId: 'cmd-1' } }),
        });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /actions for device one/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /request snapshot/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/v1/devices/dev-1/request-status-snapshot',
        expect.objectContaining({
          method: 'POST',
          credentials: 'same-origin',
        }),
      );
    });
  });

  it('shows device actions and can request recent logs from the list', async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="csrf-123" />';

    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1/request-recent-logs') {
        expect(options).toMatchObject({
          method: 'POST',
          credentials: 'same-origin',
        });
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, command: { commandId: 'cmd-2' } }),
        });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /actions for device one/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /request recent logs/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/v1/devices/dev-1/request-recent-logs',
        expect.objectContaining({
          method: 'POST',
          credentials: 'same-origin',
        }),
      );
    });
  });

  it('renders command history for selected device', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }),
        });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              {
                commandId: 'cmd-1',
                commandType: 'request_status_snapshot',
                state: 'queued',
                submittedAt: '2026-04-20T00:00:00.000Z',
                actorType: 'admin_session',
                payloadSummary: 'manual refresh',
                finishedAt: '2026-04-20T00:01:00.000Z',
                reasonCode: 'ok',
              },
            ],
          }),
        });
      }

      return Promise.resolve({ ok: false, json: async () => ({}) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('tab', { name: 'Command History' }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Command History' })).toBeInTheDocument();
      expect(screen.getByText('Showing recent commands for dev-1 (1 loaded)')).toBeInTheDocument();
      expect(screen.getByText('request_status_snapshot')).toBeInTheDocument();
      expect(screen.getByText('Actor: Admin UI')).toBeInTheDocument();
      expect(screen.getByText('Summary: manual refresh')).toBeInTheDocument();
      expect(screen.getByText('Finished: 2026-04-20 07:01:00 GMT+7 | Result: ok')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'request_status_snapshot' })).toHaveClass('command-card-button');
    });

    const commandSection = screen.getByRole('heading', { name: 'Command History' }).closest('section');
    expect(commandSection).toHaveClass('panel-section');
    expect(commandSection).toHaveClass('commands-section');
    expect(screen.getByRole('button', { name: 'request_status_snapshot' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('queued')).toHaveClass('command-state-badge');
    expect(screen.getByText('queued')).toHaveClass('state-queued');
  });

  it('renders transfer card visual structure for selected device', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              {
                transferId: 'tr-1',
                direction: 'upload',
                state: 'running',
                sessionId: 'session-1',
                updatedAt: '2026-04-21T00:00:00.000Z',
              },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Transfer Activity' })).toBeInTheDocument();
      expect(screen.getByText('upload')).toBeInTheDocument();
    });

    const transfersSection = screen.getByRole('heading', { name: 'Transfer Activity' }).closest('section');
    expect(transfersSection).toHaveClass('panel-section');
    expect(transfersSection).toHaveClass('transfers-section');
    const transferItem = screen.getByText('upload').closest('li');
    expect(transferItem).toHaveClass('transfer-card');
    expect(screen.getByText('running')).toHaveClass('transfer-state-badge');
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveClass('transfer-action-button');
  });

  it('selects command card and refreshes audit for selected command', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
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
      if (url === '/v1/commands/cmd-1/audit') return Promise.resolve({ ok: true, json: async () => ({ items: [{ eventType: 'queued', ts: '2026-04-21T00:00:00.000Z', summary: 'Queued cmd-1' }] }) });
      if (url === '/v1/commands/cmd-2/audit') return Promise.resolve({ ok: true, json: async () => ({ items: [{ eventType: 'queued', ts: '2026-04-21T00:01:00.000Z', summary: 'Queued cmd-2' }] }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('Selected command: cmd-1')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith('/v1/commands/cmd-1/audit', { credentials: 'same-origin' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'restart_openvpn' }));

    await waitFor(() => {
      expect(screen.getByText('Selected command: cmd-2')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith('/v1/commands/cmd-2/audit', { credentials: 'same-origin' });
    });
  });

  it('shows command history empty state for selected device', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }),
        });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }

      return Promise.resolve({ ok: false, json: async () => ({}) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('No commands found.')).toBeInTheDocument();
    });
  });

  it('shows command history error for selected device when commands fetch fails', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }),
        });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: false, json: async () => ({}) });
      }

      return Promise.resolve({ ok: false, json: async () => ({}) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('Failed to load commands')).toBeInTheDocument();
    });
  });

  it('shows command history guidance when no device is selected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => initialDevices,
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Command History' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /select device one/i })).toBeInTheDocument();
    });
  });

  it('renders transfer activity for selected device', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }),
        });
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
          json: async () => ({
            items: [
              {
                transferId: 'tr-1',
                direction: 'upload',
                state: 'running',
                sessionId: 'session-1',
                updatedAt: '2026-04-21T00:00:00.000Z',
                phase: 'transferring',
                percent: 37.5,
                bytesTransferred: 393216,
                bytesTotal: 1048576,
                throughputBps: 65536,
                etaSec: 10,
                reasonCode: 'network_retry',
                reasonDetail: 'retrying chunk',
              },
            ],
          }),
        });
      }

      return Promise.resolve({ ok: false, json: async () => ({}) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Transfer Activity' })).toBeInTheDocument();
      expect(screen.getByText('upload')).toBeInTheDocument();
      expect(screen.getByText('running')).toBeInTheDocument();
      expect(screen.getByText('Phase: transferring')).toBeInTheDocument();
      expect(screen.getByText('Progress: 37.5%')).toBeInTheDocument();
      expect(screen.getByText('Transferred: 393216 / 1048576 bytes')).toBeInTheDocument();
      expect(screen.getByText('Rate: 65536 B/s')).toBeInTheDocument();
      expect(screen.getByText('ETA: 10s')).toBeInTheDocument();
      expect(screen.getByText('Reason: network_retry retrying chunk')).toBeInTheDocument();
    });
  });

  it('renders transfer action buttons by transfer state', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              { transferId: 'tr-running', direction: 'upload', state: 'running', sessionId: 'session-1', updatedAt: '2026-04-21T00:00:00.000Z' },
              { transferId: 'tr-finished', direction: 'download', state: 'succeeded', sessionId: null, updatedAt: '2026-04-21T00:01:00.000Z' },
              { transferId: 'tr-orphan', direction: 'upload', state: 'running', sessionId: null, updatedAt: '2026-04-21T00:02:00.000Z' },
            ],
          }),
        });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Force remove' })).toHaveLength(1);
    });
  });

  it('stops transfer and sends csrf token payload', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return {
          getAttribute: () => 'csrf-123',
        } as unknown as Element;
      }

      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=100') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              { transferId: 'tr-1', direction: 'upload', state: 'running', sessionId: 'session-1', updatedAt: '2026-04-21T00:00:00.000Z' },
            ],
          }),
        });
      }
      if (url === '/v1/file-transfers/stop' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, transferId: 'tr-1' }) });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers/stop', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-1', csrfToken: 'csrf-123' }),
      });
    });
  });

  it('dismisses terminal transfer and sends csrf token payload', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return {
          getAttribute: () => 'csrf-123',
        } as unknown as Element;
      }

      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              { transferId: 'tr-1', direction: 'upload', state: 'succeeded', sessionId: null, updatedAt: '2026-04-21T00:00:00.000Z' },
            ],
          }),
        });
      }
      if (url === '/v1/file-transfers/dismiss' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, transferId: 'tr-1' }) });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers/dismiss', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-1', csrfToken: 'csrf-123' }),
      });
    });
  });

  it('force removes orphan transfer and sends csrf token payload', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return {
          getAttribute: () => 'csrf-123',
        } as unknown as Element;
      }

      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              { transferId: 'tr-1', direction: 'upload', state: 'running', sessionId: null, updatedAt: '2026-04-21T00:00:00.000Z' },
            ],
          }),
        });
      }
      if (url === '/v1/file-transfers/force-remove' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, transferId: 'tr-1' }) });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Force remove' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Force remove' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers/force-remove', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-1', csrfToken: 'csrf-123' }),
      });
    });
  });

  it('disables active transfer action button while request is in flight', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return {
          getAttribute: () => 'csrf-123',
        } as unknown as Element;
      }

      return null;
    });

    const resolveStopRef: { current: (() => void) | null } = { current: null };
    const stopPromise = new Promise<{ ok: boolean; transferId: string }>((resolve) => {
      resolveStopRef.current = () => resolve({ ok: true, transferId: 'tr-1' });
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              { transferId: 'tr-1', direction: 'upload', state: 'running', sessionId: 'session-1', updatedAt: '2026-04-21T00:00:00.000Z' },
            ],
          }),
        });
      }
      if (url === '/v1/file-transfers/stop' && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => stopPromise });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    const stopButton = await screen.findByRole('button', { name: 'Stop' });
    expect(stopButton).not.toBeDisabled();

    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Stop…' })).toBeDisabled();
    });

    resolveStopRef.current?.();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled();
    });
  });

  it('shows transfer activity error when transfers fetch fails', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }),
        });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({ ok: false, json: async () => ({}) });
      }

      return Promise.resolve({ ok: false, json: async () => ({}) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => {
      expect(screen.getByText('Failed to load transfers')).toBeInTheDocument();
    });
  });

  it('shows Resuming… label while resume action is in flight', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-123' } as unknown as Element;
      }
      return null;
    });

    const resolveResumeRef: { current: (() => void) | null } = { current: null };
    const resumePromise = new Promise<{ ok: boolean; command: { commandId: string } }>((resolve) => {
      resolveResumeRef.current = () => resolve({ ok: true, command: { commandId: 'cmd-r1' } });
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'failed', updatedAt: '2026-04-21T00:00:00.000Z', resumeSupported: true, resumeToken: 'resume-1', resumeOffsetBytes: 100, tempPathHint: '/tmp/a.partial', localPath: '/tmp/a', remotePath: '/var/a' }] }) });
      }
      if (url === '/v1/commands' && init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => resumePromise });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resuming…' })).toBeDisabled();
    });

    resolveResumeRef.current?.();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    });
  });

  it('shows Clearing… label while clear finished action is in flight', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-123' } as unknown as Element;
      }
      return null;
    });

    const resolveClearRef: { current: (() => void) | null } = { current: null };
    const clearPromise = new Promise<{ ok: boolean; deletedCount: number }>((resolve) => {
      resolveClearRef.current = () => resolve({ ok: true, deletedCount: 1 });
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') return Promise.resolve({ ok: true, json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'succeeded', updatedAt: '2026-04-21T00:00:00.000Z' }] }) });
      if (url === '/v1/file-transfers/dismiss-finished' && init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => clearPromise });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear finished' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Clear finished' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Clearing…' })).toBeDisabled();
    });

    resolveClearRef.current?.();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Clear finished' })).toBeInTheDocument();
    });
  });

  it('shows resume-unavailable guidance for failed transfer without resume metadata', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'failed', updatedAt: '2026-04-21T00:00:00.000Z', resumeSupported: true }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => {
      expect(screen.getByText('Resume unavailable: missing resume metadata.')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it('runs resume transfer action via command dispatch', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-123' } as unknown as Element;
      }
      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'failed', updatedAt: '2026-04-21T00:00:00.000Z', resumeSupported: true, resumeToken: 'resume-1', resumeOffsetBytes: 100, tempPathHint: '/tmp/a.partial', localPath: '/tmp/a', remotePath: '/var/a' }] }) });
      }
      if (url === '/v1/commands' && init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ ok: true, command: { commandId: 'cmd-r1' } }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/commands', expect.objectContaining({ method: 'POST' }));
    });
  });

  it('clears finished transfers from toolbar action', async () => {
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-123' } as unknown as Element;
      }
      return null;
    });

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') return Promise.resolve({ ok: true, json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'succeeded', updatedAt: '2026-04-21T00:00:00.000Z' }] }) });
      if (url === '/v1/file-transfers/dismiss-finished' && init?.method === 'POST') return Promise.resolve({ ok: true, json: async () => ({ ok: true, deletedCount: 1 }) });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /refresh transfers/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear finished' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Clear finished' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/file-transfers/dismiss-finished', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-1', csrfToken: 'csrf-123' }),
      });
    });
  });

  it('shows transfer activity guidance when no device is selected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => initialDevices,
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Transfer Activity' })).not.toBeInTheDocument();
    });
  });

  it('renders telemetry for selected device', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
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
    render(<App />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Telemetry' })).toBeInTheDocument();
      expect(screen.getByText('function_status')).toBeInTheDocument();
      expect(screen.getByText('vpn-agent')).toBeInTheDocument();
    });

    const telemetrySection = screen.getByRole('heading', { name: 'Telemetry' }).closest('section');
    expect(telemetrySection).toHaveClass('panel-section');
    expect(telemetrySection).toHaveClass('telemetry-section');
    expect(screen.getByLabelText('Type')).toHaveClass('telemetry-filter-input');
    expect(screen.getByLabelText('Search')).toHaveClass('telemetry-filter-input');
    expect(screen.getByLabelText('From')).toHaveClass('telemetry-filter-input');
    expect(screen.getByLabelText('To')).toHaveClass('telemetry-filter-input');
    expect(screen.getByRole('link', { name: 'Export telemetry' })).toHaveClass('telemetry-export-link');
    expect(screen.getByText('function_status').closest('li')).toHaveClass('telemetry-row');
  });

  it('renders telemetry list as table-like rows', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: 'evt-1', type: 'function_status', ts: '2026-04-21T00:00:00.000Z', functionId: 'vpn-agent', payload: { state: 'up', detail: 'abcdefghijklmnopqrstuvwxyz0123456789' } },
            { id: 'evt-2', type: 'transfer', ts: '2026-04-21T00:00:01.000Z', functionId: 'file-ops', payload: { step: 2 } },
          ],
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).not.toHaveLength(0);
      expect(screen.getAllByText(/2026-04-21 07:00:0[01] GMT\+7/)).not.toHaveLength(0);
    });

    const firstTelemetryRow = screen.getAllByText('function_status')[0]?.closest('li');
    const secondTelemetryRow = screen.getAllByText('transfer')[0]?.closest('li');
    expect(firstTelemetryRow).toHaveClass('telemetry-row');
    expect(secondTelemetryRow).toHaveClass('telemetry-row');
    const firstPreview = firstTelemetryRow?.querySelectorAll('span')?.[2] as HTMLSpanElement | undefined;
    const secondPreview = secondTelemetryRow?.querySelectorAll('span')?.[2] as HTMLSpanElement | undefined;
    expect(firstPreview?.getAttribute('title') || '').toContain('detail');
    expect(secondPreview?.getAttribute('title') || '').toContain('step');
    expect(firstPreview?.textContent || '').toContain('…');
    expect(screen.getByRole('button', { name: '1 function_status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 transfer' })).toBeInTheDocument();
    expect(screen.queryByText('No data to chart')).not.toBeInTheDocument();

    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob://json');
    const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const createElementSpy = vi.spyOn(document, 'createElement');

    const transferChip = screen.getByRole('button', { name: '1 transfer' });

    fireEvent.click(transferChip);
    expect(transferChip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('transfer')).not.toHaveLength(0);
    expect(screen.queryByText('function_status')).not.toBeInTheDocument();

    createObjectUrlSpy.mockReset();
    createObjectUrlSpy.mockReturnValue('blob://filtered-json');
    fireEvent.click(screen.getByText('Export JSON'));
    const filteredJsonBlob = createObjectUrlSpy.mock.calls[0]?.[0] as Blob;
    expect(filteredJsonBlob.type).toBe('application/json');

    createObjectUrlSpy.mockReset();
    createObjectUrlSpy.mockReturnValue('blob://filtered-csv');
    fireEvent.click(screen.getByText('Export CSV'));
    const filteredCsvBlob = createObjectUrlSpy.mock.calls[0]?.[0] as Blob;
    expect(filteredCsvBlob.type).toBe('text/csv');
    expect(filteredCsvBlob.size).toBeGreaterThan(0);

    expect(screen.getByText('Export JSON')).toBeEnabled();
    expect(screen.getByText('Export CSV')).toBeEnabled();

    createObjectUrlSpy.mockReset();
    fireEvent.click(transferChip);
    expect(transferChip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByText('Export JSON'));
    expect((createObjectUrlSpy.mock.calls[0]?.[0] as Blob).type).toBe('application/json');

    createObjectUrlSpy.mockReset();
    createObjectUrlSpy.mockReturnValue('blob://none');
    fireEvent.click(screen.getByRole('button', { name: '1 function_status' }));
    fireEvent.click(screen.getByText('Export CSV'));
    expect(createObjectUrlSpy).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '1 function_status' }));
    expect(screen.getByText('Export JSON')).toBeEnabled();
    expect(screen.getByText('Export CSV')).toBeEnabled();

    fireEvent.click(transferChip);
    expect(transferChip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('transfer')).not.toHaveLength(0);
    expect(screen.queryByText('function_status')).not.toBeInTheDocument();

    fireEvent.click(transferChip);
    expect(transferChip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('function_status')).toBeInTheDocument();
    expect(screen.getByText('transfer')).toBeInTheDocument();

    expect(screen.getAllByText('▼')).toHaveLength(2);
    expect(screen.getByText('Export JSON')).toBeEnabled();
    expect(screen.getByText('Export CSV')).toBeEnabled();

    createObjectUrlSpy.mockReset();
    createObjectUrlSpy.mockReturnValue('blob://json');
    fireEvent.click(screen.getByText('Export JSON'));
    const exportAnchor = createElementSpy.mock.results
      .map((item) => item.value)
      .find((node) => node instanceof HTMLAnchorElement) as HTMLAnchorElement;
    expect(createObjectUrlSpy).toHaveBeenCalled();
    expect(exportAnchor.download).toMatch(/^telemetry-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob://json');

    createObjectUrlSpy.mockReset();
    createObjectUrlSpy.mockReturnValue('blob://csv');
    fireEvent.click(screen.getByText('Export CSV'));
    const csvAnchor = createElementSpy.mock.results
      .map((item) => item.value)
      .find((node) => node instanceof HTMLAnchorElement && (node as HTMLAnchorElement).download.endsWith('.csv')) as HTMLAnchorElement;
    expect(csvAnchor.download).toMatch(/^telemetry-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);

    const csvBlob = createObjectUrlSpy.mock.calls[0]?.[0] as Blob;
    expect(csvBlob.type).toBe('text/csv');
    expect(csvBlob.size).toBeGreaterThan(0);
    expect(csvAnchor.download).toMatch(/^telemetry-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob://csv');

    createObjectUrlSpy.mockRestore();
    revokeObjectUrlSpy.mockRestore();
    createElementSpy.mockRestore();

    const detailButtons = screen.getAllByRole('button', { name: 'Toggle detail' });
    fireEvent.click(detailButtons[0] as HTMLElement);
    expect(screen.getAllByText('▲')).toHaveLength(1);
    expect(screen.getByText(/detail":"…/)).toBeInTheDocument();
    expect(screen.getByText(/"id": "evt-1"/)).toBeInTheDocument();
    expect(screen.getByText(/"payload": \{/)).toBeInTheDocument();
    expect(screen.getByText(/"state": "up"/)).toBeInTheDocument();
    fireEvent.click(detailButtons[0] as HTMLElement);
    expect(screen.queryByText(/"id": "evt-1"/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"state": "up"/)).not.toBeInTheDocument();

  });

  it('shows empty chart state when telemetry list is empty', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('No telemetry matched the current filters.')).toBeInTheDocument();
      expect(screen.getByText('No data to chart')).toBeInTheDocument();
      expect(screen.getByText('Export JSON')).toBeDisabled();
      expect(screen.getByText('Export CSV')).toBeDisabled();
    });
  });

  it('disables export telemetry link when no device is selected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => initialDevices }));

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Export telemetry' })).not.toBeInTheDocument();
    });
  });

  it('renders telemetry chart summary text when events exist', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') {
        return Promise.resolve({ ok: true, json: async () => [{ id: 'evt-1', type: 'function_status', ts: '2026-04-21T00:00:00.000Z', functionId: 'vpn-agent', payload: { ok: true } }] });
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('Chart summary')).toBeInTheDocument();
      expect(screen.getByText('function_status: 1')).toBeInTheDocument();
    });
  });


  it('applies telemetry filters in the telemetry request', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=100') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=100&type=function_status&q=vpn') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'function_status' } });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'vpn' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-04-20T00:00:00.000Z' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-04-21T00:00:00.000Z' } });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/logs?deviceId=dev-1&limit=100&type=function_status&q=vpn&fromTs=2026-04-20T00%3A00%3A00.000Z&toTs=2026-04-21T00%3A00%3A00.000Z', {
        credentials: 'same-origin',
      });
    });
  });

  it('updates telemetry export link with telemetry filters', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({ ok: true, json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-21T00:00:00.000Z', functions: {} }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=100') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=100&type=function_status&q=vpn') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'function_status' } });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'vpn' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-04-20T00:00:00.000Z' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-04-21T00:00:00.000Z' } });

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Export telemetry' })).toHaveAttribute(
        'href',
        '/v1/logs/export?deviceId=dev-1&limit=100&type=function_status&q=vpn&fromTs=2026-04-20T00%3A00%3A00.000Z&toTs=2026-04-21T00%3A00%3A00.000Z',
      );
    });
  });

  it('shows telemetry guidance when no device is selected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => initialDevices,
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Telemetry' })).not.toBeInTheDocument();
    });
  });

  it('loads and renders read-only device rows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => initialDevices,
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
      expect(screen.getByText('Device Two')).toBeInTheDocument();
    });

    expect(screen.getByText('connected')).toBeInTheDocument();
    expect(screen.getByText('disconnected')).toBeInTheDocument();
  });

  it('fetches selected-device snapshot and renders it after selecting a row', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => initialDevices,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'dev-1',
          name: 'Device One',
          status: 'connected',
          os: 'linux',
          lastSeenAt: '2026-04-18T00:00:00.000Z',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {},
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    expect(screen.queryByRole('heading', { name: 'Device Details' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1', { credentials: 'same-origin' });
    });

    const detailsSection = screen.getByRole('heading', { name: 'Device Details' }).closest('section');
    expect(detailsSection).not.toBeNull();
    const details = within(detailsSection as HTMLElement);
    expect(details.getByText('dev-1')).toBeInTheDocument();
    expect(details.getByText('linux')).toBeInTheDocument();
  });

  it('shows snapshot error state when selected-device fetch fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => initialDevices,
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {},
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device Two')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('Failed to load selected device details')).toBeInTheDocument();
    });
  });

  it('switches selected-device snapshot when selecting another row', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }

      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: 'dev-1',
            name: 'Device One',
            status: 'connected',
            os: 'linux',
            lastSeenAt: '2026-04-18T00:00:00.000Z',
          }),
        });
      }

      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }),
        });
      }

      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }

      if (url === '/v1/devices/dev-2') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: 'dev-2',
            name: 'Device Two',
            status: 'disconnected',
            os: null,
            lastSeenAt: null,
          }),
        });
      }

      if (url === '/v1/device-summary?deviceId=dev-2') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-2', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }),
        });
      }

      if (url === '/v1/logs?deviceId=dev-2&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      if (url === '/v1/commands?deviceId=dev-2&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }

      return Promise.resolve({ ok: false, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1', { credentials: 'same-origin' });
    });

    fireEvent.click(screen.getByRole('button', { name: /select device two/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-2', { credentials: 'same-origin' });
    });

    await waitFor(() => {
      const detailsSection = screen.getByRole('heading', { name: 'Device Details' }).closest('section');
      expect(detailsSection).not.toBeNull();
      const details = within(detailsSection as HTMLElement);
      expect(details.getByText('dev-2')).toBeInTheDocument();
    });
  });

  it('ignores stale selected-device responses when switching quickly', async () => {
    let resolveDev1Details: ((value: PendingDeviceResponse) => void) | undefined;
    const pendingDev1Details = new Promise<PendingDeviceResponse>((resolve) => {
      resolveDev1Details = resolve;
    });

    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }

      if (url === '/v1/devices/dev-1') {
        return pendingDev1Details;
      }

      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }),
        });
      }

      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }

      if (url === '/v1/devices/dev-2') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: 'dev-2',
            name: 'Device Two',
            status: 'disconnected',
            os: null,
            lastSeenAt: null,
          }),
        });
      }

      if (url === '/v1/device-summary?deviceId=dev-2') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-2', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }),
        });
      }

      if (url === '/v1/logs?deviceId=dev-2&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      if (url === '/v1/commands?deviceId=dev-2&limit=20') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }

      return Promise.resolve({ ok: false, json: async () => ({}) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));
    fireEvent.click(screen.getByRole('button', { name: /select device two/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-2', { credentials: 'same-origin' });
    });

    let detailsSection = screen.getByRole('heading', { name: 'Device Details' }).closest('section');
    expect(detailsSection).not.toBeNull();
    let details = within(detailsSection as HTMLElement);
    expect(details.getByText('dev-2')).toBeInTheDocument();

    resolveDev1Details?.({
      ok: true,
      json: async () => ({
        id: 'dev-1',
        name: 'Device One',
        status: 'connected',
        os: 'linux',
        lastSeenAt: '2026-04-18T00:00:00.000Z',
      }),
    });

    await waitFor(() => {
      detailsSection = screen.getByRole('heading', { name: 'Device Details' }).closest('section');
      expect(detailsSection).not.toBeNull();
      details = within(detailsSection as HTMLElement);
      expect(details.queryByText('dev-1')).not.toBeInTheDocument();
      expect(details.getByText('dev-2')).toBeInTheDocument();
    });
  });

  it('loads and renders command history for selected device', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => initialDevices,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'dev-1',
          name: 'Device One',
          status: 'connected',
          os: 'linux',
          lastSeenAt: '2026-04-18T00:00:00.000Z',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {},
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
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

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device One')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/commands?deviceId=dev-1&limit=20', {
        credentials: 'same-origin',
      });
    });

    expect(screen.getByRole('heading', { name: 'Command History' })).toBeInTheDocument();
    expect(screen.getByText('request_status_snapshot')).toBeInTheDocument();
    expect(screen.getByText('queued')).toBeInTheDocument();
  });

  it('refreshes device list from server', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => initialDevices,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          ...initialDevices,
          { id: 'dev-3', name: 'Device Three', status: 'connected', os: 'windows', lastSeenAt: null },
        ]),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Device Two')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /refresh devices/i }));

    await waitFor(() => {
      expect(screen.getByText('Device Three')).toBeInTheDocument();
    });
  });

  it('shows empty state when runtime summary has no functions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices })
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices[0] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {},
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('No functions reported.')).toBeInTheDocument();
    });
  });

  it('fetches and renders runtime summary for selected device', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices })
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices[0] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {
            'vpn-agent': { state: 'running', message: 'ok' },
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/device-summary?deviceId=dev-1', {
        credentials: 'same-origin',
      });
    });

    const summarySection = screen.getByRole('heading', { name: 'Runtime Summary' }).closest('section');
    expect(summarySection).not.toBeNull();
    const summary = within(summarySection as HTMLElement);
    expect(summary.getByText('vpn-agent')).toBeInTheDocument();
    expect(summary.getAllByText(/running/i).length).toBeGreaterThan(0);
  });

  it('renders visible timestamps in GMT+7 across device details, runtime, logs, commands, transfers, and telemetry', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: '2026-04-18T00:00:00.000Z' }],
        });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: '2026-04-18T00:00:00.000Z' }),
        });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: { 'vpn-agent': { state: 'running' } } }),
        });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 'log-1', ts: '2026-04-20T00:00:00.000Z', type: 'recent_logs', functionId: 'vpn-agent' }],
        });
      }
      if (url === '/v1/commands?deviceId=dev-1&limit=20') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              {
                commandId: 'cmd-1',
                commandType: 'request_recent_logs',
                state: 'succeeded',
                submittedAt: '2026-04-20T00:00:00.000Z',
                finishedAt: '2026-04-20T00:01:00.000Z',
                actorType: 'admin_session',
              },
            ],
          }),
        });
      }
      if (url === '/v1/commands/cmd-1/audit') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [{ eventType: 'queued', ts: '2026-04-20T00:02:00.000Z', summary: 'Queued' }] }),
        });
      }
      if (url === '/v1/file-transfers?deviceId=dev-1&limit=50') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [{ transferId: 'tr-1', direction: 'upload', state: 'running', sessionId: 'sess-1', updatedAt: '2026-04-21T00:00:00.000Z' }] }),
        });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=100') {
        return Promise.resolve({
          ok: true,
          json: async () => [{ id: 'tlm-1', ts: '2026-04-22T00:00:00.000Z', type: 'function-status', functionId: 'vpn-agent', payload: { ok: true } }],
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getAllByText('2026-04-18 07:00:00 GMT+7').length).toBeGreaterThan(0);
      expect(screen.getByText('Updated: 2026-04-20 07:00:00 GMT+7')).toBeInTheDocument();
      expect(screen.getAllByText('2026-04-20 07:00:00 GMT+7').length).toBeGreaterThan(0);
      expect(screen.getByText('Submitted: 2026-04-20 07:00:00 GMT+7')).toBeInTheDocument();
      expect(screen.getByText('Finished: 2026-04-20 07:01:00 GMT+7')).toBeInTheDocument();
      expect(screen.getByText(/queued/)).toBeInTheDocument();
      expect(screen.getByText('2026-04-22 07:00:00 GMT+7')).toBeInTheDocument();
    });
  });

  it('shows runtime summary error and retries on demand', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices })
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices[0] })
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {
            'vpn-agent': { state: 'running', message: 'ok' },
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('Failed to load runtime summary')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /retry runtime summary/i }));

    await waitFor(() => {
      expect(screen.getByText('vpn-agent')).toBeInTheDocument();
      expect(screen.queryByText('Failed to load runtime summary')).not.toBeInTheDocument();
    });
  });


  it('shows start action for idle tunnel and stop action for running tunnel', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            deviceId: 'dev-1',
            updatedAt: '2026-04-20T00:00:00.000Z',
            functions: {
              'server-tunnel-srv-2': {
                state: 'running',
                message: 'Tunnel active',
              },
            },
            inventory: {
              servers: [
                { id: 'srv-1', name: 'Idle Tunnel', connectionMethod: 'boundary', host: '127.0.0.1' },
                { id: 'srv-2', name: 'Running Tunnel', connectionMethod: 'boundary', host: '127.0.0.2' },
              ],
            },
          }),
        });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    const summarySection = await screen.findByRole('heading', { name: 'Runtime Summary' });
    const summary = within(summarySection.closest('section') as HTMLElement);

    await waitFor(() => {
      expect(summary.getByRole('button', { name: 'Start tunnel for Idle Tunnel' })).toBeInTheDocument();
      expect(summary.getByRole('button', { name: 'Stop tunnel for Running Tunnel' })).toBeInTheDocument();
    });
  });

  it('can load dedicated tunnel logs from runtime summary', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') return Promise.resolve({ ok: true, json: async () => initialDevices });
      if (url === '/v1/devices/dev-1') return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            deviceId: 'dev-1',
            updatedAt: '2026-04-20T00:00:00.000Z',
            functions: {
              'server-tunnel-srv-1': {
                state: 'running',
                message: 'Tunnel active',
                sessionId: 'sess-1',
              },
            },
            inventory: {
              servers: [
                { id: 'srv-1', name: 'Running Tunnel', connectionMethod: 'boundary', host: '127.0.0.1' },
              ],
            },
          }),
        });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/v1/commands?deviceId=dev-1&limit=20') return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      if (url === '/v1/logs?deviceId=dev-1&limit=100') return Promise.resolve({ ok: true, json: async () => [] });
      if (url.includes('/tunnels/srv-1/logs')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            entries: [
              { ts: '2026-04-23T03:33:23.000Z', sessionId: 'sess-1', data: 'Tunnel connected' },
              { ts: '2026-04-23T03:33:24.000Z', sessionId: 'sess-1', data: 'Listening on 6222' },
            ],
            total: 2,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    const summarySection = await screen.findByRole('heading', { name: 'Runtime Summary' });
    const summary = within(summarySection.closest('section') as HTMLElement);

    await waitFor(() => {
      expect(summary.getByRole('button', { name: 'View logs for Running Tunnel' })).toBeInTheDocument();
    });

    fireEvent.click(summary.getByRole('button', { name: 'View logs for Running Tunnel' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/tunnels/srv-1/logs?limit=200&offset=0', {
        credentials: 'same-origin',
      });
      expect(summary.getByLabelText('Tunnel logs')).toHaveTextContent('Tunnel connected');
      expect(summary.getByLabelText('Tunnel logs')).toHaveTextContent('Listening on 6222');
    });
  });

  it('shows loading placeholders while recent logs are loading', async () => {
    let resolveLogs: ((value: PendingLogsResponse) => void) | undefined;
    const pendingLogs = new Promise<PendingLogsResponse>((resolve) => {
      resolveLogs = resolve;
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices })
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices[0] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {},
        }),
      })
      .mockImplementationOnce(() => pendingLogs);
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('Loading recent logs preview…')).toBeInTheDocument();
      expect(screen.getByLabelText('Recent logs loading placeholders')).toBeInTheDocument();
    });

    resolveLogs?.({ ok: true, json: async () => [] });

    await waitFor(() => {
      expect(screen.queryByText('Loading recent logs preview…')).not.toBeInTheDocument();
    });
  });

  it('shows empty state when selected device has no recent logs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices })
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices[0] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {},
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('No recent logs.')).toBeInTheDocument();
    });
  });

  it('fetches and renders recent logs preview for selected device', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices })
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices[0] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {},
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          {
            id: 'log-1',
            ts: '2026-04-20T00:00:10.000Z',
            type: 'function_status',
            functionId: 'vpn-agent',
            payload: { state: 'running' },
          },
        ]),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/logs?deviceId=dev-1&limit=20', {
        credentials: 'same-origin',
      });
    });

    expect(screen.getByRole('heading', { name: 'Recent Logs' })).toBeInTheDocument();
    expect(screen.getByText('function_status')).toBeInTheDocument();
    expect(screen.getByText('vpn-agent')).toBeInTheDocument();
  });

  it('shows recent logs error and retries logs fetch on demand', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices })
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices[0] })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {},
        }),
      })
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          {
            id: 'log-2',
            ts: '2026-04-20T00:01:00.000Z',
            type: 'function_status',
            functionId: 'vpn-agent',
            payload: { state: 'running' },
          },
        ]),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('Failed to load recent logs')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /retry recent logs/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/logs?deviceId=dev-1&limit=20', {
        credentials: 'same-origin',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('2026-04-20 07:01:00 GMT+7')).toBeInTheDocument();
      expect(screen.queryByText('Failed to load recent logs')).not.toBeInTheDocument();
    });
  });

  it('keeps logs rendered while runtime summary is still loading', async () => {
    let resolveSummary: ((value: PendingSummaryResponse) => void) | undefined;
    const pendingSummary = new Promise<PendingSummaryResponse>((resolve) => {
      resolveSummary = resolve;
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices })
      .mockResolvedValueOnce({ ok: true, json: async () => initialDevices[0] })
      .mockImplementationOnce(() => pendingSummary)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          {
            id: 'log-1',
            ts: '2026-04-20T00:00:10.000Z',
            type: 'function_status',
            functionId: 'vpn-agent',
            payload: { state: 'running' },
          },
        ]),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(screen.getByText('Loading runtime summary…')).toBeInTheDocument();
      expect(screen.getByText('function_status')).toBeInTheDocument();
    });

    resolveSummary?.({
      ok: true,
      json: async () => ({
        deviceId: 'dev-1',
        updatedAt: '2026-04-20T00:00:00.000Z',
        functions: {},
      }),
    });

    await waitFor(() => {
      expect(screen.queryByText('Loading runtime summary…')).not.toBeInTheDocument();
    });
  });

  it('ignores stale runtime summary responses when switching quickly', async () => {
    let resolveDev1Summary: ((value: PendingSummaryResponse) => void) | undefined;
    const pendingDev1Summary = new Promise<PendingSummaryResponse>((resolve) => {
      resolveDev1Summary = resolve;
    });

    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return pendingDev1Summary;
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/v1/devices/dev-2') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: 'dev-2', name: 'Device Two', status: 'disconnected', os: null, lastSeenAt: null }),
        });
      }
      if (url === '/v1/device-summary?deviceId=dev-2') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            deviceId: 'dev-2',
            updatedAt: '2026-04-20T00:00:00.000Z',
            functions: { 'dev-2-fn': { state: 'running' } },
          }),
        });
      }
      if (url === '/v1/logs?deviceId=dev-2&limit=20') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/device-summary?deviceId=dev-1', {
        credentials: 'same-origin',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /select device two/i }));

    await waitFor(() => {
      expect(screen.getByText('dev-2-fn')).toBeInTheDocument();
    });

    resolveDev1Summary?.({
      ok: true,
      json: async () => ({
        deviceId: 'dev-1',
        updatedAt: '2026-04-20T00:00:00.000Z',
        functions: { 'dev-1-fn': { state: 'running' } },
      }),
    });

    await waitFor(() => {
      expect(screen.queryByText('dev-1-fn')).not.toBeInTheDocument();
      expect(screen.getByText('dev-2-fn')).toBeInTheDocument();
    });
  });

  it('ignores stale recent logs responses when switching quickly', async () => {
    let resolveDev1Logs: ((value: PendingLogsResponse) => void) | undefined;
    const pendingDev1Logs = new Promise<PendingLogsResponse>((resolve) => {
      resolveDev1Logs = resolve;
    });

    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/devices') {
        return Promise.resolve({ ok: true, json: async () => initialDevices });
      }
      if (url === '/v1/devices/dev-1') {
        return Promise.resolve({ ok: true, json: async () => initialDevices[0] });
      }
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-1', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }),
        });
      }
      if (url === '/v1/logs?deviceId=dev-1&limit=20') {
        return pendingDev1Logs;
      }
      if (url === '/v1/devices/dev-2') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: 'dev-2', name: 'Device Two', status: 'disconnected', os: null, lastSeenAt: null }),
        });
      }
      if (url === '/v1/device-summary?deviceId=dev-2') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ deviceId: 'dev-2', updatedAt: '2026-04-20T00:00:00.000Z', functions: {} }),
        });
      }
      if (url === '/v1/logs?deviceId=dev-2&limit=20') {
        return Promise.resolve({
          ok: true,
          json: async () => ([
            {
              id: 'dev2-log',
              ts: '2026-04-20T00:02:00.000Z',
              type: 'function_status',
              functionId: 'dev-2-fn',
              payload: { state: 'running' },
            },
          ]),
        });
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    await waitFor(() => expect(screen.getByText('Device One')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/v1/logs?deviceId=dev-1&limit=20', {
        credentials: 'same-origin',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /select device two/i }));

    await waitFor(() => {
      expect(screen.getByText('dev-2-fn')).toBeInTheDocument();
    });

    resolveDev1Logs?.({
      ok: true,
      json: async () => ([
        {
          id: 'dev1-log',
          ts: '2026-04-20T00:03:00.000Z',
          type: 'function_status',
          functionId: 'dev-1-fn',
          payload: { state: 'running' },
        },
      ]),
    });

    await waitFor(() => {
      expect(screen.queryByText('dev1-log')).not.toBeInTheDocument();
      expect(screen.getByText('dev-2-fn')).toBeInTheDocument();
    });
  });
});
