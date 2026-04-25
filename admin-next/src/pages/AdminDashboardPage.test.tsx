import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdminDashboardPage } from './AdminDashboardPage';

vi.mock('../hooks/useAdminDashboard', () => ({
  useAdminDashboard: () => ({
    devices: [{ id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: '2026-04-20T00:00:00.000Z' }],
    loading: false,
    error: null,
    selectedDeviceId: 'dev-1',
    selectedDeviceDetails: { id: 'dev-1', name: 'Device One', status: 'connected', os: 'linux', lastSeenAt: '2026-04-20T00:00:00.000Z' },
    selectedDeviceLoading: false,
    selectedDeviceError: null,
    runtimeSummary: null,
    runtimeSummaryLoading: false,
    runtimeSummaryError: null,
    recentLogs: [],
    recentLogsLoading: false,
    recentLogsError: null,
    selectedTunnelServerId: null,
    tunnelLogs: [],
    tunnelLogsLoading: false,
    tunnelLogsError: null,
    tunnelLogsTotal: 0,
    loadMoreTunnelLogs: vi.fn(),
    commands: [],
    commandsLoading: false,
    commandsError: null,
    selectedCommandId: null,
    commandAudit: [],
    commandAuditLoading: false,
    commandAuditError: null,
    transfers: [],
    transfersLoading: false,
    transfersError: null,
    transferActionLoading: false,
    transferStartLoading: false,
    activeTransferId: null,
    telemetry: [],
    telemetryLoading: false,
    telemetryError: null,
    telemetryTypeFilter: '',
    telemetryTextFilter: '',
    telemetryFromTsFilter: '',
    telemetryToTsFilter: '',
    telemetryExportUrl: null,
    recentLogsLimit: 20,
    setRecentLogsLimit: vi.fn(),
    commandsLimit: 20,
    setCommandsLimit: vi.fn(),
    transfersLimit: 50,
    setTransfersLimit: vi.fn(),
    telemetryLimit: 50,
    setTelemetryLimit: vi.fn(),
    deviceActionLoadingId: null,
    deviceActionError: null,
    setTelemetryTypeFilter: vi.fn(),
    setTelemetryTextFilter: vi.fn(),
    setTelemetryFromTsFilter: vi.fn(),
    setTelemetryToTsFilter: vi.fn(),
    refreshDevices: vi.fn(),
    refreshCommands: vi.fn(),
    selectCommand: vi.fn(),
    refreshTransfers: vi.fn(),
    stopTransfer: vi.fn(),
    dismissTransfer: vi.fn(),
    forceRemoveTransfer: vi.fn(),
    resumeTransfer: vi.fn(),
    startScpTransfer: vi.fn(),
    dismissFinishedTransfers: vi.fn(),
    refreshTelemetry: vi.fn(),
    selectDevice: vi.fn(),
    requestRecentLogs: vi.fn(),
    selectTunnelServer: vi.fn(),
    refreshTunnelLogs: vi.fn(),
    requestRestartOpenvpn: vi.fn(),
    requestRestartBoundaryAuth: vi.fn(),
    requestStartServerTunnel: vi.fn(),
    requestStopServerTunnel: vi.fn(),
    requestStatusSnapshot: vi.fn(),
    retryRuntimeSummary: vi.fn(),
    retryRecentLogs: vi.fn(),
  }),
}));

describe('AdminDashboardPage', () => {
  it('renders a polished device workspace header above the tab panels', () => {
    render(<AdminDashboardPage />);

    fireEvent.click(screen.getByRole('button', { name: /select device one/i }));

    expect(screen.getByText('Device workspace')).toBeInTheDocument();
    expect(screen.getByText('Browsing panels for Device One.')).toBeInTheDocument();
    expect(screen.getByText('Active panel')).toBeInTheDocument();
    expect(screen.getByText('Active panel').closest('.device-workspace-meta')).toHaveTextContent('Device Details');
    const tabList = screen.getByRole('tablist', { name: /device panels for dev-1/i });
    expect(tabList).toHaveClass('device-tabs-bar-scroll');
    expect(tabList.closest('.device-tabs-shell')).toHaveClass('device-tabs-shell-mobile-ready');
    expect(tabList.parentElement?.querySelector('.device-tab-panels')).toHaveClass('device-tab-panels-stack');
  });
});
