import type { RuntimeSummary, TunnelLogEntry } from '../api/adminApi';
import { formatTimestamp } from '../utils/formatTimestamp';

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
  onRetry,
}: RuntimeSummarySectionProps) {
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
                          {deviceActionLoadingId === selectedDeviceId ? 'Requesting…' : `Stop tunnel for ${serverName}`}
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
                          {deviceActionLoadingId === selectedDeviceId ? 'Requesting…' : `Start tunnel for ${serverName}`}
                        </button>
                      )}

                      <button
                        type="button"
                        className="runtime-toolbar-button"
                        disabled={!selectedDeviceId}
                        onClick={() => onSelectTunnelServer(serverId)}
                      >
                        {selectedTunnelServerId === serverId ? `Viewing logs for ${serverName}` : `View logs for ${serverName}`}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No Boundary-backed servers available in inventory. Request inventory first.</p>
          )}
          {selectedTunnelServerId ? (
            <div className="runtime-summary-log-panel">
              <h4>Tunnel logs</h4>
              <div className="runtime-summary-log-toolbar">
                <div>
                  <p>Selected tunnel server: {selectedTunnelServerId}</p>
                  <p className="runtime-summary-log-toolbar-meta">
                    Showing {selectedTunnelLogCount} of {tunnelLogsTotal || selectedTunnelLogCount} log entries
                  </p>
                </div>
                <button
                  type="button"
                  className="runtime-toolbar-button"
                  onClick={onRefreshTunnelLogs}
                  disabled={tunnelLogsLoading}
                >
                  Refresh tunnel logs
                </button>
              </div>
              {tunnelLogsLoading ? <p>Loading tunnel logs…</p> : null}
              {tunnelLogsError ? <p>{tunnelLogsError}</p> : null}
              {!tunnelLogsLoading && !tunnelLogsError ? (
                tunnelLogs.length > 0 ? (
                  <pre className="runtime-summary-log-output" aria-label="Tunnel logs">{tunnelLogs.map((entry) => entry.data || '').join('\n')}</pre>
                ) : (
                  <p>No tunnel logs yet.</p>
                )
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
