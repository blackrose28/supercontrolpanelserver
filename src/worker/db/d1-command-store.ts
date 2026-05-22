import { D1LikeDatabase } from './d1-device-store';
import { redactTelemetryPayload } from '../../legacy/logs/log-redaction';

export type WorkerCommandState = 'queued' | 'dispatched' | 'executing' | 'succeeded' | 'failed' | 'canceled';
export type WorkerCommandActorType = 'admin_session' | 'admin_api_token' | 'admin_env_token' | 'system';
export type WorkerCommandAuditEventType = 'created' | 'dispatched' | 'acknowledged' | 'executing' | 'succeeded' | 'failed' | 'canceled' | 'reconciled';

export type WorkerCommandRecord = {
  id: string;
  commandId: string;
  deviceId: string;
  commandType: string;
  state: WorkerCommandState;
  actorType: WorkerCommandActorType;
  actorId: string | null;
  payload: unknown;
  payloadSummary: string | null;
  submittedAt: string;
  dispatchedAt: string | null;
  executingAt: string | null;
  finishedAt: string | null;
  outcome: string | null;
  reasonCode: string | null;
  reasonDetail: string | null;
  reqSeq: number | null;
};

export type WorkerCommandAuditRecord = {
  id: string;
  commandId: string;
  ts: string;
  eventType: string;
  actorType: WorkerCommandActorType | null;
  actorId: string | null;
  source: string;
  summary: string;
  details: unknown;
};

export type CreateWorkerCommandInput = {
  id: string;
  commandId: string;
  deviceId: string;
  commandType: string;
  actorType: WorkerCommandActorType;
  actorId?: string | null;
  payload?: unknown;
  payloadSummary?: string | null;
  submittedAt: string;
};

export type WorkerCommandListFilter = {
  deviceId?: string;
  state?: string;
  commandType?: string;
  actorType?: string;
  limit?: number;
};

const TERMINAL_STATES = new Set<WorkerCommandState>(['succeeded', 'failed', 'canceled']);

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

function mapCommandRow(row: Record<string, unknown>): WorkerCommandRecord {
  return {
    id: String(row.id),
    commandId: String(row.commandId),
    deviceId: String(row.deviceId),
    commandType: String(row.commandType),
    state: String(row.state) as WorkerCommandState,
    actorType: String(row.actorType) as WorkerCommandActorType,
    actorId: row.actorId == null ? null : String(row.actorId),
    payload: parseJsonValue(row.payloadJson),
    payloadSummary: row.payloadSummary == null ? null : String(row.payloadSummary),
    submittedAt: String(row.submittedAt),
    dispatchedAt: row.dispatchedAt == null ? null : String(row.dispatchedAt),
    executingAt: row.executingAt == null ? null : String(row.executingAt),
    finishedAt: row.finishedAt == null ? null : String(row.finishedAt),
    outcome: row.outcome == null ? null : String(row.outcome),
    reasonCode: row.reasonCode == null ? null : String(row.reasonCode),
    reasonDetail: row.reasonDetail == null ? null : String(row.reasonDetail),
    reqSeq: typeof row.reqSeq === 'number' ? row.reqSeq : row.reqSeq == null ? null : Number(row.reqSeq),
  };
}

function mapAuditRow(row: Record<string, unknown>): WorkerCommandAuditRecord {
  return {
    id: String(row.id),
    commandId: String(row.commandId),
    ts: String(row.ts),
    eventType: String(row.eventType),
    actorType: row.actorType == null ? null : String(row.actorType) as WorkerCommandActorType,
    actorId: row.actorId == null ? null : String(row.actorId),
    source: String(row.source),
    summary: String(row.summary),
    details: parseJsonValue(row.detailsJson),
  };
}

function compareIso(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

export class D1CommandStore {
  constructor(private readonly db: D1LikeDatabase) { }

  async createQueuedCommand(input: CreateWorkerCommandInput): Promise<WorkerCommandRecord> {
    await this.db.prepare(`
      INSERT INTO commands (id, commandId, deviceId, commandType, state, actorType, actorId, payloadJson, payloadSummary, submittedAt)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.commandId,
      input.deviceId,
      input.commandType,
      input.actorType,
      input.actorId ?? null,
      input.payload == null ? null : JSON.stringify(redactTelemetryPayload(input.payload)),
      input.payloadSummary ?? null,
      input.submittedAt,
    ).run();
    return this.getRequiredCommand(input.commandId);
  }

  async markDispatched(commandId: string, reqSeq: number, dispatchedAt: string): Promise<WorkerCommandRecord> {
    await this.db.prepare('UPDATE commands SET state = ?, reqSeq = ?, dispatchedAt = ? WHERE commandId = ?')
      .bind('dispatched', reqSeq, dispatchedAt, commandId)
      .run();
    return this.getRequiredCommand(commandId);
  }

  async nextReqSeq(deviceId: string): Promise<number> {
    const row = await this.db.prepare('SELECT COALESCE(MAX(reqSeq), 0) + 1 AS nextReqSeq FROM commands WHERE deviceId = ?')
      .bind(deviceId)
      .first<{ nextReqSeq?: number | string | null }>();
    const value = Number(row?.nextReqSeq);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  async markExecuting(commandId: string, executingAt: string): Promise<WorkerCommandRecord> {
    const current = await this.getRequiredCommand(commandId);
    if (TERMINAL_STATES.has(current.state)) {
      return current;
    }
    await this.db.prepare('UPDATE commands SET state = ?, executingAt = COALESCE(executingAt, ?) WHERE commandId = ?')
      .bind('executing', executingAt, commandId)
      .run();
    return this.getRequiredCommand(commandId);
  }

  async markSucceeded(commandId: string, outcome: string | null, finishedAt: string): Promise<WorkerCommandRecord> {
    const current = await this.getRequiredCommand(commandId);
    if (TERMINAL_STATES.has(current.state)) {
      return current;
    }
    await this.db.prepare('UPDATE commands SET state = ?, finishedAt = ?, outcome = ?, reasonCode = NULL, reasonDetail = NULL WHERE commandId = ?')
      .bind('succeeded', finishedAt, outcome, commandId)
      .run();
    return this.getRequiredCommand(commandId);
  }

  async markFailed(commandId: string, reasonCode: string, reasonDetail: string | null, finishedAt: string): Promise<WorkerCommandRecord> {
    const current = await this.getRequiredCommand(commandId);
    if (TERMINAL_STATES.has(current.state)) {
      return current;
    }
    await this.db.prepare('UPDATE commands SET state = ?, finishedAt = ?, outcome = ?, reasonCode = ?, reasonDetail = ? WHERE commandId = ?')
      .bind('failed', finishedAt, 'failed', reasonCode, reasonDetail, commandId)
      .run();
    return this.getRequiredCommand(commandId);
  }

  async appendAudit(entry: {
    id: string;
    commandId: string;
    ts: string;
    eventType: WorkerCommandAuditEventType;
    actorType?: WorkerCommandActorType | null;
    actorId?: string | null;
    source: string;
    summary: string;
    details?: unknown;
  }): Promise<WorkerCommandAuditRecord> {
    await this.db.prepare(`
      INSERT INTO command_audit (id, commandId, ts, eventType, actorType, actorId, source, summary, detailsJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.id,
      entry.commandId,
      entry.ts,
      entry.eventType,
      entry.actorType ?? null,
      entry.actorId ?? null,
      entry.source,
      entry.summary,
      entry.details == null ? null : JSON.stringify(redactTelemetryPayload(entry.details)),
    ).run();
    return this.getRequiredAudit(entry.id);
  }

  async appendAuditIfMissing(entry: Parameters<D1CommandStore['appendAudit']>[0]): Promise<WorkerCommandAuditRecord> {
    const existing = await this.db.prepare(`
      SELECT id FROM command_audit
      WHERE commandId = ? AND eventType = ? AND source = ? AND summary = ?
      LIMIT 1
    `).bind(entry.commandId, entry.eventType, entry.source, entry.summary).first<{ id?: string }>();
    if (existing?.id) {
      return this.getRequiredAudit(existing.id);
    }
    return this.appendAudit(entry);
  }

  async hasAuditEvent(commandId: string, eventTypes: string | string[], source?: string | null): Promise<boolean> {
    const normalized = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
    if (!normalized.length) {
      return false;
    }
    const clauses = ['commandId = ?', `eventType IN (${normalized.map(() => '?').join(', ')})`];
    const params: string[] = [commandId, ...normalized.map(String)];
    if (source != null && String(source).trim().length) {
      clauses.push('source = ?');
      params.push(String(source).trim());
    }
    const row = await this.db.prepare(`SELECT 1 AS found FROM command_audit WHERE ${clauses.join(' AND ')} LIMIT 1`)
      .bind(...params)
      .first<{ found?: number }>();
    return Boolean(row?.found);
  }

  async getCommand(commandId: string): Promise<WorkerCommandRecord | undefined> {
    const row = await this.db.prepare('SELECT * FROM commands WHERE commandId = ?').bind(commandId).first<Record<string, unknown>>();
    return row ? mapCommandRow(row) : undefined;
  }

  async listCommands(filter: WorkerCommandListFilter = {}): Promise<WorkerCommandRecord[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.deviceId?.trim()) { clauses.push('deviceId = ?'); params.push(filter.deviceId.trim()); }
    if (filter.state?.trim()) { clauses.push('state = ?'); params.push(filter.state.trim()); }
    if (filter.commandType?.trim()) { clauses.push('commandType = ?'); params.push(filter.commandType.trim()); }
    if (filter.actorType?.trim()) { clauses.push('actorType = ?'); params.push(filter.actorType.trim()); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(filter.limit) || 100, 1), 500);
    const { results = [] } = await this.db.prepare(`SELECT * FROM commands ${where} ORDER BY submittedAt DESC, id DESC LIMIT ?`)
      .bind(...params, limit)
      .all<Record<string, unknown>>();
    return results.map(mapCommandRow);
  }

  async listAudit(commandId: string): Promise<WorkerCommandAuditRecord[]> {
    const { results = [] } = await this.db.prepare('SELECT * FROM command_audit WHERE commandId = ? ORDER BY ts ASC, id ASC')
      .bind(commandId)
      .all<Record<string, unknown>>();
    return results.map(mapAuditRow);
  }

  async findPendingCommand(deviceId: string, commandType: string, payloadMatcher?: (payload: unknown) => boolean): Promise<WorkerCommandRecord | undefined> {
    const candidates = (await this.listCommands({ deviceId, commandType, limit: 100 }))
      .filter((command) => !TERMINAL_STATES.has(command.state))
      .sort((left, right) => compareIso(left.submittedAt, right.submittedAt));
    return payloadMatcher ? candidates.find((command) => payloadMatcher(command.payload)) : candidates[0];
  }

  async findByReqSeq(deviceId: string, reqSeq: number): Promise<WorkerCommandRecord | undefined> {
    const row = await this.db.prepare(`
      SELECT * FROM commands
      WHERE deviceId = ? AND reqSeq = ?
      ORDER BY submittedAt DESC
      LIMIT 1
    `).bind(deviceId, reqSeq).first<Record<string, unknown>>();
    return row ? mapCommandRow(row) : undefined;
  }

  private async getRequiredCommand(commandId: string): Promise<WorkerCommandRecord> {
    const record = await this.getCommand(commandId);
    if (!record) {
      throw new Error(`Command not found after write: ${commandId}`);
    }
    return record;
  }

  private async getRequiredAudit(id: string): Promise<WorkerCommandAuditRecord> {
    const row = await this.db.prepare('SELECT * FROM command_audit WHERE id = ?').bind(id).first<Record<string, unknown>>();
    if (!row) {
      throw new Error(`Command audit not found after write: ${id}`);
    }
    return mapAuditRow(row);
  }
}
