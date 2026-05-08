import type { RuntimeSummary } from '../api/adminApi';
import { Link } from 'react-router-dom';
import { formatTimestamp } from '../utils/formatTimestamp';

type RuntimeSummarySectionProps = {
  selectedDeviceId: string | null;
  runtimeSummaryLoading: boolean;
  runtimeSummaryError: string | null;
  runtimeSummary: RuntimeSummary | null;
  onRetry: () => void;
};

export function RuntimeSummarySection({
  selectedDeviceId,
  runtimeSummaryLoading,
  runtimeSummaryError,
  runtimeSummary,
  onRetry,
}: RuntimeSummarySectionProps) {
  const boundaryServers = Array.isArray(runtimeSummary?.inventory?.servers)
    ? runtimeSummary.inventory.servers.filter(
        (server) => String(server?.connectionMethod || '').toLowerCase() === 'boundary' && String(server?.id || '').trim(),
      )
    : [];
  const functionEntries = Object.entries(runtimeSummary?.functions || {});

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
                const serverRuntimeHref = selectedDeviceId
                  ? `/admin/devices/${encodeURIComponent(selectedDeviceId)}/servers/${encodeURIComponent(serverId)}/runtime`
                  : '#';

                return (
                  <li key={serverId} className="runtime-summary-tunnel-card">
                    <div className="runtime-summary-tunnel-meta">
                      <div>
                        <strong>{serverName}</strong>
                        <p className="runtime-summary-tunnel-host">{server.host ? String(server.host) : 'No host reported'}</p>
                      </div>
                    </div>
                    <div className="runtime-summary-tunnel-actions">
                      <Link
                        className="runtime-toolbar-button runtime-toolbar-button-primary"
                        aria-disabled={!selectedDeviceId}
                        to={serverRuntimeHref}
                      >
                        Open runtime for {serverName}
                      </Link>
                    </div>
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
