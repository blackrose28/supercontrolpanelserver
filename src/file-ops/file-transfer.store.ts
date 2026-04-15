import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';
import { DatabaseService } from '../database/database.service';
import { redactTelemetryPayload } from '../logs/log-redaction';

export type FileTransferState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export type FileTransferDirection = 'upload' | 'download';

export interface FileTransferRecord {
  id: string;
  transferId: string;
  deviceId: string;
  serverId: string;
  browserSessionId: string | null;
  sessionId: string | null;
  actorType: string | null;
  actorId: string | null;
  state: FileTransferState;
  direction: FileTransferDirection;
  localPath: string | null;
  remotePath: string | null;
  recursive: boolean;
  overwritePolicy: string | null;
  followSymlinks: boolean;
  rateLimitKbps: number | null;
  verifyChecksum: boolean;
  preserveMtime: boolean;
  preserveMode: boolean;
  attempt: number;
  maxAttempts: number;
  resumeSupported: boolean;
  retryScheduled: boolean;
  resumeToken: string | null;
  resumeOffsetBytes: number | null;
  tempPathHint: string | null;
  progressEventCount: number;
  firstProgressAt: string | null;
  lastProgressAt: string | null;
  finalizeSeen: boolean;
  bytesTransferred: number;
  bytesTotal: number | null;
  percent: number | null;
  throughputBps: number | null;
  etaSec: number | null;
  phase: string | null;
  reasonCode: string | null;
  reasonDetail: string | null;
  message: string | null;
  commandId: string | null;
  reqSeq: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class FileTransferStore {
  private readonly stream = new Subject<FileTransferRecord>();

  constructor(private readonly databaseService: DatabaseService) {}

  create(input: {
    id: string;
    transferId: string;
    deviceId: string;
    serverId: string;
    direction: FileTransferDirection;
    actorType?: string | null;
    actorId?: string | null;
    browserSessionId?: string | null;
    sessionId?: string | null;
    localPath?: string | null;
    remotePath?: string | null;
    recursive?: boolean;
    overwritePolicy?: string | null;
    followSymlinks?: boolean;
    rateLimitKbps?: number | null;
    verifyChecksum?: boolean;
    preserveMtime?: boolean;
    preserveMode?: boolean;
    attempt?: number;
    maxAttempts?: number;
    resumeSupported?: boolean;
    retryScheduled?: boolean;
    resumeToken?: string | null;
    resumeOffsetBytes?: number | null;
    tempPathHint?: string | null;
    commandId?: string | null;
    reqSeq?: number | null;
    ts: string;
  }): FileTransferRecord {
    this.databaseService.connection
      .prepare(
        `
          INSERT INTO file_transfers (
            id, transferId, deviceId, serverId, browserSessionId, sessionId, actorType, actorId,
            state, direction, localPath, remotePath, recursive, overwritePolicy,
            followSymlinks, rateLimitKbps, verifyChecksum, preserveMtime, preserveMode,
            attempt, maxAttempts, resumeSupported, retryScheduled, resumeToken, resumeOffsetBytes, tempPathHint,
            progressEventCount, firstProgressAt, lastProgressAt, finalizeSeen,
            bytesTransferred, bytesTotal, percent, throughputBps, etaSec, phase,
            reasonCode, reasonDetail, message, commandId, reqSeq, createdAt, updatedAt
          )
          VALUES (
            @id, @transferId, @deviceId, @serverId, @browserSessionId, @sessionId, @actorType, @actorId,
            'queued', @direction, @localPath, @remotePath, @recursive, @overwritePolicy,
            @followSymlinks, @rateLimitKbps, @verifyChecksum, @preserveMtime, @preserveMode,
            @attempt, @maxAttempts, @resumeSupported, @retryScheduled, @resumeToken, @resumeOffsetBytes, @tempPathHint,
            0, NULL, NULL, 0,
            0, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, @commandId, @reqSeq, @ts, @ts
          )
        `,
      )
      .run({
        ...input,
        browserSessionId: input.browserSessionId ?? null,
        sessionId: input.sessionId ?? null,
        actorType: input.actorType ?? null,
        actorId: input.actorId ?? null,
        localPath: input.localPath ?? null,
        remotePath: input.remotePath ?? null,
        recursive: input.recursive ? 1 : 0,
        overwritePolicy: input.overwritePolicy ?? null,
        followSymlinks: input.followSymlinks ? 1 : 0,
        rateLimitKbps: input.rateLimitKbps ?? null,
        verifyChecksum: input.verifyChecksum ? 1 : 0,
        preserveMtime: input.preserveMtime ? 1 : 0,
        preserveMode: input.preserveMode ? 1 : 0,
        attempt: normalizePositiveInteger(input.attempt, 1),
        maxAttempts: normalizePositiveInteger(input.maxAttempts, 1),
        resumeSupported: input.resumeSupported ? 1 : 0,
        retryScheduled: input.retryScheduled ? 1 : 0,
        resumeToken: sanitizeText(input.resumeToken ?? null),
        resumeOffsetBytes: normalizeNullableNonNegativeNumber(input.resumeOffsetBytes),
        tempPathHint: sanitizeText(input.tempPathHint ?? null),
        commandId: input.commandId ?? null,
        reqSeq: input.reqSeq ?? null,
      });

    const record = this.getRequired(input.transferId);
    this.stream.next(record);
    return record;
  }

  markState(
    transferId: string,
    state: FileTransferState,
    ts: string,
    fields?: {
      phase?: string | null;
      reasonCode?: string | null;
      reasonDetail?: string | null;
      message?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
      attempt?: number | null;
      maxAttempts?: number | null;
      resumeSupported?: boolean | null;
      retryScheduled?: boolean | null;
      resumeToken?: string | null;
      resumeOffsetBytes?: number | null;
      tempPathHint?: string | null;
    },
  ): FileTransferRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE file_transfers
          SET state = @state,
              phase = COALESCE(@phase, phase),
              reasonCode = @reasonCode,
              reasonDetail = @reasonDetail,
              message = COALESCE(@message, message),
              attempt = COALESCE(@attempt, attempt),
              maxAttempts = COALESCE(@maxAttempts, maxAttempts),
              resumeSupported = COALESCE(@resumeSupported, resumeSupported),
              retryScheduled = COALESCE(@retryScheduled, retryScheduled),
              resumeToken = COALESCE(@resumeToken, resumeToken),
              resumeOffsetBytes = COALESCE(@resumeOffsetBytes, resumeOffsetBytes),
              tempPathHint = COALESCE(@tempPathHint, tempPathHint),
              finalizeSeen = CASE
                WHEN @state IN ('queued', 'starting', 'running') THEN 0
                WHEN @finalizeSeen = 1 THEN 1
                ELSE finalizeSeen
              END,
              startedAt = COALESCE(@startedAt, startedAt, CASE WHEN @state IN ('starting', 'running') THEN @ts ELSE NULL END),
              finishedAt = CASE
                WHEN @state IN ('succeeded', 'failed', 'canceled') THEN COALESCE(@finishedAt, @ts)
                WHEN @state IN ('queued', 'starting', 'running') THEN NULL
                ELSE finishedAt
              END,
              updatedAt = @ts
          WHERE transferId = @transferId
        `,
      )
      .run({
        transferId,
        state,
        phase: fields?.phase ?? null,
        reasonCode: fields?.reasonCode ?? null,
        reasonDetail: sanitizeText(fields?.reasonDetail ?? null),
        message: sanitizeText(fields?.message ?? null),
        attempt: typeof fields?.attempt === 'number' ? normalizePositiveInteger(fields.attempt, 1) : null,
        maxAttempts: typeof fields?.maxAttempts === 'number' ? normalizePositiveInteger(fields.maxAttempts, 1) : null,
        resumeSupported: typeof fields?.resumeSupported === 'boolean' ? (fields.resumeSupported ? 1 : 0) : null,
        retryScheduled: typeof fields?.retryScheduled === 'boolean' ? (fields.retryScheduled ? 1 : 0) : null,
        resumeToken: sanitizeText(fields?.resumeToken ?? null),
        resumeOffsetBytes: normalizeNullableNonNegativeNumber(fields?.resumeOffsetBytes),
        tempPathHint: sanitizeText(fields?.tempPathHint ?? null),
        finalizeSeen: fields?.phase === 'finalize' ? 1 : 0,
        startedAt: fields?.startedAt ?? null,
        finishedAt: fields?.finishedAt ?? null,
        ts,
      });
    const record = this.getRequired(transferId);
    this.stream.next(record);
    return record;
  }

  updateProgress(
    transferId: string,
    ts: string,
    progress: {
      bytesTransferred: number;
      bytesTotal?: number | null;
      percent?: number | null;
      throughputBps?: number | null;
      etaSec?: number | null;
      phase?: string | null;
      message?: string | null;
      attempt?: number | null;
      maxAttempts?: number | null;
      resumeSupported?: boolean | null;
      retryScheduled?: boolean | null;
      resumeToken?: string | null;
      resumeOffsetBytes?: number | null;
      tempPathHint?: string | null;
    },
  ): FileTransferRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE file_transfers
          SET state = CASE WHEN state IN ('queued', 'failed', 'canceled', 'succeeded') THEN 'running' ELSE state END,
              bytesTransferred = @bytesTransferred,
              bytesTotal = COALESCE(@bytesTotal, bytesTotal),
              percent = @percent,
              throughputBps = @throughputBps,
              etaSec = @etaSec,
              phase = COALESCE(@phase, phase),
              message = COALESCE(@message, message),
              attempt = COALESCE(@attempt, attempt),
              maxAttempts = COALESCE(@maxAttempts, maxAttempts),
              resumeSupported = COALESCE(@resumeSupported, resumeSupported),
              retryScheduled = COALESCE(@retryScheduled, retryScheduled),
              resumeToken = COALESCE(@resumeToken, resumeToken),
              resumeOffsetBytes = COALESCE(@resumeOffsetBytes, resumeOffsetBytes),
              tempPathHint = COALESCE(@tempPathHint, tempPathHint),
              progressEventCount = progressEventCount + 1,
              firstProgressAt = COALESCE(firstProgressAt, @ts),
              lastProgressAt = @ts,
              finalizeSeen = CASE WHEN @phase = 'finalize' THEN 1 ELSE finalizeSeen END,
              startedAt = COALESCE(startedAt, @ts),
              finishedAt = NULL,
              updatedAt = @ts
          WHERE transferId = @transferId
        `,
      )
      .run({
        transferId,
        bytesTransferred: progress.bytesTransferred,
        bytesTotal: progress.bytesTotal ?? null,
        percent: progress.percent ?? null,
        throughputBps: progress.throughputBps ?? null,
        etaSec: progress.etaSec ?? null,
        phase: progress.phase ?? null,
        message: sanitizeText(progress.message ?? null),
        attempt: typeof progress.attempt === 'number' ? normalizePositiveInteger(progress.attempt, 1) : null,
        maxAttempts: typeof progress.maxAttempts === 'number' ? normalizePositiveInteger(progress.maxAttempts, 1) : null,
        resumeSupported: typeof progress.resumeSupported === 'boolean' ? (progress.resumeSupported ? 1 : 0) : null,
        retryScheduled: typeof progress.retryScheduled === 'boolean' ? (progress.retryScheduled ? 1 : 0) : null,
        resumeToken: sanitizeText(progress.resumeToken ?? null),
        resumeOffsetBytes: normalizeNullableNonNegativeNumber(progress.resumeOffsetBytes),
        tempPathHint: sanitizeText(progress.tempPathHint ?? null),
        ts,
      });
    const record = this.getRequired(transferId);
    this.stream.next(record);
    return record;
  }

  attachSession(transferId: string, sessionId: string, ts: string): FileTransferRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE file_transfers
          SET sessionId = @sessionId,
              updatedAt = @ts
          WHERE transferId = @transferId
        `,
      )
      .run({ transferId, sessionId, ts });
    const record = this.getRequired(transferId);
    this.stream.next(record);
    return record;
  }

  attachCommand(transferId: string, commandId: string, reqSeq: number | null, ts: string): FileTransferRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE file_transfers
          SET commandId = @commandId,
              reqSeq = @reqSeq,
              updatedAt = @ts
          WHERE transferId = @transferId
        `,
      )
      .run({ transferId, commandId, reqSeq, ts });
    const record = this.getRequired(transferId);
    this.stream.next(record);
    return record;
  }

  prepareForResume(
    transferId: string,
    ts: string,
    fields: {
      attempt?: number | null;
      maxAttempts?: number | null;
      resumeSupported?: boolean | null;
      retryScheduled?: boolean | null;
      resumeToken?: string | null;
      resumeOffsetBytes?: number | null;
      tempPathHint?: string | null;
      message?: string | null;
    },
  ): FileTransferRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE file_transfers
          SET state = 'queued',
              phase = 'precheck',
              reasonCode = NULL,
              reasonDetail = NULL,
              message = COALESCE(@message, message),
              attempt = COALESCE(@attempt, attempt),
              maxAttempts = COALESCE(@maxAttempts, maxAttempts),
              resumeSupported = COALESCE(@resumeSupported, resumeSupported),
              retryScheduled = COALESCE(@retryScheduled, retryScheduled),
              resumeToken = COALESCE(@resumeToken, resumeToken),
              resumeOffsetBytes = COALESCE(@resumeOffsetBytes, resumeOffsetBytes),
              tempPathHint = COALESCE(@tempPathHint, tempPathHint),
              finalizeSeen = 0,
              finishedAt = NULL,
              updatedAt = @ts
          WHERE transferId = @transferId
        `,
      )
      .run({
        transferId,
        message: sanitizeText(fields.message ?? null),
        attempt: typeof fields.attempt === 'number' ? normalizePositiveInteger(fields.attempt, 1) : null,
        maxAttempts: typeof fields.maxAttempts === 'number' ? normalizePositiveInteger(fields.maxAttempts, 1) : null,
        resumeSupported: typeof fields.resumeSupported === 'boolean' ? (fields.resumeSupported ? 1 : 0) : null,
        retryScheduled: typeof fields.retryScheduled === 'boolean' ? (fields.retryScheduled ? 1 : 0) : null,
        resumeToken: sanitizeText(fields.resumeToken ?? null),
        resumeOffsetBytes: normalizeNullableNonNegativeNumber(fields.resumeOffsetBytes),
        tempPathHint: sanitizeText(fields.tempPathHint ?? null),
        ts,
      });
    const record = this.getRequired(transferId);
    this.stream.next(record);
    return record;
  }

  deleteFinishedByDevice(deviceId: string): { deletedCount: number } {
    const result = this.databaseService.connection
      .prepare(
        `
          DELETE FROM file_transfers
          WHERE deviceId = ?
            AND state IN ('succeeded', 'failed', 'canceled')
        `,
      )
      .run(deviceId) as { changes?: number };

    return { deletedCount: Number(result.changes ?? 0) };
  }

  deleteAny(transferId: string): FileTransferRecord | undefined {
    const record = this.get(transferId);
    if (!record) {
      return undefined;
    }

    this.databaseService.connection
      .prepare(
        `
          DELETE FROM file_transfers
          WHERE transferId = ?
        `,
      )
      .run(transferId);
    return record;
  }

  deleteFinished(transferId: string): FileTransferRecord | undefined {
    const record = this.get(transferId);
    if (!record) {
      return undefined;
    }
    if (!isFinishedTransferState(record.state)) {
      throw new Error(`File transfer is not finished: ${transferId}`);
    }

    this.databaseService.connection
      .prepare(
        `
          DELETE FROM file_transfers
          WHERE transferId = ?
        `,
      )
      .run(transferId);
    return record;
  }

  get(transferId: string): FileTransferRecord | undefined {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM file_transfers
          WHERE transferId = ?
        `,
      )
      .get(transferId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  listByDevice(deviceId: string, limit = 100): FileTransferRecord[] {
    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM file_transfers
          WHERE deviceId = ?
          ORDER BY updatedAt DESC, createdAt DESC
          LIMIT ?
        `,
      )
      .all(deviceId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  listCompletedSince(sinceIso: string, deviceId?: string): FileTransferRecord[] {
    const normalizedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : '';
    const rows = normalizedDeviceId
      ? this.databaseService.connection
          .prepare(
            `
              SELECT *
              FROM file_transfers
              WHERE deviceId = ?
                AND state IN ('succeeded', 'failed', 'canceled')
                AND COALESCE(finishedAt, updatedAt) >= ?
              ORDER BY COALESCE(finishedAt, updatedAt) DESC
            `,
          )
          .all(normalizedDeviceId, sinceIso)
      : this.databaseService.connection
          .prepare(
            `
              SELECT *
              FROM file_transfers
              WHERE state IN ('succeeded', 'failed', 'canceled')
                AND COALESCE(finishedAt, updatedAt) >= ?
              ORDER BY COALESCE(finishedAt, updatedAt) DESC
            `,
          )
          .all(sinceIso);
    return (rows as Array<Record<string, unknown>>).map((row) => this.mapRow(row));
  }

  countActiveByDevice(deviceId: string): number {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT COUNT(*) as count
          FROM file_transfers
          WHERE deviceId = ?
            AND state IN ('queued', 'starting', 'running')
        `,
      )
      .get(deviceId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  listActive(limit = 100): FileTransferRecord[] {
    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM file_transfers
          WHERE state IN ('queued', 'starting', 'running', 'failed')
          ORDER BY updatedAt DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  countActive(): number {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT COUNT(*) as count
          FROM file_transfers
          WHERE state IN ('queued', 'starting', 'running')
        `,
      )
      .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  sumTransferredBytesSince(sinceIso: string): number {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT COALESCE(SUM(bytesTransferred), 0) as total
          FROM file_transfers
          WHERE state IN ('succeeded', 'failed', 'canceled')
            AND COALESCE(finishedAt, updatedAt) >= ?
        `,
      )
      .get(sinceIso) as { total?: number } | undefined;
    return Number(row?.total ?? 0);
  }

  streamByDevice(deviceId: string): Observable<FileTransferRecord> {
    return this.stream.asObservable().pipe(
      filter((record) => record.deviceId === deviceId),
    );
  }

  private getRequired(transferId: string): FileTransferRecord {
    const record = this.get(transferId);
    if (!record) {
      throw new Error(`File transfer not found: ${transferId}`);
    }
    return record;
  }

  private mapRow(row: Record<string, unknown>): FileTransferRecord {
    return {
      id: String(row.id),
      transferId: String(row.transferId),
      deviceId: String(row.deviceId),
      serverId: String(row.serverId),
      browserSessionId: nullableString(row.browserSessionId),
      sessionId: nullableString(row.sessionId),
      actorType: nullableString(row.actorType),
      actorId: nullableString(row.actorId),
      state: String(row.state) as FileTransferState,
      direction: String(row.direction) as FileTransferDirection,
      localPath: nullableString(row.localPath),
      remotePath: nullableString(row.remotePath),
      recursive: Number(row.recursive ?? 0) === 1,
      overwritePolicy: nullableString(row.overwritePolicy),
      followSymlinks: Number(row.followSymlinks ?? 0) === 1,
      rateLimitKbps: nullableNumber(row.rateLimitKbps),
      verifyChecksum: Number(row.verifyChecksum ?? 0) === 1,
      preserveMtime: Number(row.preserveMtime ?? 0) === 1,
      preserveMode: Number(row.preserveMode ?? 0) === 1,
      attempt: normalizePositiveInteger(row.attempt, 1),
      maxAttempts: normalizePositiveInteger(row.maxAttempts, 1),
      resumeSupported: Number(row.resumeSupported ?? 0) === 1,
      retryScheduled: Number(row.retryScheduled ?? 0) === 1,
      resumeToken: nullableString(row.resumeToken),
      resumeOffsetBytes: nullableNumber(row.resumeOffsetBytes),
      tempPathHint: nullableString(row.tempPathHint),
      progressEventCount: normalizeNonNegativeInteger(row.progressEventCount, 0),
      firstProgressAt: nullableString(row.firstProgressAt),
      lastProgressAt: nullableString(row.lastProgressAt),
      finalizeSeen: Number(row.finalizeSeen ?? 0) === 1,
      bytesTransferred: Number(row.bytesTransferred ?? 0),
      bytesTotal: nullableNumber(row.bytesTotal),
      percent: nullableNumber(row.percent),
      throughputBps: nullableNumber(row.throughputBps),
      etaSec: nullableNumber(row.etaSec),
      phase: nullableString(row.phase),
      reasonCode: nullableString(row.reasonCode),
      reasonDetail: nullableString(row.reasonDetail),
      message: nullableString(row.message),
      commandId: nullableString(row.commandId),
      reqSeq: nullableNumber(row.reqSeq),
      startedAt: nullableString(row.startedAt),
      finishedAt: nullableString(row.finishedAt),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isFinishedTransferState(state: FileTransferState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'canceled';
}

function sanitizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return redactTelemetryPayload(value);
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num) && num >= 0 ? num : fallback;
}

function normalizeNullableNonNegativeNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}
