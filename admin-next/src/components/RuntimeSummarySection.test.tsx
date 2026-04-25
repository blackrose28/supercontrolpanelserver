import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { within } from '@testing-library/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./SshTerminalPanel', () => ({
  SshTerminalPanel: ({ title }: { title: string }) => <div aria-label={title} />,
}));

import { RuntimeSummarySection } from './RuntimeSummarySection';

describe('RuntimeSummarySection', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders helper copy, summary cards, and a tunnel log toolbar for the selected server', () => {
    const onRefreshTunnelLogs = vi.fn();

    render(
      <RuntimeSummarySection
        selectedDeviceId="dev-1"
        runtimeSummaryLoading={false}
        runtimeSummaryError={null}
        runtimeSummary={{
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {
            'vpn-agent': { state: 'running', message: 'healthy' },
            'server-tunnel-srv-1': { state: 'running', message: 'active' },
          },
          inventory: {
            servers: [
              { id: 'srv-1', name: 'Boundary Alpha', connectionMethod: 'boundary', host: '127.0.0.1' },
            ],
          },
        }}
        deviceActionLoadingId={null}
        selectedTunnelServerId="srv-1"
        tunnelLogs={[
          { ts: '2026-04-20T00:00:01.000Z', sessionId: 'sess-1', data: 'Tunnel connected' },
        ]}
        tunnelLogsLoading={false}
        tunnelLogsError={null}
        tunnelLogsTotal={1}
        onLoadMoreTunnelLogs={vi.fn()}
        onSelectTunnelServer={vi.fn()}
        onRefreshTunnelLogs={onRefreshTunnelLogs}
        onRequestStartServerTunnel={vi.fn()}
        onRequestStopServerTunnel={vi.fn()}
        onStartServerSshTerminal={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('Track live function health, Boundary tunnels, and the latest device runtime state.')).toBeInTheDocument();
    const highlights = screen.getByLabelText('Runtime summary highlights');
    expect(highlights).toHaveTextContent('Functions reporting');
    expect(highlights).toHaveTextContent('Boundary tunnels');
    expect(highlights).toHaveTextContent('Logs loaded');
    expect(highlights).toHaveTextContent('2');
    expect(highlights).toHaveTextContent('1');
    expect(screen.getByText('Boundary tunnel servers')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh tunnel logs' })).toHaveClass('runtime-toolbar-button');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh tunnel logs' }));
    expect(onRefreshTunnelLogs).toHaveBeenCalledTimes(1);
    const serverCard = screen.getByText('Boundary Alpha').closest('li');
    expect(serverCard).not.toBeNull();
    expect(within(serverCard as HTMLElement).getByText('Selected tunnel server: srv-1')).toBeInTheDocument();
    expect(within(serverCard as HTMLElement).getByLabelText('Tunnel logs')).toHaveTextContent('Tunnel connected');
  });

  it('initially scrolls tunnel logs to the newest bottom line', async () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.getAttribute('aria-label') === 'Tunnel logs' ? 900 : 0;
      },
    });

    try {
      render(
        <RuntimeSummarySection
          selectedDeviceId="dev-1"
          runtimeSummaryLoading={false}
          runtimeSummaryError={null}
          runtimeSummary={{
            deviceId: 'dev-1',
            updatedAt: '2026-04-20T00:00:00.000Z',
            functions: {
              'server-tunnel-srv-1': { state: 'running', message: 'active' },
            },
            inventory: {
              servers: [
                { id: 'srv-1', name: 'Boundary Alpha', connectionMethod: 'boundary', host: '127.0.0.1' },
              ],
            },
          }}
          deviceActionLoadingId={null}
          selectedTunnelServerId="srv-1"
          tunnelLogs={[
            { ts: '2026-04-20T00:00:01.000Z', sessionId: 'sess-1', data: 'Tunnel connected' },
            { ts: '2026-04-20T00:00:02.000Z', sessionId: 'sess-1', data: 'Ready for SSH' },
          ]}
          tunnelLogsLoading={false}
          tunnelLogsError={null}
          tunnelLogsTotal={2}
          onLoadMoreTunnelLogs={vi.fn()}
          onSelectTunnelServer={vi.fn()}
          onRefreshTunnelLogs={vi.fn()}
          onRequestStartServerTunnel={vi.fn()}
          onRequestStopServerTunnel={vi.fn()}
          onStartServerSshTerminal={vi.fn()}
          onRetry={vi.fn()}
        />,
      );

      const tunnelLogs = screen.getByLabelText('Tunnel logs');
      await waitFor(() => expect(tunnelLogs.scrollTop).toBe(900));
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
      } else {
        delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      }
    }
  });

  it('renders active SSH terminals directly under their server rows', () => {
    render(
      <RuntimeSummarySection
        selectedDeviceId="dev-1"
        runtimeSummaryLoading={false}
        runtimeSummaryError={null}
        runtimeSummary={{
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {
            'server-tunnel-srv-1': { state: 'running', message: 'active' },
            'server-tunnel-srv-2': { state: 'running', message: 'active' },
          },
          inventory: {
            servers: [
              { id: 'srv-1', name: 'Boundary Alpha', connectionMethod: 'boundary', host: '127.0.0.1' },
              { id: 'srv-2', name: 'Boundary Beta', connectionMethod: 'boundary', host: '127.0.0.2' },
            ],
          },
        }}
        deviceActionLoadingId={null}
        selectedTunnelServerId={null}
        tunnelLogs={[]}
        tunnelLogsLoading={false}
        tunnelLogsError={null}
        tunnelLogsTotal={0}
        sshTerminals={[
          { deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' },
          { deviceId: 'dev-1', serverId: 'srv-2', sessionId: 'ssh-session-2' },
        ]}
        onLoadMoreTunnelLogs={vi.fn()}
        onSelectTunnelServer={vi.fn()}
        onRefreshTunnelLogs={vi.fn()}
        onRequestStartServerTunnel={vi.fn()}
        onRequestStopServerTunnel={vi.fn()}
        onStartServerSshTerminal={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('SSH terminal for Boundary Alpha')).toBeInTheDocument();
    expect(screen.getByLabelText('SSH terminal for Boundary Beta')).toBeInTheDocument();
  });

  it('uses a per-server detail drawer with tabs for SSH and tunnel logs', () => {
    render(
      <RuntimeSummarySection
        selectedDeviceId="dev-1"
        runtimeSummaryLoading={false}
        runtimeSummaryError={null}
        runtimeSummary={{
          deviceId: 'dev-1',
          updatedAt: '2026-04-20T00:00:00.000Z',
          functions: {
            'server-tunnel-srv-1': { state: 'running', message: 'active' },
          },
          inventory: {
            servers: [
              { id: 'srv-1', name: 'Boundary Alpha', connectionMethod: 'boundary', host: '127.0.0.1' },
            ],
          },
        }}
        deviceActionLoadingId={null}
        selectedTunnelServerId="srv-1"
        tunnelLogs={[
          { ts: '2026-04-20T00:00:01.000Z', sessionId: 'sess-1', data: 'Tunnel connected' },
        ]}
        tunnelLogsLoading={false}
        tunnelLogsError={null}
        tunnelLogsTotal={1}
        sshTerminals={[
          { deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' },
        ]}
        onLoadMoreTunnelLogs={vi.fn()}
        onSelectTunnelServer={vi.fn()}
        onRefreshTunnelLogs={vi.fn()}
        onRequestStartServerTunnel={vi.fn()}
        onRequestStopServerTunnel={vi.fn()}
        onStartServerSshTerminal={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    const serverCard = screen.getByText('Boundary Alpha').closest('li');
    expect(serverCard).not.toBeNull();
    expect(within(serverCard as HTMLElement).getByRole('tab', { name: 'SSH Terminal' })).toHaveAttribute('aria-selected', 'false');
    expect(within(serverCard as HTMLElement).getByRole('tab', { name: 'Tunnel Logs' })).toHaveAttribute('aria-selected', 'true');
    expect(within(serverCard as HTMLElement).getByLabelText('SSH terminal for Boundary Alpha')).toBeInTheDocument();
    const tunnelLogs = within(serverCard as HTMLElement).getByLabelText('Tunnel logs');
    expect(tunnelLogs).toHaveTextContent('Tunnel connected');
    expect(tunnelLogs).toHaveClass('runtime-summary-terminal-viewport');
  });

});
