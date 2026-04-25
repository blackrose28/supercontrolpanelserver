import { useState, type FormEvent } from 'react';
import type { InventoryServer, ScpTransferDirection, ScpTransferPayload, TransferEntry } from '../api/adminApi';
import { formatTimestamp } from '../utils/formatTimestamp';

type TransfersSectionProps = {
  selectedDeviceId: string | null;
  transfersLoading: boolean;
  transfersError: string | null;
  transfers: TransferEntry[];
  transfersLimit: number;
  transferActionLoading: boolean;
  transferStartLoading: boolean;
  activeTransferId: string | null;
  servers: InventoryServer[];
  onRefresh: () => void;
  onStopTransfer: (transferId: string) => void;
  onDismissTransfer: (transferId: string) => void;
  onForceRemoveTransfer: (transferId: string) => void;
  onResumeTransfer: (transferId: string) => void;
  onStartTransfer: (deviceId: string, direction: ScpTransferDirection, payload: ScpTransferPayload) => void;
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

function clampTransferPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
}

function effectiveBytesTransferred(entry: TransferEntry): number | undefined {
  if (
    entry.state === 'succeeded'
    && typeof entry.bytesTotal === 'number'
    && Number.isFinite(entry.bytesTotal)
  ) {
    return entry.bytesTotal;
  }
  return typeof entry.bytesTransferred === 'number' && Number.isFinite(entry.bytesTransferred)
    ? entry.bytesTransferred
    : undefined;
}

function transferProgressPercent(entry: TransferEntry): number | null {
  if (typeof entry.percent === 'number' && Number.isFinite(entry.percent)) {
    return clampTransferPercent(entry.percent);
  }

  const bytesTransferred = effectiveBytesTransferred(entry);
  if (
    typeof bytesTransferred === 'number'
    && typeof entry.bytesTotal === 'number'
    && Number.isFinite(entry.bytesTotal)
    && entry.bytesTotal > 0
  ) {
    return clampTransferPercent((bytesTransferred / entry.bytesTotal) * 100);
  }

  return null;
}

function formatProgress(entry: TransferEntry): string | null {
  const percent = transferProgressPercent(entry);
  if (percent === null) {
    return null;
  }
  return `Progress: ${percent.toFixed(percent >= 10 ? 1 : 2)}%`;
}

function formatTransferred(entry: TransferEntry): string | null {
  const bytesTransferred = effectiveBytesTransferred(entry);
  if (typeof bytesTransferred !== 'number' || typeof entry.bytesTotal !== 'number') {
    return null;
  }
  return `Transferred: ${bytesTransferred} / ${entry.bytesTotal} bytes`;
}

function progressLabel(entry: TransferEntry): string {
  const percent = transferProgressPercent(entry);
  if (percent !== null) {
    return `${percent.toFixed(percent >= 10 ? 1 : 2)}%`;
  }

  const transferred = formatTransferred(entry);
  if (transferred) {
    return transferred.replace('Transferred: ', '');
  }

  return entry.state === 'running' ? 'Live progress…' : 'No progress reported';
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
  transferStartLoading,
  activeTransferId,
  servers,
  onRefresh,
  onStopTransfer,
  onDismissTransfer,
  onForceRemoveTransfer,
  onResumeTransfer,
  onStartTransfer,
  onDismissFinished,
  onLimitChange,
}: TransfersSectionProps) {
  const [direction, setDirection] = useState<ScpTransferDirection>('upload');
  const [selectedServerId, setSelectedServerId] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [overwritePolicy, setOverwritePolicy] = useState<ScpTransferPayload['overwritePolicy']>('prompt');
  const [rateLimitKbps, setRateLimitKbps] = useState('');
  const [recursive, setRecursive] = useState(false);
  const [verifyChecksum, setVerifyChecksum] = useState(false);
  const [followSymlinks, setFollowSymlinks] = useState(false);
  const [preserveMtime, setPreserveMtime] = useState(false);
  const [preserveMode, setPreserveMode] = useState(false);
  const serverOptions = servers.filter((server) => typeof server.id === 'string' && server.id.trim());
  const effectiveServerId = selectedServerId || String(serverOptions[0]?.id || '');
  const selectedServer = serverOptions.find((server) => server.id === effectiveServerId) || null;
  const canStartTransfer = Boolean(selectedDeviceId && effectiveServerId && localPath.trim() && remotePath.trim() && !transferStartLoading);

  function handleStartTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDeviceId || !effectiveServerId || !localPath.trim() || !remotePath.trim()) {
      return;
    }

    const parsedRateLimit = Number(rateLimitKbps);
    onStartTransfer(selectedDeviceId, direction, {
      serverId: effectiveServerId,
      localPath: localPath.trim(),
      remotePath: remotePath.trim(),
      recursive,
      overwritePolicy,
      verifyChecksum,
      followSymlinks,
      preserveMtime,
      preserveMode,
      rateLimitKbps: Number.isFinite(parsedRateLimit) && parsedRateLimit > 0 ? parsedRateLimit : null,
    });
  }

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
      {selectedDeviceId ? (
        <form className="transfer-launch-card" onSubmit={handleStartTransfer}>
          <div>
            <h3>Start server transfer</h3>
            <p className="transfer-launch-subtitle">
              Launch SCP uploads or downloads through the selected device; progress appears in the transfer queue.
            </p>
          </div>
          {serverOptions.length > 0 ? (
            <>
              <div className="transfer-launch-grid">
                <label className="transfer-launch-field">
                  Server
                  <select
                    aria-label="Transfer server"
                    value={effectiveServerId}
                    onChange={(event) => setSelectedServerId(event.target.value)}
                    disabled={transferStartLoading}
                  >
                    {serverOptions.map((server) => {
                      const serverId = String(server.id || '');
                      return (
                        <option key={serverId} value={serverId}>
                          {server.name || serverId}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <label className="transfer-launch-field">
                  Direction
                  <select
                    aria-label="Transfer direction"
                    value={direction}
                    onChange={(event) => setDirection(event.target.value as ScpTransferDirection)}
                    disabled={transferStartLoading}
                  >
                    <option value="upload">Upload to server</option>
                    <option value="download">Download from server</option>
                  </select>
                </label>
                <label className="transfer-launch-field">
                  Local path
                  <input
                    aria-label="Local path"
                    type="text"
                    value={localPath}
                    onChange={(event) => setLocalPath(event.target.value)}
                    placeholder="/local/path or C:\\path\\file"
                    disabled={transferStartLoading}
                  />
                </label>
                <label className="transfer-launch-field">
                  Remote path
                  <input
                    aria-label="Remote path"
                    type="text"
                    value={remotePath}
                    onChange={(event) => setRemotePath(event.target.value)}
                    placeholder="/remote/path"
                    disabled={transferStartLoading}
                  />
                </label>
                <label className="transfer-launch-field">
                  If destination exists
                  <select
                    aria-label="If destination exists"
                    value={overwritePolicy}
                    onChange={(event) => setOverwritePolicy(event.target.value as ScpTransferPayload['overwritePolicy'])}
                    disabled={transferStartLoading}
                  >
                    <option value="prompt">Ask / fail with guidance</option>
                    <option value="force">Overwrite existing destination</option>
                    <option value="skip">Skip transfer if destination exists</option>
                  </select>
                </label>
                <label className="transfer-launch-field">
                  Rate limit KB/s
                  <input
                    aria-label="Rate limit KB/s"
                    type="number"
                    min="1"
                    step="1"
                    value={rateLimitKbps}
                    onChange={(event) => setRateLimitKbps(event.target.value)}
                    placeholder="optional"
                    disabled={transferStartLoading}
                  />
                </label>
              </div>
              {selectedServer ? (
                <p className="transfer-launch-server-meta">
                  {selectedServer.name || selectedServer.id} · {selectedServer.connectionMethod || 'unknown'} · {selectedServer.host || 'no host'}{selectedServer.sshUser ? ` · ${selectedServer.sshUser}` : ''}
                </p>
              ) : null}
              <div className="transfer-launch-options">
                <label><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} disabled={transferStartLoading} /> Recursive</label>
                <label><input type="checkbox" checked={verifyChecksum} onChange={(event) => setVerifyChecksum(event.target.checked)} disabled={transferStartLoading} /> Verify checksum</label>
                <label><input type="checkbox" checked={followSymlinks} onChange={(event) => setFollowSymlinks(event.target.checked)} disabled={transferStartLoading} /> Follow symlinks</label>
                <label><input type="checkbox" checked={preserveMtime} onChange={(event) => setPreserveMtime(event.target.checked)} disabled={transferStartLoading} /> Preserve mtime</label>
                <label><input type="checkbox" checked={preserveMode} onChange={(event) => setPreserveMode(event.target.checked)} disabled={transferStartLoading} /> Preserve mode</label>
              </div>
              <div className="transfer-launch-actions">
                <button className="transfer-action-button transfer-action-button-primary" type="submit" disabled={!canStartTransfer}>
                  {transferStartLoading ? 'Starting…' : `Start ${direction}`}
                </button>
              </div>
            </>
          ) : (
            <p className="transfer-launch-subtitle">No servers are available in the selected device inventory yet. Request inventory first.</p>
          )}
        </form>
      ) : null}
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
                <div className={`transfer-progress ${transferProgressPercent(entry) === null && entry.state === 'running' ? 'indeterminate' : ''}`.trim()}>
                  <div
                    className="transfer-progress-track"
                    role="progressbar"
                    aria-label={`Transfer progress ${entry.transferId}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    {...(transferProgressPercent(entry) !== null ? { 'aria-valuenow': transferProgressPercent(entry) as number } : {})}
                  >
                    <div className="transfer-progress-bar" style={{ width: `${transferProgressPercent(entry) ?? 0}%` }} />
                  </div>
                  <div className="transfer-progress-label">{progressLabel(entry)}</div>
                </div>
                {formatProgress(entry) ? <div className="transfer-card-meta">{formatProgress(entry)}</div> : null}
                {formatTransferred(entry) ? <div className="transfer-card-meta">{formatTransferred(entry)}</div> : null}
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
