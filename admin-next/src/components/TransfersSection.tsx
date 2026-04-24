import type { TransferEntry } from '../api/adminApi';
import { formatTimestamp } from '../utils/formatTimestamp';

type TransfersSectionProps = {
  selectedDeviceId: string | null;
  transfersLoading: boolean;
  transfersError: string | null;
  transfers: TransferEntry[];
  transfersLimit: number;
  transferActionLoading: boolean;
  activeTransferId: string | null;
  onRefresh: () => void;
  onStopTransfer: (transferId: string) => void;
  onDismissTransfer: (transferId: string) => void;
  onForceRemoveTransfer: (transferId: string) => void;
  onResumeTransfer: (transferId: string) => void;
  onDismissFinished: () => void;
  onLimitChange: (limit: number) => void;
};

function isTerminalState(state?: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'canceled';
}

function canStop(entry: TransferEntry): boolean {
  return !isTerminalState(entry.state) && !!entry.sessionId;
}

function canForceRemove(entry: TransferEntry): boolean {
  return !isTerminalState(entry.state) && !entry.sessionId;
}

function canDismiss(entry: TransferEntry): boolean {
  return isTerminalState(entry.state);
}

function canResume(entry: TransferEntry): boolean {
  return (
    (entry.state === 'failed' || entry.state === 'canceled')
    && entry.resumeSupported === true
    && !!entry.resumeToken
    && typeof entry.resumeOffsetBytes === 'number'
    && entry.resumeOffsetBytes > 0
    && !!entry.tempPathHint
    && (entry.direction === 'upload' || entry.direction === 'download')
  );
}

function resumeUnavailableReason(entry: TransferEntry): string | null {
  if (!(entry.state === 'failed' || entry.state === 'canceled')) {
    return null;
  }
  if (canResume(entry)) {
    return null;
  }
  if (entry.resumeSupported !== true) {
    return null;
  }
  return 'Resume unavailable: missing resume metadata.';
}

function transferActionLabel(action: 'stop' | 'dismiss' | 'force-remove' | 'resume', isActive: boolean): string {
  if (!isActive) {
    if (action === 'force-remove') {
      return 'Force remove';
    }
    return action[0].toUpperCase() + action.slice(1);
  }
  if (action === 'resume') {
    return 'Resuming…';
  }
  return action === 'force-remove' ? 'Removing…' : `${action[0].toUpperCase() + action.slice(1)}…`;
}

function clearFinishedLabel(isActive: boolean): string {
  return isActive ? 'Clearing…' : 'Clear finished';
}

function formatProgress(percent?: number): string | null {
  if (typeof percent !== 'number' || Number.isNaN(percent)) {
    return null;
  }
  return `Progress: ${percent.toFixed(percent >= 10 ? 1 : 2)}%`;
}

function formatTransferred(bytesTransferred?: number, bytesTotal?: number): string | null {
  if (typeof bytesTransferred !== 'number' || typeof bytesTotal !== 'number') {
    return null;
  }
  return `Transferred: ${bytesTransferred} / ${bytesTotal} bytes`;
}

function formatRate(rate?: number): string | null {
  if (typeof rate !== 'number') {
    return null;
  }
  return `Rate: ${rate} B/s`;
}

function formatEta(etaSec?: number): string | null {
  if (typeof etaSec !== 'number') {
    return null;
  }
  return `ETA: ${etaSec}s`;
}

function formatReason(entry: TransferEntry): string | null {
  if (!entry.reasonCode) {
    return null;
  }
  return `Reason: ${entry.reasonCode}${entry.reasonDetail ? ` ${entry.reasonDetail}` : ''}`;
}

export function TransfersSection({
  selectedDeviceId,
  transfersLoading,
  transfersError,
  transfers,
  transfersLimit,
  transferActionLoading,
  activeTransferId,
  onRefresh,
  onStopTransfer,
  onDismissTransfer,
  onForceRemoveTransfer,
  onResumeTransfer,
  onDismissFinished,
  onLimitChange,
}: TransfersSectionProps) {
  return (
    <section className="panel-section transfers-section">
      <div className="transfers-section-header">
        <div>
          <h2>Transfer Activity</h2>
          <p className="transfers-section-subtitle">
            Monitor active transfers, stalled work, and recovery actions from one place.
          </p>
        </div>
        <div className="transfers-toolbar">
          {selectedDeviceId ? (
            <>
              <p className="transfers-toolbar-caption">Showing up to {transfersLimit} transfers</p>
              <label className="transfers-toolbar-label toolbar-limit-field">
                Show:{' '}
              <select
                aria-label="Transfer history limit"
                className="transfers-toolbar-select"
                value={transfersLimit}
                onChange={(e) => onLimitChange(Number(e.target.value))}
                disabled={transfersLoading}
              >
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
              </select>
              </label>
            </>
          ) : null}
          <button className="transfers-toolbar-button" type="button" onClick={onRefresh} disabled={!selectedDeviceId || transfersLoading}>
            Refresh transfers
          </button>
          <button
            className="transfers-toolbar-button"
            type="button"
            onClick={onDismissFinished}
            disabled={!selectedDeviceId || transfersLoading || transferActionLoading || !transfers.some(canDismiss)}
          >
            {clearFinishedLabel(transferActionLoading && activeTransferId === null)}
          </button>
        </div>
      </div>
      {!selectedDeviceId ? <p>Select a device to load transfer activity.</p> : null}
      {transfersLoading ? <p>Loading transfers…</p> : null}
      {transfersError ? <p>{transfersError}</p> : null}
      {selectedDeviceId && !transfersLoading && !transfersError ? (
        transfers.length > 0 ? (
          <>
            <div className="transfers-list-heading">Transfer queue</div>
            <ul>
            {transfers.map((entry) => (
              <li key={entry.transferId} className="transfer-card">
                <div className="transfer-card-head">
                  <strong>{entry.direction || '-'}</strong>
                  <span className="transfer-state-badge">{entry.state || '-'}</span>
                </div>
                <div className="transfer-card-meta">Updated: {formatTimestamp(entry.updatedAt)}</div>
                {entry.phase ? <div className="transfer-card-meta">Phase: {entry.phase}</div> : null}
                {formatProgress(entry.percent) ? <div className="transfer-card-meta">{formatProgress(entry.percent)}</div> : null}
                {formatTransferred(entry.bytesTransferred, entry.bytesTotal) ? <div className="transfer-card-meta">{formatTransferred(entry.bytesTransferred, entry.bytesTotal)}</div> : null}
                {formatRate(entry.throughputBps) ? <div className="transfer-card-meta">{formatRate(entry.throughputBps)}</div> : null}
                {formatEta(entry.etaSec) ? <div className="transfer-card-meta">{formatEta(entry.etaSec)}</div> : null}
                {formatReason(entry) ? <div className="transfer-card-meta">{formatReason(entry)}</div> : null}
                <div className="transfer-actions-row">
                  {canStop(entry) ? (
                    <button
                      className="transfer-action-button"
                      type="button"
                      onClick={() => onStopTransfer(entry.transferId)}
                      disabled={transferActionLoading}
                    >
                      {transferActionLabel('stop', transferActionLoading && activeTransferId === entry.transferId)}
                    </button>
                  ) : null}
                  {canDismiss(entry) ? (
                    <button
                      className="transfer-action-button"
                      type="button"
                      onClick={() => onDismissTransfer(entry.transferId)}
                      disabled={transferActionLoading}
                    >
                      {transferActionLabel('dismiss', transferActionLoading && activeTransferId === entry.transferId)}
                    </button>
                  ) : null}
                  {canForceRemove(entry) ? (
                    <button
                      className="transfer-action-button"
                      type="button"
                      onClick={() => onForceRemoveTransfer(entry.transferId)}
                      disabled={transferActionLoading}
                    >
                      {transferActionLabel('force-remove', transferActionLoading && activeTransferId === entry.transferId)}
                    </button>
                  ) : null}
                  {canResume(entry) ? (
                    <button
                      className="transfer-action-button"
                      type="button"
                      onClick={() => onResumeTransfer(entry.transferId)}
                      disabled={transferActionLoading}
                    >
                      {transferActionLabel('resume', transferActionLoading && activeTransferId === entry.transferId)}
                    </button>
                  ) : null}
                  {resumeUnavailableReason(entry) ? (
                    <div className="transfer-card-meta">{resumeUnavailableReason(entry)}</div>
                  ) : null}
                </div>
              </li>
            ))}
            </ul>
          </>
        ) : (
          <p>No transfer activity found.</p>
        )
      ) : null}
    </section>
  );
}
