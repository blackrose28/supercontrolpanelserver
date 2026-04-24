import { useMemo, useState } from 'react';
import { DeviceDetailsSection } from '../components/DeviceDetailsSection';
import { CommandsSection } from '../components/CommandsSection';
import { DeviceListSection } from '../components/DeviceListSection';
import { RecentLogsSection } from '../components/RecentLogsSection';
import { RuntimeSummarySection } from '../components/RuntimeSummarySection';
import { TransfersSection } from '../components/TransfersSection';
import { TelemetrySection } from '../components/TelemetrySection';
import { useAdminDashboard } from '../hooks/useAdminDashboard';

type DeviceTabId =
  | 'details'
  | 'runtime'
  | 'logs'
  | 'commands'
  | 'transfers'
  | 'telemetry';

export function AdminDashboardPage() {
  const {
    devices,
    loading,
    error,
    selectedDeviceId,
    selectedDeviceDetails,
    selectedDeviceLoading,
    selectedDeviceError,
    runtimeSummary,
    runtimeSummaryLoading,
    runtimeSummaryError,
    recentLogs,
    recentLogsLoading,
    recentLogsError,
    selectedTunnelServerId,
    tunnelLogs,
    tunnelLogsLoading,
    tunnelLogsError,
    tunnelLogsTotal,
    loadMoreTunnelLogs,
    commands,
    commandsLoading,
    commandsError,
    selectedCommandId,
    commandAudit,
    commandAuditLoading,
    commandAuditError,
    transfers,
    transfersLoading,
    transfersError,
    transferActionLoading,
    activeTransferId,
    telemetry,
    telemetryLoading,
    telemetryError,
    telemetryTypeFilter,
    telemetryTextFilter,
    telemetryFromTsFilter,
    telemetryToTsFilter,
    telemetryExportUrl,
    recentLogsLimit,
    setRecentLogsLimit,
    commandsLimit,
    setCommandsLimit,
    transfersLimit,
    setTransfersLimit,
    telemetryLimit,
    setTelemetryLimit,
    deviceActionLoadingId,
    deviceActionError,
    setTelemetryTypeFilter,
    setTelemetryTextFilter,
    setTelemetryFromTsFilter,
    setTelemetryToTsFilter,
    refreshDevices,
    refreshCommands,
    selectCommand,
    refreshTransfers,
    stopTransfer,
    dismissTransfer,
    forceRemoveTransfer,
    resumeTransfer,
    dismissFinishedTransfers,
    refreshTelemetry,
    selectDevice,
    requestRecentLogs,
    selectTunnelServer,
    refreshTunnelLogs,
    requestRestartOpenvpn,
    requestRestartBoundaryAuth,
    requestStartServerTunnel,
    requestStopServerTunnel,
    requestStatusSnapshot,
    retryRuntimeSummary,
    retryRecentLogs,
  } = useAdminDashboard();

  const [expandedDeviceId, setExpandedDeviceId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DeviceTabId>('details');

  function handleViewLogs(deviceId: string) {
    selectDevice(deviceId);
    setExpandedDeviceId(deviceId);
    setActiveTab('logs');
  }

  function handleToggleDevice(deviceId: string) {
    if (expandedDeviceId === deviceId) {
      setExpandedDeviceId(null);
      return;
    }

    selectDevice(deviceId);
    setExpandedDeviceId(deviceId);
    setActiveTab('details');
  }

  const tabs = useMemo(
    () => [
      { id: 'details' as const, label: 'Device Details' },
      { id: 'runtime' as const, label: 'Runtime Summary' },
      { id: 'logs' as const, label: 'Recent Logs' },
      { id: 'commands' as const, label: 'Command History' },
      { id: 'transfers' as const, label: 'Transfer Activity' },
      { id: 'telemetry' as const, label: 'Telemetry' },
    ],
    [],
  );

  function renderExpandedDeviceContent(deviceId: string) {
    const effectiveDeviceId = selectedDeviceId === deviceId ? selectedDeviceId : deviceId;
    const deviceName = devices.find((device) => device.id === deviceId)?.name || deviceId;
    const activeTabLabel = tabs.find((tab) => tab.id === activeTab)?.label || 'Device Details';

    return (
      <div className="device-tabs-shell device-tabs-shell-mobile-ready">
        <div className="device-workspace-header">
          <div>
            <p className="device-workspace-eyebrow">Device workspace</p>
            <h3 className="device-workspace-title">{deviceName}</h3>
            <p className="device-workspace-subtitle">Browsing panels for {deviceName}.</p>
          </div>
          <div className="device-workspace-meta">
            <span className="device-workspace-meta-label">Active panel</span>
            <strong>{activeTabLabel}</strong>
          </div>
        </div>
        <div className="device-tabs-bar device-tabs-bar-scroll" role="tablist" aria-label={`Device panels for ${deviceId}`}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              id={`device-tab-${tab.id}`}
              className={`device-tab-button${activeTab === tab.id ? ' active' : ''}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`device-tabpanel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="device-tab-panels device-tab-panels-stack">
          <div
            id="device-tabpanel-details"
            className={`device-tab-panel${activeTab === 'details' ? ' active' : ' inactive'}`}
            role="tabpanel"
            aria-labelledby="device-tab-details"
          >
            <DeviceDetailsSection
              selectedDeviceId={effectiveDeviceId}
              selectedDeviceLoading={selectedDeviceLoading}
              selectedDeviceError={selectedDeviceError}
              selectedDeviceDetails={selectedDeviceDetails}
            />
          </div>

          <div
            id="device-tabpanel-runtime"
            className={`device-tab-panel${activeTab === 'runtime' ? ' active' : ' inactive'}`}
            role="tabpanel"
            aria-labelledby="device-tab-runtime"
          >
            <RuntimeSummarySection
              selectedDeviceId={effectiveDeviceId}
              runtimeSummaryLoading={runtimeSummaryLoading}
              runtimeSummaryError={runtimeSummaryError}
              runtimeSummary={runtimeSummary}
              deviceActionLoadingId={deviceActionLoadingId}
              selectedTunnelServerId={selectedTunnelServerId}
              tunnelLogs={tunnelLogs}
              tunnelLogsLoading={tunnelLogsLoading}
              tunnelLogsError={tunnelLogsError}
              tunnelLogsTotal={tunnelLogsTotal}
              onLoadMoreTunnelLogs={loadMoreTunnelLogs}
              onSelectTunnelServer={selectTunnelServer}
              onRefreshTunnelLogs={refreshTunnelLogs}
              onRequestStartServerTunnel={requestStartServerTunnel}
              onRequestStopServerTunnel={requestStopServerTunnel}
              onRetry={retryRuntimeSummary}
            />
          </div>

          <div
            id="device-tabpanel-logs"
            className={`device-tab-panel${activeTab === 'logs' ? ' active' : ' inactive'}`}
            role="tabpanel"
            aria-labelledby="device-tab-logs"
          >
            <RecentLogsSection
              sectionId="recent-logs-section"
              selectedDeviceId={effectiveDeviceId}
              recentLogsLoading={recentLogsLoading}
              recentLogsError={recentLogsError}
              recentLogs={recentLogs}
              recentLogsLimit={recentLogsLimit}
              onRetry={retryRecentLogs}
              onLimitChange={setRecentLogsLimit}
            />
          </div>

          <div
            id="device-tabpanel-commands"
            className={`device-tab-panel${activeTab === 'commands' ? ' active' : ' inactive'}`}
            role="tabpanel"
            aria-labelledby="device-tab-commands"
          >
            <CommandsSection
              selectedDeviceId={effectiveDeviceId}
              commandsLoading={commandsLoading}
              commandsError={commandsError}
              commands={commands}
              commandsLimit={commandsLimit}
              selectedCommandId={selectedCommandId}
              commandAudit={commandAudit}
              commandAuditLoading={commandAuditLoading}
              commandAuditError={commandAuditError}
              onRefresh={refreshCommands}
              onSelectCommand={selectCommand}
              onLimitChange={setCommandsLimit}
            />
          </div>

          <div
            id="device-tabpanel-transfers"
            className={`device-tab-panel${activeTab === 'transfers' ? ' active' : ' inactive'}`}
            role="tabpanel"
            aria-labelledby="device-tab-transfers"
          >
            <TransfersSection
              selectedDeviceId={effectiveDeviceId}
              transfersLoading={transfersLoading}
              transfersError={transfersError}
              transfers={transfers}
              transfersLimit={transfersLimit}
              transferActionLoading={transferActionLoading}
              activeTransferId={activeTransferId}
              onRefresh={refreshTransfers}
              onStopTransfer={stopTransfer}
              onDismissTransfer={dismissTransfer}
              onForceRemoveTransfer={forceRemoveTransfer}
              onResumeTransfer={resumeTransfer}
              onDismissFinished={dismissFinishedTransfers}
              onLimitChange={setTransfersLimit}
            />
          </div>

          <div
            id="device-tabpanel-telemetry"
            className={`device-tab-panel${activeTab === 'telemetry' ? ' active' : ' inactive'}`}
            role="tabpanel"
            aria-labelledby="device-tab-telemetry"
          >
            <TelemetrySection
              selectedDeviceId={effectiveDeviceId}
              telemetryLoading={telemetryLoading}
              telemetryError={telemetryError}
              telemetry={telemetry}
              telemetryTypeFilter={telemetryTypeFilter}
              telemetryTextFilter={telemetryTextFilter}
              telemetryFromTsFilter={telemetryFromTsFilter}
              telemetryToTsFilter={telemetryToTsFilter}
              telemetryExportUrl={telemetryExportUrl}
              onTelemetryTypeFilterChange={setTelemetryTypeFilter}
              onTelemetryTextFilterChange={setTelemetryTextFilter}
              onTelemetryFromTsFilterChange={setTelemetryFromTsFilter}
              onTelemetryToTsFilterChange={setTelemetryToTsFilter}
              onRefresh={refreshTelemetry}
              telemetryLimit={telemetryLimit}
              onLimitChange={setTelemetryLimit}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <DeviceListSection
        devices={devices}
        loading={loading}
        error={error}
        onRefresh={refreshDevices}
        onSelectDevice={handleToggleDevice}
        onViewLogs={handleViewLogs}
        onRequestSnapshot={requestStatusSnapshot}
        onRequestRecentLogs={requestRecentLogs}
        onRequestRestartOpenvpn={requestRestartOpenvpn}
        onRequestRestartBoundaryAuth={requestRestartBoundaryAuth}
        deviceActionLoadingId={deviceActionLoadingId}
        deviceActionError={deviceActionError}
        expandedDeviceId={expandedDeviceId}
        renderExpandedContent={renderExpandedDeviceContent}
      />
    </>
  );
}
