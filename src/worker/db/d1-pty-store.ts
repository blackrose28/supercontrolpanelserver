import { D1LikeDatabase } from './d1-device-store';

export type WorkerPtySessionState = 'opening' | 'open' | 'closing' | 'closed' | 'expired' | 'failed';
export type WorkerPendingPtyReqType = 'open' | 'close';
export type WorkerPtyAuditActorType = 'admin_session' | 'admin_api_token' | 'admin_env_token' | 'system';

export interface WorkerPtySessionRecord {
  id: string;
  sessionId: string;
  deviceId: string;
  state: WorkerPtySessionState;
  kind: string;
  serverId: string | null;
  localSessionId: string | null;
  openedByActorType: string | null;
  openedByActorId: string | null;
  attachedActorType: string | null;
  attachedActorId: string | null;
  recordingEnabled: boolean;
  recordingConsentAt: string | null;
  cols: number | null;
  rows: number | null;
  openedAt: string;
  lastAttachedAt: string | null;
  lastDetachedAt: string | null;
  lastOutputAt: string | null;
  closeRequestedAt: string | null;
  closedAt: string | null;
  expiredAt: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  deletedAt?: string | null;
  scrollback: string;
}

export interface WorkerPtyAuditRecord {
  id: string;
  sessionId: string;
  deviceId: string;
  ts: string;
  eventType: string;
  actorType: WorkerPtyAuditActorType | null;
  actorId: string | null;
  summary: string;
  details: unknown;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : value == null ? null : Number(value);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value.length) {
    return value ?? null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mapPtyRow(row: Record<string, unknown>): WorkerPtySessionRecord {
  const kindRaw = nullableString(row.kind);
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    deviceId: String(row.deviceId),
    state: String(row.state) as WorkerPtySessionState,
    kind: kindRaw && kindRaw.trim() ? kindRaw : 'generic',
    serverId: nullableString(row.serverId),
    localSessionId: nullableString(row.localSessionId),
    openedByActorType: nullableString(row.openedByActorType),
    openedByActorId: nullableString(row.openedByActorId),
    attachedActorType: nullableString(row.attachedActorType),
    attachedActorId: nullableString(row.attachedActorId),
    recordingEnabled: Number(row.recordingEnabled ?? 0) === 1,
    recordingConsentAt: nullableString(row.recordingConsentAt),
    cols: nullableNumber(row.cols),
    rows: nullableNumber(row.rows),
    openedAt: String(row.openedAt),
    lastAttachedAt: nullableString(row.lastAttachedAt),
    lastDetachedAt: nullableString(row.lastDetachedAt),
    lastOutputAt: nullableString(row.lastOutputAt),
    closeRequestedAt: nullableString(row.closeRequestedAt),
    closedAt: nullableString(row.closedAt),
    expiredAt: nullableString(row.expiredAt),
    failureCode: nullableString(row.failureCode),
    failureDetail: nullableString(row.failureDetail),
    deletedAt: nullableString(row.deletedAt),
    scrollback: typeof row.scrollback === "string" ? row.scrollback : "",
  };
}

function mapAuditRow(row: Record<string, unknown>): WorkerPtyAuditRecord {
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    deviceId: String(row.deviceId),
    ts: String(row.ts),
    eventType: String(row.eventType),
    actorType: row.actorType == null ? null : String(row.actorType) as WorkerPtyAuditActorType,
    actorId: nullableString(row.actorId),
    summary: String(row.summary),
    details: parseJsonValue(row.detailsJson),
  };
}

export class D1PtySessionStore {
  private readonly pendingByReqSeq = new Map<string, { sessionId: string; type: WorkerPendingPtyReqType }>();
  private readonly openingTimeoutMs = 120_000;
  private readonly detachGraceMs = 30_000;
  private readonly terminalRetentionMs = 7 * 24 * 60 * 60 * 1000;

  constructor(private readonly db: D1LikeDatabase) {}

  async createOpening(input: {
    id: string;
    sessionId: string;
    deviceId: string;
    kind?: string | null;
    serverId?: string | null;
    localSessionId?: string | null;
    cols?: number | null;
    rows?: number | null;
    openedAt: string;
    recordingEnabled?: boolean;
    openedByActorType?: string | null;
    openedByActorId?: string | null;
    attachedActorType?: string | null;
    attachedActorId?: string | null;
  }): Promise<WorkerPtySessionRecord> {
    const kind = typeof input.kind === 'string' && input.kind.trim() ? input.kind.trim() : 'generic';
    const serverId = typeof input.serverId === 'string' && input.serverId.trim() ? input.serverId.trim() : null;
    const localSessionId = typeof input.localSessionId === 'string' && input.localSessionId.trim() ? input.localSessionId.trim() : null;
    await this.db.prepare(`
      INSERT INTO pty_sessions (
        id, sessionId, deviceId, state, openedByActorType, openedByActorId,
        attachedActorType, attachedActorId, recordingEnabled, cols, rows, openedAt, lastAttachedAt,
        kind, serverId, localSessionId
      )
      VALUES (?, ?, ?, 'opening', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        deviceId = excluded.deviceId,
        state = 'opening',
        openedByActorType = excluded.openedByActorType,
        openedByActorId = excluded.openedByActorId,
        attachedActorType = excluded.attachedActorType,
        attachedActorId = excluded.attachedActorId,
        recordingEnabled = excluded.recordingEnabled,
        cols = excluded.cols,
        rows = excluded.rows,
        openedAt = excluded.openedAt,
        lastAttachedAt = excluded.lastAttachedAt,
        kind = excluded.kind,
        serverId = excluded.serverId,
        localSessionId = excluded.localSessionId,
        lastDetachedAt = NULL,
        closedAt = NULL,
        expiredAt = NULL,
        deletedAt = NULL,
        failureCode = NULL,
        failureDetail = NULL
    `).bind(
      input.id,
      input.sessionId,
      input.deviceId,
      input.openedByActorType ?? null,
      input.openedByActorId ?? null,
      input.attachedActorType ?? null,
      input.attachedActorId ?? null,
      input.recordingEnabled ? 1 : 0,
      input.cols ?? null,
      input.rows ?? null,
      input.openedAt,
      input.attachedActorType ? input.openedAt : null,
      kind,
      serverId,
      localSessionId,
    ).run();
    return this.getRequired(input.sessionId);
  }

  async markOpen(sessionId: string, ts: string, localSessionId?: string | null): Promise<WorkerPtySessionRecord> {
    await this.db.prepare(`
      UPDATE pty_sessions SET
        state = 'open',
        lastAttachedAt = COALESCE(lastAttachedAt, ?),
        failureCode = NULL,
        failureDetail = NULL,
        localSessionId = COALESCE(?, localSessionId)
      WHERE sessionId = ?
    `).bind(ts, localSessionId ?? null, sessionId).run();
    return this.getRequired(sessionId);
  }

  async markOpenFailed(sessionId: string, code: string, detail: string | null, ts: string): Promise<WorkerPtySessionRecord> {
    await this.db.prepare(`UPDATE pty_sessions SET state = 'failed', failureCode = ?, failureDetail = ?, closedAt = ? WHERE sessionId = ?`)
      .bind(code, detail, ts, sessionId)
      .run();
    return this.getRequired(sessionId);
  }

  async markClosing(sessionId: string, ts: string): Promise<WorkerPtySessionRecord> {
    await this.db.prepare(`UPDATE pty_sessions SET state = 'closing', closeRequestedAt = ? WHERE sessionId = ?`)
      .bind(ts, sessionId)
      .run();
    return this.getRequired(sessionId);
  }

  async markClosed(sessionId: string, ts: string, reason?: string | null): Promise<WorkerPtySessionRecord> {
    await this.db.prepare(`UPDATE pty_sessions SET state = 'closed', closedAt = ?, failureDetail = COALESCE(?, failureDetail) WHERE sessionId = ?`)
      .bind(ts, reason ?? null, sessionId)
      .run();
    return this.getRequired(sessionId);
  }

  async noteOutput(sessionId: string, ts: string): Promise<WorkerPtySessionRecord> {
    await this.db.prepare(`UPDATE pty_sessions SET lastOutputAt = ? WHERE sessionId = ?`).bind(ts, sessionId).run();
    return this.getRequired(sessionId);
  }

  async markRecordingConsent(sessionId: string, ts: string): Promise<WorkerPtySessionRecord> {
    await this.db.prepare(`UPDATE pty_sessions SET recordingConsentAt = ? WHERE sessionId = ?`).bind(ts, sessionId).run();
    return this.getRequired(sessionId);
  }

  async attach(sessionId: string, actorType: string, actorId: string | null, ts: string): Promise<WorkerPtySessionRecord> {
    await this.db.prepare(`UPDATE pty_sessions SET attachedActorType = ?, attachedActorId = ?, lastAttachedAt = ?, lastDetachedAt = NULL WHERE sessionId = ?`)
      .bind(actorType, actorId, ts, sessionId)
      .run();
    return this.getRequired(sessionId);
  }

  async detach(sessionId: string, ts: string): Promise<WorkerPtySessionRecord> {
    await this.db.prepare(`UPDATE pty_sessions SET attachedActorType = NULL, attachedActorId = NULL, lastDetachedAt = ? WHERE sessionId = ?`)
      .bind(ts, sessionId)
      .run();
    return this.getRequired(sessionId);
  }

  async updateSize(sessionId: string, cols: number, rows: number): Promise<WorkerPtySessionRecord> {
    await this.db.prepare(`UPDATE pty_sessions SET cols = ?, rows = ? WHERE sessionId = ?`).bind(cols, rows, sessionId).run();
    return this.getRequired(sessionId);
  }

  async expireDetachedSessions(nowIso: string): Promise<WorkerPtySessionRecord[]> {
    const cutoffIso = new Date(Date.parse(nowIso) - this.detachGraceMs).toISOString();
    const { results = [] } = await this.db.prepare(`
      SELECT * FROM pty_sessions
      WHERE state = 'open' AND attachedActorType IS NULL AND attachedActorId IS NULL AND lastDetachedAt IS NOT NULL AND lastDetachedAt <= ?
    `).bind(cutoffIso).all<Record<string, unknown>>();
    if (!results.length) return [];
    await this.db.prepare(`
      UPDATE pty_sessions
      SET state = 'expired', expiredAt = ?, failureCode = COALESCE(failureCode, 'DETACH_TIMEOUT'), failureDetail = COALESCE(failureDetail, 'PTY session expired after detach grace window elapsed')
      WHERE state = 'open' AND attachedActorType IS NULL AND attachedActorId IS NULL AND lastDetachedAt IS NOT NULL AND lastDetachedAt <= ?
    `).bind(nowIso, cutoffIso).run();
    return Promise.all(results.map((row) => this.getRequired(String(row.sessionId))));
  }

  async expireDeviceSessions(deviceId: string, nowIso: string, reasonCode: string, reasonDetail: string): Promise<WorkerPtySessionRecord[]> {
    const { results = [] } = await this.db.prepare(`SELECT * FROM pty_sessions WHERE deviceId = ? AND state IN ('opening', 'open', 'closing')`)
      .bind(deviceId).all<Record<string, unknown>>();
    if (!results.length) return [];
    await this.db.prepare(`
      UPDATE pty_sessions SET state = 'expired', expiredAt = ?, failureCode = ?, failureDetail = ?
      WHERE deviceId = ? AND state IN ('opening', 'open', 'closing')
    `).bind(nowIso, reasonCode, reasonDetail, deviceId).run();
    return Promise.all(results.map((row) => this.getRequired(String(row.sessionId))));
  }

  async expireOpeningSessions(nowIso: string, deviceId: string): Promise<WorkerPtySessionRecord[]> {
    const cutoffIso = new Date(Date.parse(nowIso) - this.openingTimeoutMs).toISOString();
    const { results = [] } = await this.db.prepare(
      `SELECT * FROM pty_sessions WHERE deviceId = ? AND state = 'opening' AND openedAt <= ?`
    ).bind(deviceId, cutoffIso).all<Record<string, unknown>>();
    if (!results.length) return [];
    await this.db.prepare(
      `UPDATE pty_sessions SET state = 'expired', expiredAt = ?, failureCode = 'PTY_OPEN_TIMEOUT', failureDetail = 'PTY session did not open within the allowed window' WHERE deviceId = ? AND state = 'opening' AND openedAt <= ?`
    ).bind(nowIso, deviceId, cutoffIso).run();
    return results.map(mapPtyRow);
  }

  trackPendingReq(deviceId: string, reqSeq: number, sessionId: string, type: WorkerPendingPtyReqType): void {
    this.pendingByReqSeq.set(`${deviceId}:${reqSeq}`, { sessionId, type });
  }

  consumePendingReq(deviceId: string, reqSeq: number): { sessionId: string; type: WorkerPendingPtyReqType } | undefined {
    const key = `${deviceId}:${reqSeq}`;
    const pending = this.pendingByReqSeq.get(key);
    if (pending) this.pendingByReqSeq.delete(key);
    return pending;
  }

  async findActiveServerSshSession(deviceId: string, serverId: string): Promise<WorkerPtySessionRecord | undefined> {
    const row = await this.db.prepare(
      `SELECT * FROM pty_sessions WHERE deviceId = ? AND serverId = ? AND kind = 'server_ssh' AND state IN ('opening', 'open') ORDER BY openedAt DESC LIMIT 1`
    ).bind(deviceId, serverId).first<Record<string, unknown>>();
    return row ? mapPtyRow(row) : undefined;
  }

  async get(sessionId: string): Promise<WorkerPtySessionRecord | undefined> {
    const row = await this.db.prepare(`SELECT * FROM pty_sessions WHERE sessionId = ?`).bind(sessionId).first<Record<string, unknown>>();
    return row ? mapPtyRow(row) : undefined;
  }

  async listByDevice(deviceId: string, limit = 50): Promise<WorkerPtySessionRecord[]> {
    const { results = [] } = await this.db.prepare(`SELECT * FROM pty_sessions WHERE deviceId = ? AND deletedAt IS NULL ORDER BY openedAt DESC LIMIT ?`)
      .bind(deviceId, limit).all<Record<string, unknown>>();
    return results.map(mapPtyRow);
  }

  async deleteTerminalSession(sessionId: string, deletedAt = new Date().toISOString()): Promise<WorkerPtySessionRecord | undefined> {
    const record = await this.get(sessionId);
    if (!record) return undefined;
    if (!['closed', 'expired', 'failed'].includes(record.state)) {
      throw new Error(`PTY session is not deletable in state ${record.state}`);
    }
    await this.db.prepare(`UPDATE pty_sessions SET deletedAt = ? WHERE sessionId = ? AND state IN ('closed', 'expired', 'failed')`)
      .bind(deletedAt, sessionId).run();
    return record;
  }

  async pruneTerminalSessions(nowIso: string): Promise<WorkerPtySessionRecord[]> {
    const cutoffIso = new Date(Date.parse(nowIso) - this.terminalRetentionMs).toISOString();
    const { results = [] } = await this.db.prepare(`
      SELECT * FROM pty_sessions
      WHERE state IN ('closed', 'expired', 'failed') AND deletedAt IS NULL AND COALESCE(expiredAt, closedAt, closeRequestedAt, openedAt) <= ?
    `).bind(cutoffIso).all<Record<string, unknown>>();
    if (!results.length) return [];
    await this.db.prepare(`
      UPDATE pty_sessions SET deletedAt = ?
      WHERE state IN ('closed', 'expired', 'failed') AND deletedAt IS NULL AND COALESCE(expiredAt, closedAt, closeRequestedAt, openedAt) <= ?
    `).bind(nowIso, cutoffIso).run();
    return results.map(mapPtyRow);
  }

  terminalRetentionMsValue(): number {
    return this.terminalRetentionMs;
  }

  private async getRequired(sessionId: string): Promise<WorkerPtySessionRecord> {
    const record = await this.get(sessionId);
    if (!record) throw new Error(`PTY session not found: ${sessionId}`);
    return record;
  }

  // --- Scrollback buffer ---

  private readonly maxScrollbackBytes = 32_000;

  async appendScrollback(sessionId: string, data: string): Promise<void> {
    if (!data) return;
    const existing = await this.db.prepare('SELECT scrollback FROM pty_sessions WHERE sessionId = ?').bind(sessionId).first<{ scrollback: string }>();
    const current = existing?.scrollback ?? '';
    let merged = current + data;
    if (merged.length > this.maxScrollbackBytes) {
      merged = merged.slice(merged.length - this.maxScrollbackBytes);
    }
    await this.db.prepare('UPDATE pty_sessions SET scrollback = ? WHERE sessionId = ?').bind(merged, sessionId).run();
  }

  async getScrollback(sessionId: string): Promise<string> {
    const row = await this.db.prepare('SELECT scrollback FROM pty_sessions WHERE sessionId = ?').bind(sessionId).first<{ scrollback: string }>();
    return row?.scrollback ?? '';
  }

}

export class D1PtyAuditStore {
  constructor(private readonly db: D1LikeDatabase) {}

  async append(entry: {
    id: string;
    sessionId: string;
    deviceId: string;
    ts: string;
    eventType: string;
    actorType?: WorkerPtyAuditActorType | null;
    actorId?: string | null;
    summary: string;
    details?: unknown;
  }): Promise<void> {
    await this.db.prepare(`
      INSERT INTO pty_audit (id, sessionId, deviceId, ts, eventType, actorType, actorId, summary, detailsJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.id,
      entry.sessionId,
      entry.deviceId,
      entry.ts,
      entry.eventType,
      entry.actorType ?? null,
      entry.actorId ?? null,
      entry.summary,
      entry.details == null ? null : JSON.stringify(entry.details),
    ).run();
  }

  async listBySession(sessionId: string): Promise<WorkerPtyAuditRecord[]> {
    const { results = [] } = await this.db.prepare(`SELECT * FROM pty_audit WHERE sessionId = ? ORDER BY ts ASC, id ASC`)
      .bind(sessionId).all<Record<string, unknown>>();
    return results.map(mapAuditRow);
  }
}

