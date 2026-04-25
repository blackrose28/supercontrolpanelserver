import { useEffect, useRef, useState } from 'react';
import type { RuntimeSummary, TunnelLogEntry } from '../api/adminApi';
import { SshTerminalPanel } from './SshTerminalPanel';
import { formatTimestamp } from '../utils/formatTimestamp';

type ServerDetailTab = 'ssh' | 'logs';

type RuntimeSummarySectionProps = {
  selectedDeviceId: string | null;
  runtimeSummaryLoading: boolean;
  runtimeSummaryError: string | null;
  runtimeSummary: RuntimeSummary | null;
  deviceActionLoadingId: string | null;
  selectedTunnelServerId: string | null;
  tunnelLogs: TunnelLogEntry[];
  tunnelLogsLoading: boolean;
  tunnelLogsError: string | null;
  tunnelLogsTotal: number;
  onLoadMoreTunnelLogs: () => void;
  onSelectTunnelServer: (serverId: string) => void;
  onRefreshTunnelLogs: () => void;
  onRequestStartServerTunnel: (deviceId: string, serverId: string) => void;
  onRequestStopServerTunnel: (deviceId: string, serverId: string) => void;
  onStartServerSshTerminal: (deviceId: string, serverId: string) => void;
  sshTerminals?: Array<{ deviceId: string; serverId: string; sessionId: string }>;
  onRetry: () => void;
};

export function RuntimeSummarySection({
  selectedDeviceId,
  runtimeSummaryLoading,
  runtimeSummaryError,
  runtimeSummary,
  deviceActionLoadingId,
  selectedTunnelServerId,
  tunnelLogs,
  tunnelLogsLoading,
  tunnelLogsError,
  tunnelLogsTotal,
  onLoadMoreTunnelLogs,
  onSelectTunnelServer,
  onRefreshTunnelLogs,
  onRequestStartServerTunnel,
  onRequestStopServerTunnel,
  onStartServerSshTerminal,
  sshTerminals = [],
  onRetry,
}: RuntimeSummarySectionProps) {
  const [serverDetailTabs, setServerDetailTabs] = useState<Record<string, ServerDetailTab>>({});
  const tunnelLogOutputRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const output = tunnelLogOutputRef.current;
    if (!output || !selectedTunnelServerId || tunnelLogsLoading || tunnelLogsError || tunnelLogs.length === 0) {
      return;
    }
    output.scrollTop = output.scrollHeight;
  }, [selectedTunnelServerId, tunnelLogsLoading, tunnelLogsError, tunnelLogs.length, serverDetailTabs]);

  const boundaryServers = Array.isArray(runtimeSummary?.inventory?.servers)
    ? runtimeSummary.inventory.servers.filter(
        (server) => String(server?.connectionMethod || '').toLowerCase() === 'boundary' && String(server?.id || '').trim(),
      )
    : [];
  const functionEntries = Object.entries(runtimeSummary?.functions || {});
  const selectedTunnelLogCount = selectedTunnelServerId ? tunnelLogs.length : 0;

  return (
    <section className="panel-section runtime-summary-section">
      <div className="runtime-summary-header">
        <div>
          <h2>Runtime Summary</h2>
          <p className="runtime-summary-subtitle">
            Track live function health, Boundary tunnels, and the latest device runtime state.
          </p>
        </div>
        {runtimeSummary ? (
          <div className="runtime-summary-updated-card">
            <span className="runtime-summary-updated-label">Last updated</span>
            <p className="runtime-summary-updated-copy">Updated: {formatTimestamp(runtimeSummary.updatedAt)}</p>
            <strong>{formatTimestamp(runtimeSummary.updatedAt)}</strong>
          </div>
        ) : null}
      </div>
      {!selectedDeviceId ? <p>Select a device to load runtime summary.</p> : null}
      {!runtimeSummary && runtimeSummaryLoading ? <p>Loading runtime summary…</p> : null}
      {!runtimeSummary && runtimeSummaryError ? (
        <div className="runtime-summary-message-card runtime-summary-message-card-error">
          <p>{runtimeSummaryError}</p>
          <button
            type="button"
            className="runtime-toolbar-button"
            onClick={onRetry}
            disabled={runtimeSummaryLoading}
          >
            Retry runtime summary
          </button>
        </div>
      ) : null}
      {runtimeSummary ? (
        <>
          <div className="runtime-summary-stats" aria-label="Runtime summary highlights">
            <div className="runtime-summary-stat-card">
              <span className="runtime-summary-stat-label">Functions reporting</span>
              <strong className="runtime-summary-stat-value">{functionEntries.length}</strong>
            </div>
            <div className="runtime-summary-stat-card">
              <span className="runtime-summary-stat-label">Boundary tunnels</span>
              <strong className="runtime-summary-stat-value">{boundaryServers.length}</strong>
            </div>
            <div className="runtime-summary-stat-card">
              <span className="runtime-summary-stat-label">Logs loaded</span>
              <strong className="runtime-summary-stat-value">{selectedTunnelLogCount}</strong>
            </div>
          </div>

          <h3>Functions</h3>
          {functionEntries.length > 0 ? (
            <ul className="runtime-summary-function-list">
              {functionEntries.map(([functionId, entry]) => (
                <li key={functionId} className="runtime-summary-function-item">
                  <div>
                    <strong>{functionId}</strong>
                    <p className="runtime-summary-function-message">{entry?.message ? String(entry.message) : 'No message reported'}</p>
                  </div>
                  <span className="command-state-badge">{entry?.state ? String(entry.state) : '-'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No functions reported.</p>
          )}
          <h3>Boundary tunnel servers</h3>
          {boundaryServers.length > 0 ? (
            <ul className="runtime-summary-tunnel-list">
              {boundaryServers.map((server) => {
                const serverId = String(server.id || '').trim();
                const serverName = String(server.name || serverId || 'Unnamed server');
                const functionId = `server-tunnel-${serverId}`;
                const tunnelState = String(runtimeSummary?.functions?.[functionId]?.state || '').toLowerCase();
                const isRunning = tunnelState === 'running';
                const sshTerminal = sshTerminals.find((terminal) => terminal.serverId === serverId && terminal.deviceId === selectedDeviceId);
                const hasTunnelLogsPanel = selectedTunnelServerId === serverId;
                const hasSshPanel = Boolean(sshTerminal);
                const hasDetailDrawer = hasTunnelLogsPanel || hasSshPanel;
                const activeDetailTab = serverDetailTabs[serverId] ?? (hasTunnelLogsPanel ? 'logs' : 'ssh');
                const showLoadMoreLogs = hasTunnelLogsPanel && tunnelLogsTotal > tunnelLogs.length;

                return (
                  <li key={serverId} className="runtime-summary-tunnel-card">
                    <div className="runtime-summary-tunnel-meta">
                      <div>
                        <strong>{serverName}</strong>
                        <p className="runtime-summary-tunnel-host">{server.host ? String(server.host) : 'No host reported'}</p>
                      </div>
                      <span className={`transfer-state-badge ${isRunning ? 'state-succeeded' : 'state-canceled'}`}>
                        {isRunning ? 'On' : 'Off'}
                      </span>
                    </div>
                    <div className="runtime-summary-tunnel-actions">
                      {isRunning ? (
                        <button
                          type="button"
                          className="runtime-toolbar-button"
                          disabled={!selectedDeviceId || deviceActionLoadingId === selectedDeviceId}
                          onClick={() => {
                            if (!selectedDeviceId) {
                              return;
                            }
                            onRequestStopServerTunnel(selectedDeviceId, serverId);
                          }}
                        >
                          {deviceActionLoadingId === selectedDeviceId ? 'Requesting...' : `Stop tunnel for ${serverName}`}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="runtime-toolbar-button runtime-toolbar-button-primary"
                          disabled={!selectedDeviceId || deviceActionLoadingId === selectedDeviceId}
                          onClick={() => {
                            if (!selectedDeviceId) {
                              return;
                            }
                            onRequestStartServerTunnel(selectedDeviceId, serverId);
                          }}
                        >
                          {deviceActionLoadingId === selectedDeviceId ? 'Requesting...' : `Start tunnel for ${serverName}`}
                        </button>
                      )}

                      <button
                        type="button"
                        className="runtime-toolbar-button"
                        disabled={!selectedDeviceId}
                        onClick={() => {
                          setServerDetailTabs((previous) => ({ ...previous, [serverId]: 'logs' }));
                          onSelectTunnelServer(serverId);
                        }}
                      >
                        {hasTunnelLogsPanel ? `Viewing logs for ${serverName}` : `View logs for ${serverName}`}
                      </button>
                      <button
                        type="button"
                        className="runtime-toolbar-button runtime-toolbar-button-primary"
                        disabled={!selectedDeviceId || !isRunning || deviceActionLoadingId === selectedDeviceId}
                        onClick={() => {
                          if (!selectedDeviceId) {
                            return;
                          }
                          setServerDetailTabs((previous) => ({ ...previous, [serverId]: 'ssh' }));
                          onStartServerSshTerminal(selectedDeviceId, serverId);
                        }}
                      >
                        SSH terminal for {serverName}
                      </button>
                    </div>
                    {hasDetailDrawer ? (
                      <div className="runtime-summary-server-drawer" aria-label={`Server runtime details for ${serverName}`}>
                        {hasSshPanel && hasTunnelLogsPanel ? (
                          <div className="runtime-summary-detail-tabs" role="tablist" aria-label={`Runtime panes for ${serverName}`}>
                            <button
                              type="button"
                              role="tab"
                              className="runtime-summary-detail-tab"
                              aria-selected={activeDetailTab === 'ssh'}
                              onClick={() => setServerDetailTabs((previous) => ({ ...previous, [serverId]: 'ssh' }))}
                            >
                              SSH Terminal
                            </button>
                            <button
                              type="button"
                              role="tab"
                              className="runtime-summary-detail-tab"
                              aria-selected={activeDetailTab === 'logs'}
                              onClick={() => setServerDetailTabs((previous) => ({ ...previous, [serverId]: 'logs' }))}
                            >
                              Tunnel Logs
                            </button>
                          </div>
                        ) : null}
                        {sshTerminal ? (
                          <div className={activeDetailTab === 'ssh' ? 'runtime-summary-detail-pane' : 'runtime-summary-detail-pane is-hidden'} aria-hidden={activeDetailTab !== 'ssh'}>
                            <SshTerminalPanel
                              terminal={sshTerminal}
                              title={`SSH terminal for ${serverName}`}
                            />
                          </div>
                        ) : null}
                        {hasTunnelLogsPanel ? (
                          <div className={activeDetailTab === 'logs' ? 'runtime-summary-detail-pane' : 'runtime-summary-detail-pane is-hidden'} aria-hidden={activeDetailTab !== 'logs'}>
                            <div className="runtime-summary-log-panel runtime-summary-log-panel-inline">
                              <h4>Tunnel logs</h4>
                              <div className="runtime-summary-log-toolbar">
                                <div>
                                  <p>Selected tunnel server: {serverId}</p>
                                  <p className="runtime-summary-log-toolbar-meta">
                                    Showing {selectedTunnelLogCount} of {tunnelLogsTotal || selectedTunnelLogCount} log entries
                                  </p>
                                </div>
                                <div className="runtime-summary-log-actions">
                                  {showLoadMoreLogs ? (
                                    <button
                                      type="button"
                                      className="runtime-toolbar-button"
                                      onClick={onLoadMoreTunnelLogs}
                                      disabled={tunnelLogsLoading}
                                    >
                                      Load more tunnel logs
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="runtime-toolbar-button"
                                    onClick={onRefreshTunnelLogs}
                                    disabled={tunnelLogsLoading}
                                  >
                                    Refresh tunnel logs
                                  </button>
                                </div>
                              </div>
                              {tunnelLogsLoading ? <p>Loading tunnel logs...</p> : null}
                              {tunnelLogsError ? <p>{tunnelLogsError}</p> : null}
                              {!tunnelLogsLoading && !tunnelLogsError ? (
                                tunnelLogs.length > 0 ? (
                                  <pre ref={tunnelLogOutputRef} className="runtime-summary-log-output runtime-summary-terminal-viewport" aria-label="Tunnel logs">{tunnelLogs.map((entry) => entry.data || '').join('\n')}</pre>
                                ) : (
                                  <p>No tunnel logs yet.</p>
                                )
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No Boundary-backed servers available in inventory. Request inventory first.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
