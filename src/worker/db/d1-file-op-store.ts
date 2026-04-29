import { D1LikeDatabase } from './d1-device-store';
import { redactTelemetryPayload } from '../../logs/log-redaction';
import { mapFileTransferRow } from '../../file-ops/file-transfer.mappers';
import { FileTransferDirection, FileTransferRecord, FileTransferState } from '../../file-ops/file-transfer.types';
import { isFinishedTransferState, normalizeNullableNonNegativeNumber, normalizePositiveInteger, sanitizeText } from '../../file-ops/file-transfer.validators';

const ACTIVE_STATES = ['queued', 'starting', 'running'];
const FINISHED_STATES = ['succeeded', 'failed', 'canceled'];

function bool(value: boolean | null | undefined): number | null {
  return typeof value === 'boolean' ? (value ? 1 : 0) : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export class D1FileTransferStore {
  constructor(private readonly db: D1LikeDatabase) {}

  async create(input: {
    id: string; transferId: string; deviceId: string; serverId: string; direction: FileTransferDirection;
    actorType?: string | null; actorId?: string | null; browserSessionId?: string | null; sessionId?: string | null;
    localPath?: string | null; remotePath?: string | null; recursive?: boolean; overwritePolicy?: string | null;
    followSymlinks?: boolean; rateLimitKbps?: number | null; verifyChecksum?: boolean; preserveMtime?: boolean; preserveMode?: boolean;
    attempt?: number; maxAttempts?: number; resumeSupported?: boolean; retryScheduled?: boolean; resumeToken?: string | null;
    resumeOffsetBytes?: number | null; tempPathHint?: string | null; commandId?: string | null; reqSeq?: number | null; ts: string;
  }): Promise<FileTransferRecord> {
    await this.db.prepare(`
      INSERT INTO file_transfers (
        id, transferId, deviceId, serverId, browserSessionId, sessionId, actorType, actorId,
        state, direction, localPath, remotePath, recursive, overwritePolicy,
        followSymlinks, rateLimitKbps, verifyChecksum, preserveMtime, preserveMode,
        attempt, maxAttempts, resumeSupported, retryScheduled, resumeToken, resumeOffsetBytes, tempPathHint,
        progressEventCount, firstProgressAt, lastProgressAt, finalizeSeen,
        bytesTransferred, bytesTotal, percent, throughputBps, etaSec, phase,
        reasonCode, reasonDetail, message, commandId, reqSeq, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
    `).bind(
      input.id, input.transferId, input.deviceId, input.serverId, input.browserSessionId ?? null, input.sessionId ?? null,
      input.actorType ?? null, input.actorId ?? null, input.direction, input.localPath ?? null, input.remotePath ?? null,
      input.recursive ? 1 : 0, input.overwritePolicy ?? null, input.followSymlinks ? 1 : 0, input.rateLimitKbps ?? null,
      input.verifyChecksum ? 1 : 0, input.preserveMtime ? 1 : 0, input.preserveMode ? 1 : 0,
      normalizePositiveInteger(input.attempt, 1), normalizePositiveInteger(input.maxAttempts, 1), input.resumeSupported ? 1 : 0,
      input.retryScheduled ? 1 : 0, sanitizeText(input.resumeToken ?? null), normalizeNullableNonNegativeNumber(input.resumeOffsetBytes), sanitizeText(input.tempPathHint ?? null),
      input.commandId ?? null, input.reqSeq ?? null, input.ts, input.ts,
    ).run();
    return this.getRequired(input.transferId);
  }

  async markState(transferId: string, state: FileTransferState, ts: string, fields: {
    phase?: string | null; reasonCode?: string | null; reasonDetail?: string | null; message?: string | null;
    startedAt?: string | null; finishedAt?: string | null; attempt?: number | null; maxAttempts?: number | null;
    resumeSupported?: boolean | null; retryScheduled?: boolean | null; resumeToken?: string | null; resumeOffsetBytes?: number | null; tempPathHint?: string | null;
  } = {}): Promise<FileTransferRecord> {
    const current = await this.getRequired(transferId);
    const startedAt = fields.startedAt ?? current.startedAt ?? (state === 'starting' || state === 'running' ? ts : null);
    const finishedAt = FINISHED_STATES.includes(state) ? (fields.finishedAt ?? ts) : null;
    const finalizeSeen = ACTIVE_STATES.includes(state) ? 0 : fields.phase === 'finalize' ? 1 : (current.finalizeSeen ? 1 : 0);
    await this.db.prepare(`
      UPDATE file_transfers SET state = ?, phase = COALESCE(?, phase), reasonCode = ?, reasonDetail = ?, message = COALESCE(?, message),
        attempt = COALESCE(?, attempt), maxAttempts = COALESCE(?, maxAttempts), resumeSupported = COALESCE(?, resumeSupported), retryScheduled = COALESCE(?, retryScheduled),
        resumeToken = COALESCE(?, resumeToken), resumeOffsetBytes = COALESCE(?, resumeOffsetBytes), tempPathHint = COALESCE(?, tempPathHint),
        finalizeSeen = ?, startedAt = ?, finishedAt = ?, updatedAt = ? WHERE transferId = ?
    `).bind(
      state, fields.phase ?? null, fields.reasonCode ?? null, sanitizeText(fields.reasonDetail ?? null), sanitizeText(fields.message ?? null),
      typeof fields.attempt === 'number' ? normalizePositiveInteger(fields.attempt, 1) : null,
      typeof fields.maxAttempts === 'number' ? normalizePositiveInteger(fields.maxAttempts, 1) : null,
      bool(fields.resumeSupported), bool(fields.retryScheduled), sanitizeText(fields.resumeToken ?? null), normalizeNullableNonNegativeNumber(fields.resumeOffsetBytes), sanitizeText(fields.tempPathHint ?? null),
      finalizeSeen, startedAt, finishedAt, ts, transferId,
    ).run();
    return this.getRequired(transferId);
  }

  async updateProgress(transferId: string, ts: string, progress: {
    bytesTransferred: number; bytesTotal?: number | null; percent?: number | null; throughputBps?: number | null; etaSec?: number | null;
    phase?: string | null; message?: string | null; attempt?: number | null; maxAttempts?: number | null; resumeSupported?: boolean | null;
    retryScheduled?: boolean | null; resumeToken?: string | null; resumeOffsetBytes?: number | null; tempPathHint?: string | null;
  }): Promise<FileTransferRecord> {
    const current = await this.getRequired(transferId);
    const state = ['queued', 'failed', 'canceled', 'succeeded'].includes(current.state) ? 'running' : current.state;
    await this.db.prepare(`
      UPDATE file_transfers SET state = ?, bytesTransferred = ?, bytesTotal = COALESCE(?, bytesTotal), percent = ?, throughputBps = ?, etaSec = ?,
        phase = COALESCE(?, phase), message = COALESCE(?, message), attempt = COALESCE(?, attempt), maxAttempts = COALESCE(?, maxAttempts),
        resumeSupported = COALESCE(?, resumeSupported), retryScheduled = COALESCE(?, retryScheduled), resumeToken = COALESCE(?, resumeToken),
        resumeOffsetBytes = COALESCE(?, resumeOffsetBytes), tempPathHint = COALESCE(?, tempPathHint), progressEventCount = progressEventCount + 1,
        firstProgressAt = COALESCE(firstProgressAt, ?), lastProgressAt = ?, finalizeSeen = CASE WHEN ? = 'finalize' THEN 1 ELSE finalizeSeen END,
        startedAt = COALESCE(startedAt, ?), finishedAt = NULL, updatedAt = ? WHERE transferId = ?
    `).bind(
      state, progress.bytesTransferred, progress.bytesTotal ?? null, progress.percent ?? null, progress.throughputBps ?? null, progress.etaSec ?? null,
      progress.phase ?? null, sanitizeText(progress.message ?? null), typeof progress.attempt === 'number' ? normalizePositiveInteger(progress.attempt, 1) : null,
      typeof progress.maxAttempts === 'number' ? normalizePositiveInteger(progress.maxAttempts, 1) : null, bool(progress.resumeSupported), bool(progress.retryScheduled),
      sanitizeText(progress.resumeToken ?? null), normalizeNullableNonNegativeNumber(progress.resumeOffsetBytes), sanitizeText(progress.tempPathHint ?? null),
      ts, ts, progress.phase ?? null, ts, ts, transferId,
    ).run();
    return this.getRequired(transferId);
  }

  async attachSession(transferId: string, sessionId: string, ts: string): Promise<FileTransferRecord> {
    await this.db.prepare('UPDATE file_transfers SET sessionId = ?, updatedAt = ? WHERE transferId = ?').bind(sessionId, ts, transferId).run();
    return this.getRequired(transferId);
  }

  async attachCommand(transferId: string, commandId: string, reqSeq: number | null, ts: string): Promise<FileTransferRecord> {
    await this.db.prepare('UPDATE file_transfers SET commandId = ?, reqSeq = ?, updatedAt = ? WHERE transferId = ?').bind(commandId, reqSeq, ts, transferId).run();
    return this.getRequired(transferId);
  }

  async prepareForResume(transferId: string, ts: string, fields: { attempt?: number | null; maxAttempts?: number | null; resumeSupported?: boolean | null; retryScheduled?: boolean | null; resumeToken?: string | null; resumeOffsetBytes?: number | null; tempPathHint?: string | null; message?: string | null; }): Promise<FileTransferRecord> {
    await this.db.prepare(`
      UPDATE file_transfers SET state = 'queued', phase = 'precheck', reasonCode = NULL, reasonDetail = NULL, message = COALESCE(?, message),
        attempt = COALESCE(?, attempt), maxAttempts = COALESCE(?, maxAttempts), resumeSupported = COALESCE(?, resumeSupported), retryScheduled = COALESCE(?, retryScheduled),
        resumeToken = COALESCE(?, resumeToken), resumeOffsetBytes = COALESCE(?, resumeOffsetBytes), tempPathHint = COALESCE(?, tempPathHint), finalizeSeen = 0, finishedAt = NULL, updatedAt = ?
      WHERE transferId = ?
    `).bind(sanitizeText(fields.message ?? null), typeof fields.attempt === 'number' ? normalizePositiveInteger(fields.attempt, 1) : null, typeof fields.maxAttempts === 'number' ? normalizePositiveInteger(fields.maxAttempts, 1) : null, bool(fields.resumeSupported), bool(fields.retryScheduled), sanitizeText(fields.resumeToken ?? null), normalizeNullableNonNegativeNumber(fields.resumeOffsetBytes), sanitizeText(fields.tempPathHint ?? null), ts, transferId).run();
    return this.getRequired(transferId);
  }

  async deleteFinishedByDevice(deviceId: string): Promise<{ deletedCount: number }> {
    const result = await this.db.prepare(`DELETE FROM file_transfers WHERE deviceId = ? AND state IN ('succeeded', 'failed', 'canceled')`).bind(deviceId).run() as { changes?: number };
    return { deletedCount: Number(result.changes ?? 0) };
  }

  async deleteAny(transferId: string): Promise<FileTransferRecord | undefined> {
    const record = await this.get(transferId);
    if (!record) return undefined;
    await this.db.prepare('DELETE FROM file_transfers WHERE transferId = ?').bind(transferId).run();
    return record;
  }

  async deleteFinished(transferId: string): Promise<FileTransferRecord | undefined> {
    const record = await this.get(transferId);
    if (!record) return undefined;
    if (!isFinishedTransferState(record.state)) throw new Error(`File transfer is not finished: ${transferId}`);
    await this.db.prepare('DELETE FROM file_transfers WHERE transferId = ?').bind(transferId).run();
    return record;
  }

  async get(transferId: string): Promise<FileTransferRecord | undefined> {
    const row = await this.db.prepare('SELECT * FROM file_transfers WHERE transferId = ?').bind(transferId).first<Record<string, unknown>>();
    return row ? mapFileTransferRow(row) : undefined;
  }

  async listByDevice(deviceId: string, limit = 100): Promise<FileTransferRecord[]> {
    const { results = [] } = await this.db.prepare('SELECT * FROM file_transfers WHERE deviceId = ? ORDER BY updatedAt DESC, createdAt DESC LIMIT ?').bind(deviceId, limit).all<Record<string, unknown>>();
    return results.map(mapFileTransferRow);
  }

  async listCompletedSince(sinceIso: string, deviceId?: string): Promise<FileTransferRecord[]> {
    const device = typeof deviceId === 'string' ? deviceId.trim() : '';
    const sql = device
      ? `SELECT * FROM file_transfers WHERE deviceId = ? AND state IN ('succeeded', 'failed', 'canceled') AND COALESCE(finishedAt, updatedAt) >= ? ORDER BY COALESCE(finishedAt, updatedAt) DESC`
      : `SELECT * FROM file_transfers WHERE state IN ('succeeded', 'failed', 'canceled') AND COALESCE(finishedAt, updatedAt) >= ? ORDER BY COALESCE(finishedAt, updatedAt) DESC`;
    const statement = this.db.prepare(sql);
    const { results = [] } = device ? await statement.bind(device, sinceIso).all<Record<string, unknown>>() : await statement.bind(sinceIso).all<Record<string, unknown>>();
    return results.map(mapFileTransferRow);
  }

  async countActiveByDevice(deviceId: string): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) as count FROM file_transfers WHERE deviceId = ? AND state IN ('queued', 'starting', 'running')`).bind(deviceId).first<{ count?: number }>();
    return Number(row?.count ?? 0);
  }

  async listActive(limit = 100): Promise<FileTransferRecord[]> {
    const { results = [] } = await this.db.prepare(`SELECT * FROM file_transfers WHERE state IN ('queued', 'starting', 'running', 'failed') ORDER BY updatedAt DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
    return results.map(mapFileTransferRow);
  }

  async countActive(): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) as count FROM file_transfers WHERE state IN ('queued', 'starting', 'running')`).first<{ count?: number }>();
    return Number(row?.count ?? 0);
  }

  async sumTransferredBytesSince(sinceIso: string): Promise<number> {
    const row = await this.db.prepare(`SELECT COALESCE(SUM(bytesTransferred), 0) as total FROM file_transfers WHERE state IN ('succeeded', 'failed', 'canceled') AND COALESCE(finishedAt, updatedAt) >= ?`).bind(sinceIso).first<{ total?: number }>();
    return Number(row?.total ?? 0);
  }

  private async getRequired(transferId: string): Promise<FileTransferRecord> {
    const record = await this.get(transferId);
    if (!record) throw new Error(`File transfer not found: ${transferId}`);
    return record;
  }
}

export type WorkerRemoteBrowserSessionState = 'opening' | 'open' | 'closed' | 'failed';
export interface WorkerRemoteBrowserSessionRecord {
  id: string; browserSessionId: string; deviceId: string; serverId: string; actorType: string | null; actorId: string | null;
  state: WorkerRemoteBrowserSessionState; rootPath: string | null; currentPath: string | null; failureCode: string | null; failureDetail: string | null;
  openedAt: string; lastActiveAt: string | null; closedAt: string | null; createdAt: string; updatedAt: string;
}

function mapBrowserRow(row: Record<string, unknown>): WorkerRemoteBrowserSessionRecord {
  return {
    id: String(row.id), browserSessionId: String(row.browserSessionId), deviceId: String(row.deviceId), serverId: String(row.serverId),
    actorType: nullableString(row.actorType), actorId: nullableString(row.actorId), state: String(row.state) as WorkerRemoteBrowserSessionState,
    rootPath: nullableString(row.rootPath), currentPath: nullableString(row.currentPath), failureCode: nullableString(row.failureCode), failureDetail: nullableString(row.failureDetail),
    openedAt: String(row.openedAt), lastActiveAt: nullableString(row.lastActiveAt), closedAt: nullableString(row.closedAt), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
  };
}

export class D1RemoteBrowserSessionStore {
  constructor(private readonly db: D1LikeDatabase) {}

  async createOpening(input: { id: string; browserSessionId: string; deviceId: string; serverId: string; actorType?: string | null; actorId?: string | null; openedAt: string; rootPath?: string | null; }): Promise<WorkerRemoteBrowserSessionRecord> {
    await this.db.prepare(`
      INSERT INTO remote_browser_sessions (id, browserSessionId, deviceId, serverId, actorType, actorId, state, rootPath, currentPath, failureCode, failureDetail, openedAt, lastActiveAt, closedAt, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, 'opening', ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)
    `).bind(input.id, input.browserSessionId, input.deviceId, input.serverId, input.actorType ?? null, input.actorId ?? null, input.rootPath ?? null, input.rootPath ?? null, input.openedAt, input.openedAt, input.openedAt, input.openedAt).run();
    return this.getRequired(input.browserSessionId);
  }

  async markOpen(browserSessionId: string, ts: string, rootPath?: string | null): Promise<WorkerRemoteBrowserSessionRecord> {
    await this.db.prepare(`UPDATE remote_browser_sessions SET state = 'open', rootPath = COALESCE(?, rootPath), currentPath = COALESCE(?, currentPath), failureCode = NULL, failureDetail = NULL, lastActiveAt = ?, updatedAt = ? WHERE browserSessionId = ?`).bind(rootPath ?? null, rootPath ?? null, ts, ts, browserSessionId).run();
    return this.getRequired(browserSessionId);
  }

  async noteActivity(browserSessionId: string, ts: string, currentPath?: string | null): Promise<WorkerRemoteBrowserSessionRecord> {
    await this.db.prepare(`UPDATE remote_browser_sessions SET currentPath = COALESCE(?, currentPath), lastActiveAt = ?, updatedAt = ? WHERE browserSessionId = ?`).bind(currentPath ?? null, ts, ts, browserSessionId).run();
    return this.getRequired(browserSessionId);
  }

  async markFailed(browserSessionId: string, code: string, detail: string | null, ts: string): Promise<WorkerRemoteBrowserSessionRecord> {
    await this.db.prepare(`UPDATE remote_browser_sessions SET state = 'failed', failureCode = ?, failureDetail = ?, closedAt = COALESCE(closedAt, ?), updatedAt = ? WHERE browserSessionId = ?`).bind(code, redactTelemetryPayload(detail), ts, ts, browserSessionId).run();
    return this.getRequired(browserSessionId);
  }

  async markClosed(browserSessionId: string, ts: string, detail?: string | null): Promise<WorkerRemoteBrowserSessionRecord> {
    await this.db.prepare(`UPDATE remote_browser_sessions SET state = 'closed', failureDetail = COALESCE(?, failureDetail), closedAt = COALESCE(closedAt, ?), updatedAt = ? WHERE browserSessionId = ?`).bind(redactTelemetryPayload(detail ?? null), ts, ts, browserSessionId).run();
    return this.getRequired(browserSessionId);
  }

  async get(browserSessionId: string): Promise<WorkerRemoteBrowserSessionRecord | undefined> {
    const row = await this.db.prepare('SELECT * FROM remote_browser_sessions WHERE browserSessionId = ?').bind(browserSessionId).first<Record<string, unknown>>();
    return row ? mapBrowserRow(row) : undefined;
  }

  async listByDevice(deviceId: string, limit = 100): Promise<WorkerRemoteBrowserSessionRecord[]> {
    const { results = [] } = await this.db.prepare('SELECT * FROM remote_browser_sessions WHERE deviceId = ? ORDER BY updatedAt DESC, createdAt DESC LIMIT ?').bind(deviceId, limit).all<Record<string, unknown>>();
    return results.map(mapBrowserRow);
  }

  async countActiveByDevice(deviceId: string): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) as count FROM remote_browser_sessions WHERE deviceId = ? AND state IN ('opening', 'open')`).bind(deviceId).first<{ count?: number }>();
    return Number(row?.count ?? 0);
  }

  async countActive(): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) as count FROM remote_browser_sessions WHERE state IN ('opening', 'open')`).first<{ count?: number }>();
    return Number(row?.count ?? 0);
  }

  async expireStaleActive(ts: string, maxIdleMs: number, maxOpeningMs = maxIdleMs): Promise<number> {
    const staleOpeningBefore = new Date(Date.parse(ts) - maxOpeningMs).toISOString();
    const staleActiveBefore = new Date(Date.parse(ts) - maxIdleMs).toISOString();
    const result = await this.db.prepare(`
      UPDATE remote_browser_sessions
      SET state = 'closed', failureCode = COALESCE(failureCode, 'BROWSER_SESSION_EXPIRED'),
        failureDetail = COALESCE(failureDetail, CASE WHEN state = 'opening' THEN 'Remote browser session expired while opening' ELSE 'Remote browser session expired after inactivity' END),
        closedAt = COALESCE(closedAt, ?), updatedAt = ?
      WHERE state IN ('opening', 'open') AND ((state = 'opening' AND openedAt <= ?) OR (state = 'open' AND COALESCE(lastActiveAt, openedAt) <= ?))
    `).bind(ts, ts, staleOpeningBefore, staleActiveBefore).run() as { changes?: number };
    return Number(result.changes ?? 0);
  }

  private async getRequired(browserSessionId: string): Promise<WorkerRemoteBrowserSessionRecord> {
    const record = await this.get(browserSessionId);
    if (!record) throw new Error(`Remote browser session not found: ${browserSessionId}`);
    return record;
  }
}
