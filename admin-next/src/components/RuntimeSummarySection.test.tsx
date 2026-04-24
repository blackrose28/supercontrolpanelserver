import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeSummarySection } from './RuntimeSummarySection';

describe('RuntimeSummarySection', () => {
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
    expect(screen.getByText('Selected tunnel server: srv-1')).toBeInTheDocument();
    expect(screen.getByLabelText('Tunnel logs')).toHaveTextContent('Tunnel connected');
  });
});
