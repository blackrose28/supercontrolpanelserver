import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type PtySessionState =
  | 'opening'
  | 'open'
  | 'closing'
  | 'closed'
  | 'expired'
  | 'failed';

export interface PtySessionRecord {
  id: string;
  sessionId: string;
  deviceId: string;
  state: PtySessionState;
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
}

type PendingReqType = 'open' | 'close';

@Injectable()
export class PtySessionStore {
  private readonly pendingByReqSeq = new Map<string, { sessionId: string; type: PendingReqType }>();
  private readonly detachGraceMs = 30_000;
  private readonly terminalRetentionMs = 7 * 24 * 60 * 60 * 1000;

  constructor(private readonly databaseService: DatabaseService) {}

  createOpening(input: {
    id: string;
    sessionId: string;
    deviceId: string;
    cols?: number | null;
    rows?: number | null;
    openedAt: string;
    recordingEnabled?: boolean;
    openedByActorType?: string | null;
    openedByActorId?: string | null;
    attachedActorType?: string | null;
    attachedActorId?: string | null;
  }): PtySessionRecord {
    this.databaseService.connection
      .prepare(
        `
          INSERT INTO pty_sessions (
            id, sessionId, deviceId, state, openedByActorType, openedByActorId,
            attachedActorType, attachedActorId, recordingEnabled, cols, rows, openedAt, lastAttachedAt
          )
          VALUES (
            @id, @sessionId, @deviceId, 'opening', @openedByActorType, @openedByActorId,
            @attachedActorType, @attachedActorId, @recordingEnabled, @cols, @rows, @openedAt, @lastAttachedAt
          )
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
            lastDetachedAt = NULL,
            closedAt = NULL,
            expiredAt = NULL,
            deletedAt = NULL,
            failureCode = NULL,
            failureDetail = NULL
        `,
      )
      .run({
        id: input.id,
        sessionId: input.sessionId,
        deviceId: input.deviceId,
        openedByActorType: input.openedByActorType ?? null,
        openedByActorId: input.openedByActorId ?? null,
        attachedActorType: input.attachedActorType ?? null,
        attachedActorId: input.attachedActorId ?? null,
        recordingEnabled: input.recordingEnabled ? 1 : 0,
        cols: input.cols ?? null,
        rows: input.rows ?? null,
        openedAt: input.openedAt,
        lastAttachedAt: input.attachedActorType ? input.openedAt : null,
      });

    return this.getRequired(input.sessionId);
  }

  markOpen(sessionId: string, ts: string): PtySessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET state = 'open',
              lastAttachedAt = COALESCE(lastAttachedAt, @ts),
              failureCode = NULL,
              failureDetail = NULL
          WHERE sessionId = @sessionId
        `,
      )
      .run({ sessionId, ts });
    return this.getRequired(sessionId);
  }

  markOpenFailed(sessionId: string, code: string, detail: string | null, ts: string): PtySessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET state = 'failed',
              failureCode = @code,
              failureDetail = @detail,
              closedAt = @ts
          WHERE sessionId = @sessionId
        `,
      )
      .run({ sessionId, code, detail, ts });
    return this.getRequired(sessionId);
  }

  markClosing(sessionId: string, ts: string): PtySessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET state = 'closing',
              closeRequestedAt = @ts
          WHERE sessionId = @sessionId
        `,
      )
      .run({ sessionId, ts });
    return this.getRequired(sessionId);
  }

  markClosed(sessionId: string, ts: string, reason?: string | null): PtySessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET state = 'closed',
              closedAt = @ts,
              failureDetail = COALESCE(@reason, failureDetail)
          WHERE sessionId = @sessionId
        `,
      )
      .run({ sessionId, ts, reason: reason ?? null });
    return this.getRequired(sessionId);
  }

  noteOutput(sessionId: string, ts: string): PtySessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET lastOutputAt = @ts
          WHERE sessionId = @sessionId
        `,
      )
      .run({ sessionId, ts });
    return this.getRequired(sessionId);
  }


  markRecordingConsent(sessionId: string, ts: string): PtySessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET recordingConsentAt = @ts
          WHERE sessionId = @sessionId
        `,
      )
      .run({ sessionId, ts });
    return this.getRequired(sessionId);
  }

  attach(sessionId: string, actorType: string, actorId: string | null, ts: string): PtySessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET attachedActorType = @actorType,
              attachedActorId = @actorId,
              lastAttachedAt = @ts,
              lastDetachedAt = NULL
          WHERE sessionId = @sessionId
        `,
      )
      .run({
        sessionId,
        actorType,
        actorId,
        ts,
      });
    return this.getRequired(sessionId);
  }

  detach(sessionId: string, ts: string): PtySessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET attachedActorType = NULL,
              attachedActorId = NULL,
              lastDetachedAt = @ts
          WHERE sessionId = @sessionId
        `,
      )
      .run({ sessionId, ts });
    return this.getRequired(sessionId);
  }

  updateSize(sessionId: string, cols: number, rows: number): PtySessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET cols = @cols,
              rows = @rows
          WHERE sessionId = @sessionId
        `,
      )
      .run({ sessionId, cols, rows });
    return this.getRequired(sessionId);
  }

  expireDetachedSessions(nowIso: string): PtySessionRecord[] {
    const cutoffIso = new Date(Date.parse(nowIso) - this.detachGraceMs).toISOString();
    const records = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM pty_sessions
          WHERE state = 'open'
            AND attachedActorType IS NULL
            AND attachedActorId IS NULL
            AND lastDetachedAt IS NOT NULL
            AND lastDetachedAt <= @cutoffIso
        `,
      )
      .all({ cutoffIso }) as Array<Record<string, unknown>>;
    if (!records.length) {
      return [];
    }
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET state = 'expired',
              expiredAt = @nowIso,
              failureCode = COALESCE(failureCode, 'DETACH_TIMEOUT'),
              failureDetail = COALESCE(failureDetail, 'PTY session expired after detach grace window elapsed')
          WHERE state = 'open'
            AND attachedActorType IS NULL
            AND attachedActorId IS NULL
            AND lastDetachedAt IS NOT NULL
            AND lastDetachedAt <= @cutoffIso
        `,
      )
      .run({ nowIso, cutoffIso });
    return records.map((row) => this.getRequired(String(row.sessionId)));
  }

  expireDeviceSessions(deviceId: string, nowIso: string, reasonCode: string, reasonDetail: string): PtySessionRecord[] {
    const records = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM pty_sessions
          WHERE deviceId = @deviceId
            AND state IN ('opening', 'open', 'closing')
        `,
      )
      .all({ deviceId }) as Array<Record<string, unknown>>;
    if (!records.length) {
      return [];
    }
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET state = 'expired',
              expiredAt = @nowIso,
              failureCode = @reasonCode,
              failureDetail = @reasonDetail
          WHERE deviceId = @deviceId
            AND state IN ('opening', 'open', 'closing')
        `,
      )
      .run({
        deviceId,
        nowIso,
        reasonCode,
        reasonDetail,
      });
    return records.map((row) => this.getRequired(String(row.sessionId)));
  }

  trackPendingReq(deviceId: string, reqSeq: number, sessionId: string, type: PendingReqType) {
    this.pendingByReqSeq.set(`${deviceId}:${reqSeq}`, { sessionId, type });
  }

  consumePendingReq(deviceId: string, reqSeq: number) {
    const key = `${deviceId}:${reqSeq}`;
    const pending = this.pendingByReqSeq.get(key);
    if (pending) {
      this.pendingByReqSeq.delete(key);
    }
    return pending;
  }

  get(sessionId: string): PtySessionRecord | undefined {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM pty_sessions
          WHERE sessionId = ?
        `,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  listByDevice(deviceId: string, limit = 50): PtySessionRecord[] {
    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM pty_sessions
          WHERE deviceId = ?
            AND deletedAt IS NULL
          ORDER BY openedAt DESC
          LIMIT ?
        `,
      )
      .all(deviceId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  deleteTerminalSession(sessionId: string): PtySessionRecord | undefined {
    const record = this.get(sessionId);
    if (!record) {
      return undefined;
    }
    if (!['closed', 'expired', 'failed'].includes(record.state)) {
      throw new Error(`PTY session is not deletable in state ${record.state}`);
    }
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET deletedAt = @deletedAt
          WHERE sessionId = @sessionId
            AND state IN ('closed', 'expired', 'failed')
        `,
      )
      .run({ sessionId, deletedAt: new Date().toISOString() });
    return record;
  }

  pruneTerminalSessions(nowIso: string): PtySessionRecord[] {
    const cutoffIso = new Date(Date.parse(nowIso) - this.terminalRetentionMs).toISOString();
    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM pty_sessions
          WHERE state IN ('closed', 'expired', 'failed')
            AND deletedAt IS NULL
            AND COALESCE(expiredAt, closedAt, closeRequestedAt, openedAt) <= @cutoffIso
        `,
      )
      .all({ cutoffIso }) as Array<Record<string, unknown>>;
    if (!rows.length) {
      return [];
    }
    this.databaseService.connection
      .prepare(
        `
          UPDATE pty_sessions
          SET deletedAt = @nowIso
          WHERE state IN ('closed', 'expired', 'failed')
            AND deletedAt IS NULL
            AND COALESCE(expiredAt, closedAt, closeRequestedAt, openedAt) <= @cutoffIso
        `,
      )
      .run({ cutoffIso, nowIso });
    return rows.map((row) => this.mapRow(row));
  }

  terminalRetentionMsValue() {
    return this.terminalRetentionMs;
  }

  private getRequired(sessionId: string): PtySessionRecord {
    const record = this.get(sessionId);
    if (!record) {
      throw new Error(`PTY session not found: ${sessionId}`);
    }
    return record;
  }

  private mapRow(row: Record<string, unknown>): PtySessionRecord {
    return {
      id: String(row.id),
      sessionId: String(row.sessionId),
      deviceId: String(row.deviceId),
      state: String(row.state) as PtySessionState,
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
    };
  }
}

function nullableString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  return null;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return value;
  }
  return null;
}
