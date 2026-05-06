import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
          json: async () => ({ entries: [{ ts: '2026-05-05T04:48:00.000Z', sessionId: 'tun-1', data: 'Tunnel connected' }], total: 1 }),
        });
      }
      if (url === '/v1/devices/dev-1/pty-sessions') {
        return Promise.resolve({ ok: true, json: async () => ({ items: [{ sessionId: 'ssh-srv-1', serverId: 'srv-1', state: 'open' }] }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderServerRuntimePage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Boundary Alpha runtime' })).toBeInTheDocument());
    expect(screen.getByText('Device dev-1')).toBeInTheDocument();
    expect(screen.getByText('Tunnel connected')).toBeInTheDocument();
    expect(screen.getByLabelText('SSH terminal for Boundary Alpha')).toHaveTextContent('SSH session ssh-srv-1');
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
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'new-ssh-session' }) });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderServerRuntimePage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Boundary Alpha runtime' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Start SSH terminal' }));

    await waitFor(() => expect(screen.getByLabelText('SSH terminal for Boundary Alpha')).toHaveTextContent('SSH session new-ssh-session'));
    expect(fetchMock).toHaveBeenCalledWith('/v1/devices/dev-1/request-start-server-ssh', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ csrfToken: 'csrf-123', serverId: 'srv-1', cols: 120, rows: 32 }),
    }));
  });
});
