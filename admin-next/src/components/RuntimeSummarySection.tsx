import type { RuntimeSummary } from '../api/adminApi';

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
  return (
    <section className="panel-section">
      <h2>Runtime Summary</h2>
      {!selectedDeviceId ? <p>Select a device to load runtime summary.</p> : null}
      {runtimeSummaryLoading ? <p>Loading runtime summary…</p> : null}
      {runtimeSummaryError ? (
        <>
          <p>{runtimeSummaryError}</p>
          <button
            type="button"
            onClick={onRetry}
            disabled={runtimeSummaryLoading}
          >
            Retry runtime summary
          </button>
        </>
      ) : null}
      {runtimeSummary && !runtimeSummaryLoading && !runtimeSummaryError ? (
        <>
          <p>Updated: {runtimeSummary.updatedAt || '-'}</p>
          <h3>Functions</h3>
          {Object.entries(runtimeSummary.functions || {}).length > 0 ? (
            <ul>
              {Object.entries(runtimeSummary.functions || {}).map(([functionId, entry]) => (
                <li key={functionId}>
                  <strong>{functionId}</strong>: {entry?.state ? String(entry.state) : '-'}
                </li>
              ))}
            </ul>
          ) : (
            <p>No functions reported.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
