import { D1LikeDatabase } from './d1-device-store';
import { coalesceFunctionStatusSessionId } from '../../logs/functionStatusSessionId';
import { redactTelemetryPayload } from '../../logs/log-redaction';

export type WorkerTelemetryEvent = {
  id: string;
  deviceId: string;
  type: string;
  /** CC-plane PTY correlation id when set; prefer canonical `ccpty:{deviceId}:{localSegment}` for PTY types (see plan). */
  sessionId?: string | null;
  functionId?: string | null;
  seq: number;
  ts: string;
  payload: unknown;
};

export type WorkerTelemetryFilter = {
  type?: string;
  functionId?: string;
  q?: string;
  deviceId?: string;
  fromTs?: string;
  toTs?: string;
};

export type WorkerDeviceRuntimeSummary = {
  deviceId: string;
  updatedAt: string | null;
  agentRunId?: string | null;
  inventory?: unknown;
  functions: Record<string, {
    functionId: string;
    state?: string;
    message?: string;
    sessionId?: string | null;
    boundaryTokenSource?: string | null;
    updatedAtMs?: number;
    observedAt: string;
    raw?: unknown;
  }>;
};

type TelemetryRow = {
  id: string;
  deviceId: string;
  type: string;
  sessionId?: string | null;
  functionId?: string | null;
  seq: number;
  ts: string;
  payloadJson?: string | null;
};

type RuntimeRow = {
  deviceId: string;
  summaryJson?: string | null;
  updatedAt?: string | null;
};

type D1LogStoreOptions = {
  maxEventsPerDevice?: number;
  maxAgeDays?: number;
  now?: () => Date;
};

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function parsePayload(payloadJson?: string | null): unknown {
  if (!payloadJson) {
    return null;
  }
  try {
    return JSON.parse(payloadJson);
  } catch {
    return payloadJson;
  }
}

function mapTelemetryRow(row: TelemetryRow): WorkerTelemetryEvent {
  return {
    id: row.id,
    deviceId: row.deviceId,
    type: row.type,
    sessionId: row.sessionId ?? null,
    functionId: row.functionId ?? null,
    seq: row.seq,
    ts: row.ts,
    payload: parsePayload(row.payloadJson),
  };
}

function parseRuntimeSummary(row: RuntimeRow | null | undefined, deviceId: string): WorkerDeviceRuntimeSummary {
  if (!row?.summaryJson) {
    return { deviceId, updatedAt: row?.updatedAt ?? null, functions: {} };
  }
  try {
    const parsed = JSON.parse(row.summaryJson);
    return {
      deviceId,
      updatedAt: row.updatedAt ?? null,
      agentRunId: typeof parsed?.agentRunId === 'string' ? parsed.agentRunId : parsed?.agentRunId == null ? null : undefined,
      functions: parsed?.functions && typeof parsed.functions === 'object' ? parsed.functions : {},
      inventory: parsed?.inventory,
    };
  } catch {
    return { deviceId, updatedAt: row.updatedAt ?? null, functions: {} };
  }
}

export class D1LogStore {
  private readonly maxEventsPerDevice: number;
  private readonly maxAgeDays: number;
  private readonly now: () => Date;

  constructor(private readonly db: D1LikeDatabase, opts: D1LogStoreOptions = {}) {
    this.maxEventsPerDevice = parsePositiveInt(opts.maxEventsPerDevice, 5000);
    this.maxAgeDays = parsePositiveInt(opts.maxAgeDays, 30);
    this.now = opts.now ?? (() => new Date());
  }

  async append(event: WorkerTelemetryEvent): Promise<WorkerTelemetryEvent> {
    const payloadForCoalesce =
      event.payload && typeof event.payload === 'object' ? (event.payload as Record<string, unknown>) : {};
    const resolvedSessionId =
      event.type === 'function-status'
        ? coalesceFunctionStatusSessionId(event.sessionId, payloadForCoalesce)
        : (event.sessionId ?? null);

    const sanitizedEvent: WorkerTelemetryEvent = {
      ...event,
      sessionId: resolvedSessionId,
      functionId: event.functionId ?? null,
      payload: redactTelemetryPayload(event.payload),
    };

    await this.db.prepare(`
      INSERT INTO telemetry_logs (id, deviceId, type, sessionId, functionId, seq, ts, payloadJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sanitizedEvent.id,
      sanitizedEvent.deviceId,
      sanitizedEvent.type,
      sanitizedEvent.sessionId ?? null,
      sanitizedEvent.functionId ?? null,
      sanitizedEvent.seq,
      sanitizedEvent.ts,
      sanitizedEvent.payload == null ? null : JSON.stringify(sanitizedEvent.payload),
    ).run();

    await this.trimDeviceHistory(sanitizedEvent.deviceId);
    await this.pruneExpiredLogs();
    await this.updateRuntimeSummary(sanitizedEvent);
    return sanitizedEvent;
  }

  async listByDevice(deviceId: string, limit = 200, filterBy: WorkerTelemetryFilter = {}): Promise<WorkerTelemetryEvent[]> {
    return this.listWithClauses(['deviceId = ?'], [deviceId], limit, filterBy);
  }

  async listAll(limit = 200, filterBy: WorkerTelemetryFilter = {}): Promise<WorkerTelemetryEvent[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filterBy.deviceId?.trim()) {
      clauses.push('deviceId = ?');
      params.push(filterBy.deviceId.trim());
    }
    if (filterBy.fromTs) {
      clauses.push('ts >= ?');
      params.push(filterBy.fromTs);
    }
    if (filterBy.toTs) {
      clauses.push('ts <= ?');
      params.push(filterBy.toTs);
    }
    return this.listWithClauses(clauses, params, limit, filterBy);
  }

  async getTelemetryTypeStats(filterBy: WorkerTelemetryFilter = {}): Promise<Array<{ type: string; count: number }>> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filterBy.deviceId?.trim()) {
      clauses.push('deviceId = ?');
      params.push(filterBy.deviceId.trim());
    }
    if (filterBy.fromTs) {
      clauses.push('ts >= ?');
      params.push(filterBy.fromTs);
    }
    if (filterBy.toTs) {
      clauses.push('ts <= ?');
      params.push(filterBy.toTs);
    }
    this.applyFilterClauses(clauses, params, filterBy);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { results = [] } = await this.db.prepare(`
      SELECT type, COUNT(*) as count
      FROM telemetry_logs
      ${where}
      GROUP BY type
      ORDER BY count DESC
    `).bind(...params).all<{ type: string; count: number }>();
    return results;
  }

  async listPtyOutputBySession(deviceId: string, sessionId: string, limit = 200, offset = 0): Promise<WorkerTelemetryEvent[]> {
    const resolvedLimit = Math.min(Math.max(Number(limit) || 200, 1), 5000);
    const resolvedOffset = Math.max(Number(offset) || 0, 0);
    const { results = [] } = await this.db.prepare(`
      SELECT id, deviceId, type, sessionId, functionId, seq, ts, payloadJson
      FROM telemetry_logs
      WHERE deviceId = ? AND type = 'pty-output' AND sessionId = ?
      ORDER BY ts DESC, seq DESC
      LIMIT ? OFFSET ?
    `).bind(deviceId, sessionId, resolvedLimit, resolvedOffset).all<TelemetryRow>();
    return results.reverse().map(mapTelemetryRow);
  }

  async countPtyOutputBySession(deviceId: string, sessionId: string): Promise<number> {
    const row = await this.db.prepare(`
      SELECT COUNT(*) as cnt
      FROM telemetry_logs
      WHERE deviceId = ? AND type = 'pty-output' AND sessionId = ?
    `).bind(deviceId, sessionId).first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  async getDeviceRuntimeSummary(deviceId: string): Promise<WorkerDeviceRuntimeSummary> {
    const row = await this.db.prepare(`
      SELECT deviceId, summaryJson, updatedAt
      FROM device_runtime_state
      WHERE deviceId = ?
    `).bind(deviceId).first<RuntimeRow>();
    return parseRuntimeSummary(row, deviceId);
  }

  async getAllRuntimeSummaries(): Promise<WorkerDeviceRuntimeSummary[]> {
    const { results = [] } = await this.db.prepare(`
      SELECT deviceId, summaryJson, updatedAt
      FROM device_runtime_state
    `).all<RuntimeRow>();
    return results.map((row) => parseRuntimeSummary(row, row.deviceId));
  }

  async noteAgentRun(deviceId: string, agentRunId: string, ts: string): Promise<{ changed: boolean; previousAgentRunId: string | null }> {
    const summary = await this.getDeviceRuntimeSummary(deviceId);
    const previousAgentRunId = typeof summary.agentRunId === 'string' && summary.agentRunId.trim() ? summary.agentRunId : null;
    const changed = Boolean(previousAgentRunId && previousAgentRunId !== agentRunId);
    summary.agentRunId = agentRunId;
    summary.updatedAt = ts;
    if (changed) {
      for (const [functionId, state] of Object.entries(summary.functions)) {
        if (!functionId.startsWith('server-tunnel-') && !functionId.startsWith('server-ssh-')) {
          continue;
        }
        summary.functions[functionId] = {
          ...state,
          state: 'idle',
          message: 'Agent restarted; previous in-memory session was discarded.',
          sessionId: null,
          observedAt: ts,
          raw: {
            ...(state.raw && typeof state.raw === 'object' ? state.raw as Record<string, unknown> : {}),
            reasonCode: 'AGENT_RESTARTED',
          },
        };
      }
    }
    await this.saveRuntimeSummary(summary, ts);
    return { changed, previousAgentRunId };
  }

  getRetentionSettings() {
    return { maxEventsPerDevice: this.maxEventsPerDevice, maxAgeDays: this.maxAgeDays };
  }

  async getLastSessionIdForFunction(deviceId: string, functionId: string): Promise<string | null> {
    const { results = [] } = await this.db.prepare(`
      SELECT sessionId, payloadJson
      FROM telemetry_logs
      WHERE deviceId = ? AND functionId = ? AND type = 'function-status'
      ORDER BY ts DESC, seq DESC
      LIMIT 32
    `).bind(deviceId, functionId).all<{ sessionId?: string | null; payloadJson?: string | null }>();

    for (const row of results) {
      let payload: Record<string, unknown> = {};
      if (row.payloadJson) {
        try {
          const parsed = JSON.parse(row.payloadJson);
          if (parsed && typeof parsed === 'object') {
            payload = parsed as Record<string, unknown>;
          }
        } catch {
          // ignore parse errors
        }
      }
      const merged = coalesceFunctionStatusSessionId(row.sessionId, payload);
      if (merged) {
        return merged;
      }
    }
    return null;
  }

  private async listWithClauses(clauses: string[], params: Array<string | number>, limit: number, filterBy: WorkerTelemetryFilter) {
    this.applyFilterClauses(clauses, params, filterBy);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { results = [] } = await this.db.prepare(`
      SELECT id, deviceId, type, sessionId, functionId, seq, ts, payloadJson
      FROM telemetry_logs
      ${where}
      ORDER BY ts DESC, seq DESC
      LIMIT ?
    `).bind(...params, limit).all<TelemetryRow>();
    return results.reverse().map(mapTelemetryRow);
  }

  private applyFilterClauses(clauses: string[], params: Array<string | number>, filterBy: WorkerTelemetryFilter) {
    if (filterBy.type?.trim()) {
      clauses.push('type = ?');
      params.push(filterBy.type.trim());
    }
    if (filterBy.functionId?.trim()) {
      clauses.push('functionId = ?');
      params.push(filterBy.functionId.trim());
    }
    if (filterBy.q?.trim()) {
      const needle = `%${filterBy.q.trim().toLowerCase()}%`;
      clauses.push("(LOWER(type) LIKE ? OR LOWER(COALESCE(functionId, '')) LIKE ? OR LOWER(COALESCE(sessionId, '')) LIKE ? OR LOWER(COALESCE(payloadJson, '')) LIKE ?)");
      params.push(needle, needle, needle, needle);
    }
  }

  private async trimDeviceHistory(deviceId: string): Promise<void> {
    await this.db.prepare(`
      DELETE FROM telemetry_logs
      WHERE deviceId = ?
        AND id NOT IN (
          SELECT id FROM telemetry_logs
          WHERE deviceId = ?
          ORDER BY ts DESC, seq DESC
          LIMIT ?
        )
    `).bind(deviceId, deviceId, this.maxEventsPerDevice).run();
  }

  private async pruneExpiredLogs(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - this.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    await this.db.prepare('DELETE FROM telemetry_logs WHERE ts < ?').bind(cutoff).run();
  }

  private async updateRuntimeSummary(event: WorkerTelemetryEvent): Promise<void> {
    if (event.type !== 'function-status' && event.type !== 'inventory' && event.type !== 'status_snapshot') {
      return;
    }
    const summary = await this.getDeviceRuntimeSummary(event.deviceId);
    summary.updatedAt = event.ts;
    const eventPayload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
    if (typeof eventPayload.agentRunId === 'string' && eventPayload.agentRunId.trim()) {
      summary.agentRunId = eventPayload.agentRunId.trim();
    }

    if (event.type === 'inventory') {
      summary.inventory = event.payload;
    }

    if (event.type === 'status_snapshot') {
      const payload = eventPayload;
      summary.functions = {};
      const functionStates = Array.isArray(payload.functionStates) ? payload.functionStates : [];
      for (const fs of functionStates) {
        const state = fs as Record<string, unknown>;
        const functionId = typeof state.functionId === 'string' && state.functionId.trim() ? state.functionId : 'unknown';
        summary.functions[functionId] = {
          functionId,
          state: typeof state.state === 'string' ? state.state : undefined,
          message: typeof state.message === 'string' ? state.message : undefined,
          sessionId: typeof state.sessionId === 'string' ? state.sessionId : state.sessionId == null ? null : undefined,
          boundaryTokenSource: typeof state.boundaryTokenSource === 'string' ? state.boundaryTokenSource : state.boundaryTokenSource == null ? null : undefined,
          updatedAtMs: typeof state.updatedAtMs === 'number' ? state.updatedAtMs : undefined,
          observedAt: event.ts,
          raw: state,
        };
      }
    }

    if (event.type === 'function-status') {
      const payload = eventPayload;
      const functionId = typeof payload.functionId === 'string' && payload.functionId.trim() ? payload.functionId : event.functionId || 'unknown';
      summary.functions[functionId] = {
        functionId,
        state: typeof payload.state === 'string' ? payload.state : undefined,
        message: typeof payload.message === 'string' ? payload.message : undefined,
        sessionId: coalesceFunctionStatusSessionId(event.sessionId, payload),
        boundaryTokenSource: typeof payload.boundaryTokenSource === 'string' ? payload.boundaryTokenSource : payload.boundaryTokenSource == null ? null : undefined,
        updatedAtMs: typeof payload.updatedAtMs === 'number' ? payload.updatedAtMs : undefined,
        observedAt: event.ts,
        raw: event.payload,
      };
    }

    await this.saveRuntimeSummary(summary, event.ts);
  }

  private async saveRuntimeSummary(summary: WorkerDeviceRuntimeSummary, fallbackUpdatedAt: string): Promise<void> {
    await this.db.prepare(`
      INSERT INTO device_runtime_state (deviceId, summaryJson, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(deviceId) DO UPDATE SET summaryJson = excluded.summaryJson, updatedAt = excluded.updatedAt
    `).bind(
      summary.deviceId,
      JSON.stringify({ agentRunId: summary.agentRunId ?? null, inventory: summary.inventory ?? null, functions: summary.functions }),
      summary.updatedAt ?? fallbackUpdatedAt,
    ).run();
  }
}
