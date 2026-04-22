import type { RecentLogEntry } from '../api/adminApi';

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
    <section id={sectionId} className="panel-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Recent Logs</h2>
        {selectedDeviceId ? (
          <label style={{ fontSize: '0.9rem' }}>
            Show:{' '}
            <select
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
        <>
          <p>{recentLogsError}</p>
          <button
            type="button"
            onClick={onRetry}
            disabled={recentLogsLoading}
          >
            Retry recent logs
          </button>
        </>
      ) : null}
      {selectedDeviceId && !recentLogsLoading && !recentLogsError ? (
        recentLogs.length > 0 ? (
          <ul>
            {recentLogs.map((entry) => (
              <li key={entry.id || `${entry.ts || ''}-${entry.type || ''}`}>
                <span>{entry.ts || '-'}</span> · <strong>{entry.type || '-'}</strong> ·{' '}
                <span>{entry.functionId || '-'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No recent logs.</p>
        )
      ) : null}
    </section>
  );
}
