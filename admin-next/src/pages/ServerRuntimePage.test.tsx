import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerRuntimePage } from './ServerRuntimePage';

vi.mock('../components/SshTerminalPanel', () => ({
  SshTerminalPanel: ({ terminal, title }: { terminal: { sessionId: string } | null; title?: string }) => (
    <div aria-label={title || 'SSH Terminal'}>{terminal ? `SSH session ${terminal.sessionId}` : 'No terminal'}</div>
  ),
}));

function renderServerRuntimePage() {
  return render(
    <MemoryRouter initialEntries={['/admin/devices/dev-1/servers/srv-1/runtime']}>
      <Routes>
        <Route path="/admin/devices/:deviceId/servers/:serverId/runtime" element={<ServerRuntimePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ServerRuntimePage', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.head.innerHTML = '';
  });

  it('loads only the selected server runtime data and renders tunnel logs on a dedicated URL', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            deviceId: 'dev-1',
            updatedAt: '2026-05-05T04:47:29.071Z',
            functions: {
              'server-tunnel-srv-1': { state: 'running', message: 'Tunnel active' },
            },
            inventory: {
              servers: [
                { id: 'srv-1', name: 'Boundary Alpha', connectionMethod: 'boundary', host: '127.0.0.1' },
                { id: 'srv-2', name: 'Boundary Beta', connectionMethod: 'boundary', host: '127.0.0.2' },
              ],
            },
          }),
        });
      }
      if (url === '/v1/devices/dev-1/tunnels/srv-1/logs?limit=200&offset=0') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            entries: [
              { ts: '2026-05-05T04:47:00.000Z', sessionId: 'tun-1', data: 'Older tunnel log' },
              { ts: '2026-05-05T04:48:00.000Z', sessionId: 'tun-1', data: 'Newest tunnel log' },
              { ts: '2026-05-05T04:49:00.000Z', sessionId: 'tun-1', data: '\n \t' },
            ],
            total: 3,
          }),
        });
      }
      if (url === '/v1/devices/dev-1/pty-sessions') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [{ sessionId: 'ccpty:dev-1:pty-srv-1', serverId: 'srv-1', state: 'open' }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderServerRuntimePage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Boundary Alpha runtime' })).toBeInTheDocument());
    expect(screen.getByText('Device dev-1')).toBeInTheDocument();
    expect(screen.getByText('Older tunnel log')).toBeInTheDocument();
    expect(screen.getByText('Newest tunnel log')).toBeInTheDocument();
    expect(screen.getByText('[whitespace-only log payload: "\\n \\t"]')).toBeInTheDocument();
    const logItems = screen.getAllByRole('listitem');
    expect(logItems[0]).toHaveTextContent('[whitespace-only log payload: "\\n \\t"]');
    expect(logItems[1]).toHaveTextContent('Newest tunnel log');
    expect(logItems[2]).toHaveTextContent('Older tunnel log');
    expect(screen.getByLabelText('SSH terminal for Boundary Alpha')).toHaveTextContent('SSH session ccpty:dev-1:pty-srv-1');
    expect(fetchMock).not.toHaveBeenCalledWith('/v1/devices', expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith('/v1/logs?deviceId=dev-1&limit=20', expect.anything());
    expect(screen.queryByText('Boundary Beta runtime')).not.toBeInTheDocument();
  });

  it('starts an SSH terminal from the dedicated runtime page', async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="csrf-123" />';
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            deviceId: 'dev-1',
            updatedAt: '2026-05-05T04:47:29.071Z',
            functions: {
              'server-tunnel-srv-1': { state: 'running', message: 'Tunnel active' },
            },
            inventory: { servers: [{ id: 'srv-1', name: 'Boundary Alpha', connectionMethod: 'boundary', host: '127.0.0.1' }] },
          }),
        });
      }
      if (url === '/v1/devices/dev-1/tunnels/srv-1/logs?limit=200&offset=0') {
        return Promise.resolve({ ok: true, json: async () => ({ entries: [], total: 0 }) });
      }
      if (url === '/v1/devices/dev-1/pty-sessions') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      if (url === '/v1/devices/dev-1/request-start-server-ssh' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ok: true,
            deviceId: 'dev-1',
            serverId: 'srv-1',
            sessionId: 'ccpty:dev-1:33333333-3333-4333-8333-333333333333',
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderServerRuntimePage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Boundary Alpha runtime' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Start SSH terminal' }));

    await waitFor(() =>
      expect(screen.getByLabelText('SSH terminal for Boundary Alpha')).toHaveTextContent(
        'SSH session ccpty:dev-1:33333333-3333-4333-8333-333333333333',
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/request-start-server-ssh', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ csrfToken: 'csrf-123', serverId: 'srv-1', cols: 120, rows: 32 }),
    }));
  });

  it('renders tunnel logs and SSH terminal inside a shared live workspace layout', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            deviceId: 'dev-1',
            updatedAt: '2026-05-05T04:47:29.071Z',
            functions: {
              'server-tunnel-srv-1': { state: 'running', message: 'Tunnel active' },
            },
            inventory: {
              servers: [{ id: 'srv-1', name: 'Boundary Alpha', connectionMethod: 'boundary', host: '127.0.0.1' }],
            },
          }),
        });
      }
      if (url === '/v1/devices/dev-1/tunnels/srv-1/logs?limit=200&offset=0') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            entries: [{ ts: '2026-05-05T04:48:00.000Z', sessionId: 'tun-1', data: 'Tunnel connected' }],
            total: 1,
          }),
        });
      }
      if (url === '/v1/devices/dev-1/pty-sessions') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [{ sessionId: 'ccpty:dev-1:pty-srv-1', serverId: 'srv-1', state: 'open' }] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderServerRuntimePage();

    const logsSection = await screen.findByRole('region', { name: 'Tunnel logs' });
    const sshTerminal = await screen.findByLabelText('SSH terminal for Boundary Alpha');
    const workspace = document.querySelector('.runtime-summary-live-workspace');

    expect(workspace).toBeTruthy();
    expect(logsSection.closest('.runtime-summary-live-pane')).toBeTruthy();
    expect(sshTerminal.closest('.runtime-summary-live-pane')).toBeTruthy();
  });

  it('refreshes runtime and tunnel logs from telemetry (tunnel-scoped PTY events only)', async () => {
    class MockEventSource {
      public onmessage: ((event: MessageEvent) => void) | null = null;
      private listeners = new Map<string, Set<(event: MessageEvent) => void>>();
      constructor(public readonly url: string, _init?: EventSourceInit) {}
      addEventListener(event: string, handler: EventListener) {
        const next = this.listeners.get(event) || new Set();
        next.add(handler as (event: MessageEvent) => void);
        this.listeners.set(event, next);
      }
      emit(event: string, payload?: unknown) {
        const messageEvent = { data: payload == null ? '' : JSON.stringify(payload) } as MessageEvent;
        this.listeners.get(event)?.forEach((handler) => handler(messageEvent));
        this.onmessage?.(messageEvent);
      }
      close() {}
    }

    const sources: MockEventSource[] = [];
    vi.stubGlobal('EventSource', class {
      constructor(url: string, init?: EventSourceInit) {
        const source = new MockEventSource(url, init);
        sources.push(source);
        return source;
      }
    });

    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            deviceId: 'dev-1',
            updatedAt: '2026-05-05T04:47:29.071Z',
            functions: {
              'server-tunnel-srv-1': { state: 'running', message: 'Tunnel active', sessionId: 'tun-1' },
            },
            inventory: { servers: [{ id: 'srv-1', name: 'Boundary Alpha', connectionMethod: 'boundary', host: '127.0.0.1' }] },
          }),
        });
      }
      if (url === '/v1/devices/dev-1/tunnels/srv-1/logs?limit=200&offset=0') {
        return Promise.resolve({ ok: true, json: async () => ({ entries: [{ ts: '2026-05-05T04:48:00.000Z', sessionId: 'tun-1', data: 'Tunnel connected' }], total: 1 }) });
      }
      if (url === '/v1/devices/dev-1/pty-sessions') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderServerRuntimePage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Boundary Alpha runtime' })).toBeInTheDocument());

    const runtimeCallsBefore = fetchMock.mock.calls.filter(([url]) => url === '/v1/device-summary?deviceId=dev-1').length;
    const logsCallsBefore = fetchMock.mock.calls.filter(([url]) => url === '/v1/devices/dev-1/tunnels/srv-1/logs?limit=200&offset=0').length;

    const telemetrySource = sources.find((source) => source.url.includes('/v1/logs/stream?deviceId=dev-1'));

    expect(telemetrySource).toBeTruthy();

    telemetrySource?.emit('telemetry', { type: 'function-status', deviceId: 'dev-1', payload: {} });
    telemetrySource?.emit('telemetry', { type: 'pty-output', deviceId: 'dev-1', sessionId: 'tun-1', payload: { data: 'new line' } });

    await waitFor(() => {
      const runtimeCallsAfter = fetchMock.mock.calls.filter(([url]) => url === '/v1/device-summary?deviceId=dev-1').length;
      const logsCallsAfter = fetchMock.mock.calls.filter(([url]) => url === '/v1/devices/dev-1/tunnels/srv-1/logs?limit=200&offset=0').length;
      expect(runtimeCallsAfter).toBeGreaterThan(runtimeCallsBefore);
      expect(logsCallsAfter).toBeGreaterThan(logsCallsBefore);
    });
  });

  it('does not poll tunnel logs on an interval while the tunnel is running', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let logRequests = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url === '/v1/device-summary?deviceId=dev-1') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            deviceId: 'dev-1',
            updatedAt: '2026-05-05T04:47:29.071Z',
            functions: {
              'server-tunnel-srv-1': { state: 'running', message: 'Tunnel active', sessionId: 'local-pty' },
            },
            inventory: { servers: [{ id: 'srv-1', name: 'Boundary Alpha', connectionMethod: 'boundary', host: '127.0.0.1' }] },
          }),
        });
      }
      if (url === '/v1/devices/dev-1/tunnels/srv-1/logs?limit=200&offset=0') {
        logRequests += 1;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            entries: [{ ts: '2026-05-05T04:48:00.000Z', sessionId: 't-1', data: `line-${logRequests}` }],
            total: 1,
          }),
        });
      }
      if (url === '/v1/devices/dev-1/pty-sessions') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderServerRuntimePage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Boundary Alpha runtime' })).toBeInTheDocument());
    const afterInitial = logRequests;
    expect(afterInitial).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(logRequests).toBe(afterInitial);
  });
});
