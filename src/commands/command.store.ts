import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type CommandState =
  | 'queued'
  | 'dispatched'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type CommandActorType =
  | 'admin_session'
  | 'admin_api_token'
  | 'admin_env_token'
  | 'system';

export type CommandAuditEventType =
  | 'created'
  | 'dispatched'
  | 'acknowledged'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'reconciled';

export type SafeCommandType =
  | 'request_status_snapshot'
  | 'request_inventory'
  | 'request_recent_logs'
  | 'restart_openvpn'
  | 'restart_boundary_auth'
  | 'restart_server_tunnel'
  | 'restart_server_ssh';

export interface CommandRecord {
  id: string;
  commandId: string;
  deviceId: string;
  commandType: SafeCommandType | string;
  state: CommandState;
  actorType: CommandActorType;
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
}

export interface CommandAuditRecord {
  id: string;
  commandId: string;
  ts: string;
  eventType: CommandAuditEventType | string;
  actorType: CommandActorType | null;
  actorId: string | null;
  source: string;
  summary: string;
  details: unknown;
}

export interface CreateCommandInput {
  id: string;
  commandId: string;
  deviceId: string;
  commandType: SafeCommandType;
  actorType: CommandActorType;
  actorId?: string | null;
  payload?: unknown;
  payloadSummary?: string | null;
  submittedAt: string;
}

export interface CommandListFilter {
  deviceId?: string;
  state?: CommandState | string;
  commandType?: string;
  actorType?: CommandActorType | string;
  limit?: number;
}

const TERMINAL_STATES = new Set<CommandState>(['succeeded', 'failed', 'canceled']);

@Injectable()
export class CommandStore {
  constructor(private readonly databaseService: DatabaseService) {}

  createQueuedCommand(input: CreateCommandInput): CommandRecord {
    this.databaseService.connection
      .prepare(
        `
          INSERT INTO commands (
            id, commandId, deviceId, commandType, state, actorType, actorId,
            payloadJson, payloadSummary, submittedAt
          )
          VALUES (
            @id, @commandId, @deviceId, @commandType, 'queued', @actorType, @actorId,
            @payloadJson, @payloadSummary, @submittedAt
          )
        `,
      )
      .run({
        id: input.id,
        commandId: input.commandId,
        deviceId: input.deviceId,
        commandType: input.commandType,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        payloadJson: input.payload == null ? null : JSON.stringify(input.payload),
        payloadSummary: input.payloadSummary ?? null,
        submittedAt: input.submittedAt,
      });

    return this.getRequiredCommand(input.commandId);
  }

  markDispatched(commandId: string, reqSeq: number, dispatchedAt: string): CommandRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE commands
          SET state = 'dispatched',
              reqSeq = @reqSeq,
              dispatchedAt = @dispatchedAt
          WHERE commandId = @commandId
        `,
      )
      .run({
        commandId,
        reqSeq,
        dispatchedAt,
      });

    return this.getRequiredCommand(commandId);
  }

  markFailed(
    commandId: string,
    reasonCode: string,
    reasonDetail: string | null,
    finishedAt: string,
  ): CommandRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE commands
          SET state = 'failed',
              finishedAt = @finishedAt,
              outcome = 'failed',
              reasonCode = @reasonCode,
              reasonDetail = @reasonDetail
          WHERE commandId = @commandId
        `,
      )
      .run({
        commandId,
        finishedAt,
        reasonCode,
        reasonDetail,
      });

    return this.getRequiredCommand(commandId);
  }

  markExecuting(commandId: string, executingAt: string): CommandRecord {
    const current = this.getRequiredCommand(commandId);
    if (TERMINAL_STATES.has(current.state)) {
      return current;
    }

    this.databaseService.connection
      .prepare(
        `
          UPDATE commands
          SET state = 'executing',
              executingAt = COALESCE(executingAt, @executingAt)
          WHERE commandId = @commandId
        `,
      )
      .run({
        commandId,
        executingAt,
      });

    return this.getRequiredCommand(commandId);
  }

  markSucceeded(commandId: string, outcome: string | null, finishedAt: string): CommandRecord {
    const current = this.getRequiredCommand(commandId);
    if (TERMINAL_STATES.has(current.state)) {
      return current;
    }

    this.databaseService.connection
      .prepare(
        `
          UPDATE commands
          SET state = 'succeeded',
              finishedAt = @finishedAt,
              outcome = @outcome,
              reasonCode = NULL,
              reasonDetail = NULL
          WHERE commandId = @commandId
        `,
      )
      .run({
        commandId,
        finishedAt,
        outcome,
      });

    return this.getRequiredCommand(commandId);
  }

  appendAudit(entry: {
    id: string;
    commandId: string;
    ts: string;
    eventType: CommandAuditEventType;
    actorType?: CommandActorType | null;
    actorId?: string | null;
    source: string;
    summary: string;
    details?: unknown;
  }): CommandAuditRecord {
    this.databaseService.connection
      .prepare(
        `
          INSERT INTO command_audit (
            id, commandId, ts, eventType, actorType, actorId, source, summary, detailsJson
          )
          VALUES (
            @id, @commandId, @ts, @eventType, @actorType, @actorId, @source, @summary, @detailsJson
          )
        `,
      )
      .run({
        id: entry.id,
        commandId: entry.commandId,
        ts: entry.ts,
        eventType: entry.eventType,
        actorType: entry.actorType ?? null,
        actorId: entry.actorId ?? null,
        source: entry.source,
        summary: entry.summary,
        detailsJson: entry.details == null ? null : JSON.stringify(entry.details),
      });

    return this.getAuditById(entry.id)!;
  }

  appendAuditIfMissing(entry: {
    id: string;
    commandId: string;
    ts: string;
    eventType: CommandAuditEventType;
    actorType?: CommandActorType | null;
    actorId?: string | null;
    source: string;
    summary: string;
    details?: unknown;
  }): CommandAuditRecord {
    const existing = this.databaseService.connection
      .prepare(
        `
          SELECT id
          FROM command_audit
          WHERE commandId = @commandId
            AND eventType = @eventType
            AND source = @source
            AND summary = @summary
          LIMIT 1
        `,
      )
      .get({
        commandId: entry.commandId,
        eventType: entry.eventType,
        source: entry.source,
        summary: entry.summary,
      }) as { id?: string } | undefined;

    if (existing?.id) {
      return this.getAuditById(existing.id)!;
    }

    return this.appendAudit(entry);
  }

  hasAuditEvent(
    commandId: string,
    eventTypes: CommandAuditEventType | string | Array<CommandAuditEventType | string>,
    source?: string | null,
  ): boolean {
    const normalizedEventTypes = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
    if (!normalizedEventTypes.length) {
      return false;
    }

    const clauses = [
      'commandId = ?',
      `eventType IN (${normalizedEventTypes.map(() => '?').join(', ')})`,
    ];
    const params: Array<string> = [commandId, ...normalizedEventTypes.map((value) => String(value))];

    if (source != null && String(source).trim().length) {
      clauses.push('source = ?');
      params.push(String(source).trim());
    }

    const row = this.databaseService.connection
      .prepare(
        `
          SELECT 1 AS found
          FROM command_audit
          WHERE ${clauses.join(' AND ')}
          LIMIT 1
        `,
      )
      .get(...params) as { found?: number } | undefined;

    return !!row?.found;
  }

  getCommand(commandId: string): CommandRecord | undefined {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM commands
          WHERE commandId = ?
        `,
      )
      .get(commandId) as Record<string, unknown> | undefined;

    return row ? this.mapCommandRow(row) : undefined;
  }

  listCommands(filter: CommandListFilter = {}): CommandRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.deviceId?.trim()) {
      clauses.push('deviceId = ?');
      params.push(filter.deviceId.trim());
    }
    if (filter.state?.trim()) {
      clauses.push('state = ?');
      params.push(filter.state.trim());
    }
    if (filter.commandType?.trim()) {
      clauses.push('commandType = ?');
      params.push(filter.commandType.trim());
    }
    if (filter.actorType?.trim()) {
      clauses.push('actorType = ?');
      params.push(filter.actorType.trim());
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(filter.limit) || 100, 1), 500);
    params.push(limit);

    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM commands
          ${whereClause}
          ORDER BY submittedAt DESC, id DESC
          LIMIT ?
        `,
      )
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapCommandRow(row));
  }

  listAudit(commandId: string): CommandAuditRecord[] {
    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM command_audit
          WHERE commandId = ?
          ORDER BY ts ASC, id ASC
        `,
      )
      .all(commandId) as Array<Record<string, unknown>>;

    return rows.map((row) => this.mapAuditRow(row));
  }

  findPendingCommand(
    deviceId: string,
    commandType: string,
    payloadMatcher?: (payload: unknown) => boolean,
  ): CommandRecord | undefined {
    const candidates = this.listCommands({
      deviceId,
      commandType,
      limit: 100,
    })
      .filter((command) => !TERMINAL_STATES.has(command.state))
      .sort((left, right) => compareIso(left.submittedAt, right.submittedAt));

    if (!payloadMatcher) {
      return candidates[0];
    }

    return candidates.find((command) => payloadMatcher(command.payload));
  }

  findByReqSeq(deviceId: string, reqSeq: number): CommandRecord | undefined {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM commands
          WHERE deviceId = ?
            AND reqSeq = ?
          ORDER BY submittedAt DESC
          LIMIT 1
        `,
      )
      .get(deviceId, reqSeq) as Record<string, unknown> | undefined;

    return row ? this.mapCommandRow(row) : undefined;
  }

  private getRequiredCommand(commandId: string): CommandRecord {
    const record = this.getCommand(commandId);
    if (!record) {
      throw new Error(`Command not found after write: ${commandId}`);
    }
    return record;
  }

  private getAuditById(id: string): CommandAuditRecord | undefined {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM command_audit
          WHERE id = ?
        `,
      )
      .get(id) as Record<string, unknown> | undefined;

    return row ? this.mapAuditRow(row) : undefined;
  }

  private mapCommandRow(row: Record<string, unknown>): CommandRecord {
    return {
      id: String(row.id),
      commandId: String(row.commandId),
      deviceId: String(row.deviceId),
      commandType: String(row.commandType),
      state: String(row.state) as CommandState,
      actorType: String(row.actorType) as CommandActorType,
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
      reqSeq:
        typeof row.reqSeq === 'number'
          ? row.reqSeq
          : row.reqSeq == null
            ? null
            : Number(row.reqSeq),
    };
  }

  private mapAuditRow(row: Record<string, unknown>): CommandAuditRecord {
    return {
      id: String(row.id),
      commandId: String(row.commandId),
      ts: String(row.ts),
      eventType: String(row.eventType),
      actorType: row.actorType == null ? null : (String(row.actorType) as CommandActorType),
      actorId: row.actorId == null ? null : String(row.actorId),
      source: String(row.source),
      summary: String(row.summary),
      details: parseJsonValue(row.detailsJson),
    };
  }
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

function compareIso(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}
