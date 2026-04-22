import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';
import { DatabaseService } from '../database/database.service';
import { redactTelemetryPayload } from './log-redaction';

export type TelemetryEventType =
  | 'pty-output'
  | 'pty-exit'
  | 'openvpn-log'
  | 'function-status'
  | 'status_snapshot'
  | 'inventory'
  | 'recent_logs';

export interface TelemetryEvent {
  id: string;
  deviceId: string;
  type: TelemetryEventType | string;
  sessionId?: string | null;
  functionId?: string | null;
  seq: number;
  ts: string;
  payload: unknown;
}

export type TelemetryFilter = {
  type?: string;
  functionId?: string;
  q?: string;
};

export interface DeviceRuntimeSummary {
  deviceId: string;
  updatedAt: string | null;
  inventory?: unknown;
  functions: Record<
    string,
    {
      functionId: string;
      state?: string;
      message?: string;
      sessionId?: string | null;
      boundaryTokenSource?: string | null;
      updatedAtMs?: number;
      observedAt: string;
      raw?: unknown;
    }
  >;
}

@Injectable()
export class LogStore {
  private readonly stream = new Subject<TelemetryEvent>();
  private readonly maxEventsPerDevice: number;
  private readonly maxAgeDays: number;

  constructor(private readonly databaseService: DatabaseService) {
    this.maxEventsPerDevice = this.parsePositiveInt(
      process.env.CC_LOG_RETENTION_MAX_EVENTS_PER_DEVICE,
      5000,
    );
    this.maxAgeDays = this.parsePositiveInt(
      process.env.CC_LOG_RETENTION_MAX_AGE_DAYS,
      30,
    );
    this.pruneExpiredLogs();
  }

  append(event: TelemetryEvent): TelemetryEvent {
    const sanitizedEvent: TelemetryEvent = {
      ...event,
      payload: redactTelemetryPayload(event.payload),
    };

    this.databaseService.connection
      .prepare(
        `
          INSERT INTO telemetry_logs (
            id, deviceId, type, sessionId, functionId, seq, ts, payloadJson
          )
          VALUES (@id, @deviceId, @type, @sessionId, @functionId, @seq, @ts, @payloadJson)
        `,
      )
      .run({
        id: sanitizedEvent.id,
        deviceId: sanitizedEvent.deviceId,
        type: sanitizedEvent.type,
        sessionId: sanitizedEvent.sessionId ?? null,
        functionId: sanitizedEvent.functionId ?? null,
        seq: sanitizedEvent.seq,
        ts: sanitizedEvent.ts,
        payloadJson:
          sanitizedEvent.payload == null ? null : JSON.stringify(sanitizedEvent.payload),
      });

    this.trimDeviceHistory(sanitizedEvent.deviceId);
    this.pruneExpiredLogs();
    this.updateRuntimeSummary(sanitizedEvent);
    this.stream.next(sanitizedEvent);
    return sanitizedEvent;
  }

  listByDevice(deviceId: string, limit = 200, filterBy: TelemetryFilter = {}): TelemetryEvent[] {
    const clauses = ['deviceId = ?'];
    const params: Array<string | number> = [deviceId];

    this.applyFilterClauses(clauses, params, filterBy);
    params.push(limit);

    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT id, deviceId, type, sessionId, functionId, seq, ts, payloadJson
          FROM telemetry_logs
          WHERE ${clauses.join(' AND ')}
          ORDER BY seq DESC, ts DESC
          LIMIT ?
        `,
      )
      .all(...params) as Array<{
        id: string;
        deviceId: string;
        type: string;
        sessionId?: string | null;
        functionId?: string | null;
        seq: number;
        ts: string;
        payloadJson?: string | null;
      }>;

    return rows.reverse().map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      type: row.type,
      sessionId: row.sessionId ?? null,
      functionId: row.functionId ?? null,
      seq: row.seq,
      ts: row.ts,
      payload: this.parsePayload(row.payloadJson),
    }));
  }

  listAll(
    limit = 200,
    filterBy: TelemetryFilter & { deviceId?: string; fromTs?: string; toTs?: string } = {},
  ): TelemetryEvent[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filterBy.deviceId?.trim()) {
      clauses.push('deviceId = ?');
      params.push(filterBy.deviceId.trim());
    }
    if (filterBy.fromTs) {
      clauses.push("ts >= ?");
      params.push(filterBy.fromTs);
    }
    if (filterBy.toTs) {
      clauses.push("ts <= ?");
      params.push(filterBy.toTs);
    }
    this.applyFilterClauses(clauses, params, filterBy);
    params.push(limit);

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT id, deviceId, type, sessionId, functionId, seq, ts, payloadJson
          FROM telemetry_logs
          ${where}
          ORDER BY seq DESC, ts DESC
          LIMIT ?
        `,
      )
      .all(...params) as Array<{
        id: string;
        deviceId: string;
        type: string;
        sessionId?: string | null;
        functionId?: string | null;
        seq: number;
        ts: string;
        payloadJson?: string | null;
      }>;

    return rows.reverse().map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      type: row.type,
      sessionId: row.sessionId ?? null,
      functionId: row.functionId ?? null,
      seq: row.seq,
      ts: row.ts,
      payload: this.parsePayload(row.payloadJson),
    }));
  }

  getTelemetryTypeStats(
    filterBy: TelemetryFilter & { deviceId?: string; fromTs?: string; toTs?: string } = {},
  ): Array<{ type: string; count: number }> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filterBy.deviceId?.trim()) {
      clauses.push('deviceId = ?');
      params.push(filterBy.deviceId.trim());
    }
    if (filterBy.fromTs) {
      clauses.push("ts >= ?");
      params.push(filterBy.fromTs);
    }
    if (filterBy.toTs) {
      clauses.push("ts <= ?");
      params.push(filterBy.toTs);
    }
    this.applyFilterClauses(clauses, params, filterBy);

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    return this.databaseService.connection
      .prepare(
        `
          SELECT type, COUNT(*) as count
          FROM telemetry_logs
          ${where}
          GROUP BY type
          ORDER BY count DESC
        `,
      )
      .all(...params) as Array<{ type: string; count: number }>;
  }

  private applyFilterClauses(
    clauses: string[],
    params: Array<string | number>,
    filterBy: TelemetryFilter,
  ) {
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
      clauses.push(
        "(LOWER(type) LIKE ? OR LOWER(COALESCE(functionId, '')) LIKE ? OR LOWER(COALESCE(sessionId, '')) LIKE ? OR LOWER(COALESCE(payloadJson, '')) LIKE ?)",
      );
      params.push(needle, needle, needle, needle);
    }
  }

  streamByDevice(deviceId: string, filterBy: TelemetryFilter = {}): Observable<TelemetryEvent> {
    return this.stream.asObservable().pipe(
      filter((event) => {
        if (event.deviceId !== deviceId) {
          return false;
        }
        if (filterBy.type?.trim() && event.type !== filterBy.type.trim()) {
          return false;
        }
        if (filterBy.functionId?.trim() && event.functionId !== filterBy.functionId.trim()) {
          return false;
        }
        if (filterBy.q?.trim()) {
          const needle = filterBy.q.trim().toLowerCase();
          const haystacks = [
            event.type,
            event.functionId ?? '',
            event.sessionId ?? '',
            safeStringify(event.payload),
          ];
          if (!haystacks.some((value) => value.toLowerCase().includes(needle))) {
            return false;
          }
        }
        return true;
      }),
    );
  }

  getDeviceRuntimeSummary(deviceId: string): DeviceRuntimeSummary {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT summaryJson, updatedAt
          FROM device_runtime_state
          WHERE deviceId = ?
        `,
      )
      .get(deviceId) as { summaryJson?: string; updatedAt?: string } | undefined;

    if (!row?.summaryJson) {
      return {
        deviceId,
        updatedAt: null,
        functions: {},
      };
    }

    try {
      const parsed = JSON.parse(row.summaryJson);
      return {
        deviceId,
        updatedAt: row.updatedAt ?? null,
        functions: parsed?.functions && typeof parsed.functions === 'object' ? parsed.functions : {},
        inventory: parsed?.inventory,
      };
    } catch {
      return {
        deviceId,
        updatedAt: row.updatedAt ?? null,
        functions: {},
      };
    }
  }

  getRetentionSettings() {
    return {
      maxEventsPerDevice: this.maxEventsPerDevice,
      maxAgeDays: this.maxAgeDays,
    };
  }

  getAllRuntimeSummaries(): DeviceRuntimeSummary[] {
    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT deviceId, summaryJson, updatedAt
          FROM device_runtime_state
        `,
      )
      .all() as Array<{
        deviceId: string;
        summaryJson?: string;
        updatedAt?: string;
      }>;

    return rows.map((row) => {
      if (!row.summaryJson) {
        return {
          deviceId: row.deviceId,
          updatedAt: row.updatedAt ?? null,
          functions: {},
        };
      }
      try {
        const parsed = JSON.parse(row.summaryJson);
        return {
          deviceId: row.deviceId,
          updatedAt: row.updatedAt ?? null,
          functions: parsed?.functions && typeof parsed.functions === 'object' ? parsed.functions : {},
          inventory: parsed?.inventory,
        };
      } catch {
        return {
          deviceId: row.deviceId,
          updatedAt: row.updatedAt ?? null,
          functions: {},
        };
      }
    });
  }

  private trimDeviceHistory(deviceId: string) {
    this.databaseService.connection
      .prepare(
        `
          DELETE FROM telemetry_logs
          WHERE deviceId = ?
            AND id NOT IN (
              SELECT id
              FROM telemetry_logs
              WHERE deviceId = ?
              ORDER BY seq DESC, ts DESC
              LIMIT ?
            )
        `,
      )
      .run(deviceId, deviceId, this.maxEventsPerDevice);
  }

  private pruneExpiredLogs() {
    this.databaseService.connection
      .prepare(
        `
          DELETE FROM telemetry_logs
          WHERE datetime(ts) < datetime('now', ?)
        `,
      )
      .run(`-${this.maxAgeDays} days`);
  }

  private parsePayload(payloadJson?: string | null): unknown {
    if (!payloadJson) {
      return null;
    }
    try {
      return JSON.parse(payloadJson);
    } catch {
      return payloadJson;
    }
  }

  private updateRuntimeSummary(event: TelemetryEvent) {
    if (event.type !== 'function-status' && event.type !== 'inventory') {
      return;
    }

    const summary = this.getDeviceRuntimeSummary(event.deviceId);
    summary.updatedAt = event.ts;

    if (event.type === 'inventory') {
      summary.inventory = event.payload;
    }

    if (event.type === 'function-status') {
      const payload =
        event.payload && typeof event.payload === 'object'
          ? (event.payload as Record<string, unknown>)
          : {};
      const functionId =
        typeof payload.functionId === 'string' && payload.functionId.trim()
          ? payload.functionId
          : event.functionId || 'unknown';
      summary.functions[functionId] = {
        functionId,
        state: typeof payload.state === 'string' ? payload.state : undefined,
        message: typeof payload.message === 'string' ? payload.message : undefined,
        sessionId:
          typeof payload.sessionId === 'string'
            ? payload.sessionId
            : payload.sessionId == null
              ? null
              : event.sessionId ?? null,
        boundaryTokenSource:
          typeof payload.boundaryTokenSource === 'string'
            ? payload.boundaryTokenSource
            : payload.boundaryTokenSource == null
              ? null
              : undefined,
        updatedAtMs:
          typeof payload.updatedAtMs === 'number' ? payload.updatedAtMs : undefined,
        observedAt: event.ts,
        raw: event.payload,
      };
    }

    this.databaseService.connection
      .prepare(
        `
          INSERT INTO device_runtime_state (deviceId, summaryJson, updatedAt)
          VALUES (@deviceId, @summaryJson, @updatedAt)
          ON CONFLICT(deviceId) DO UPDATE SET
            summaryJson = excluded.summaryJson,
            updatedAt = excluded.updatedAt
        `,
      )
      .run({
        deviceId: event.deviceId,
        summaryJson: JSON.stringify({
          inventory: summary.inventory ?? null,
          functions: summary.functions,
        }),
        updatedAt: summary.updatedAt ?? event.ts,
      });
  }

  private parsePositiveInt(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1) {
      return fallback;
    }
    return Math.floor(value);
  }
}

function safeStringify(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
