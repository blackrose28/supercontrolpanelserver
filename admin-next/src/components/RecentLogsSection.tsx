import type { RecentLogEntry } from '../api/adminApi';
import { formatTimestamp } from '../utils/formatTimestamp';

type RecentLogsSectionProps = {
  selectedDeviceId: string | null;
  recentLogsLoading: boolean;
  recentLogsError: string | null;
  recentLogs: RecentLogEntry[];
  recentLogsLimit: number;
  onRetry: () => void;
  onLimitChange: (limit: number) => void;
  sectionId?: string;
};
export function RecentLogsSection({
  selectedDeviceId,
  recentLogsLoading,
  recentLogsError,
  recentLogs,
  recentLogsLimit,
  onRetry,
  onLimitChange,
  sectionId,
}: RecentLogsSectionProps) {
  return (
    <section id={sectionId} className="panel-section logs-section">
      <div className="logs-section-header">
        <div>
          <h2>Recent Logs</h2>
          <p className="logs-section-subtitle">
            Review the latest device events, function updates, and runtime activity at a glance.
          </p>
        </div>
        {selectedDeviceId ? (
          <div className="logs-toolbar">
            <p className="logs-toolbar-caption">Showing up to {recentLogsLimit} entries</p>
            <label className="logs-toolbar-label toolbar-limit-field">
              Show:
            <select
              aria-label="Recent log limit"
              className="logs-toolbar-select"
              value={recentLogsLimit}
              onChange={(e) => onLimitChange(Number(e.target.value))}
              disabled={recentLogsLoading}
            >
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
            </select>
            </label>
          </div>
        ) : null}
      </div>
      {!selectedDeviceId ? <p>Select a device to load recent logs.</p> : null}
      {recentLogsLoading ? (
        <>
          <p>Loading recent logs preview…</p>
          <ul aria-label="Recent logs loading placeholders">
            <li>Loading log entry…</li>
            <li>Loading log entry…</li>
            <li>Loading log entry…</li>
          </ul>
        </>
      ) : null}
      {recentLogsError ? (
        <div className="logs-message-card logs-message-card-error">
          <p>{recentLogsError}</p>
          <button
            type="button"
            className="logs-retry-button"
            onClick={onRetry}
            disabled={recentLogsLoading}
          >
            Retry recent logs
          </button>
        </div>
      ) : null}
      {selectedDeviceId && !recentLogsLoading && !recentLogsError ? (
        recentLogs.length > 0 ? (
          <div className="logs-list-shell">
            <div className="logs-list-heading">Recent log entries</div>
            <ul className="logs-list">
            {recentLogs.map((entry) => (
              <li className="logs-list-item" key={entry.id || `${entry.ts || ''}-${entry.type || ''}`}>
                <div className="logs-list-item-row">
                  <span className="logs-list-timestamp">{formatTimestamp(entry.ts)}</span>
                  <strong>{entry.type || '-'}</strong>
                </div>
                <div className="logs-list-item-row">
                  <span className="logs-list-meta-label">Function</span>
                  <span>{entry.functionId || '-'}</span>
                </div>
              </li>
            ))}
            </ul>
          </div>
        ) : (
          <p>No recent logs.</p>
        )
      ) : null}
    </section>
  );
}
