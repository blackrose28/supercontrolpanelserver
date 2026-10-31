import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';
import { DatabaseService } from '../database/database.service';
import {
  COUNT_ACTIVE_FILE_TRANSFERS_BY_DEVICE_SQL,
  COUNT_ACTIVE_FILE_TRANSFERS_SQL,
  DELETE_FILE_TRANSFER_BY_TRANSFER_ID_SQL,
  DELETE_FINISHED_FILE_TRANSFERS_BY_DEVICE_SQL,
  GET_FILE_TRANSFER_BY_TRANSFER_ID_SQL,
  INSERT_FILE_TRANSFER_SQL,
  LIST_ACTIVE_FILE_TRANSFERS_SQL,
  LIST_COMPLETED_FILE_TRANSFERS_BY_DEVICE_SINCE_SQL,
  LIST_COMPLETED_FILE_TRANSFERS_SINCE_SQL,
  LIST_FILE_TRANSFERS_BY_DEVICE_SQL,
  PREPARE_FILE_TRANSFER_RESUME_SQL,
  SUM_TRANSFERRED_BYTES_SINCE_SQL,
  UPDATE_FILE_TRANSFER_COMMAND_SQL,
  UPDATE_FILE_TRANSFER_PROGRESS_SQL,
  UPDATE_FILE_TRANSFER_SESSION_SQL,
  UPDATE_FILE_TRANSFER_STATE_SQL,
} from './file-transfer.queries';
import {
  FileTransferDirection,
  FileTransferRecord,
  FileTransferState,
} from './file-transfer.types';
import { mapFileTransferRow } from './file-transfer.mappers';
import {
  isFinishedTransferState,
  normalizeNullableNonNegativeNumber,
  normalizePositiveInteger,
  sanitizeText,
} from './file-transfer.validators';

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
      .prepare(INSERT_FILE_TRANSFER_SQL)
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
      .prepare(UPDATE_FILE_TRANSFER_STATE_SQL)
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
      .prepare(UPDATE_FILE_TRANSFER_PROGRESS_SQL)
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
      .prepare(UPDATE_FILE_TRANSFER_SESSION_SQL)
      .run({ transferId, sessionId, ts });
    const record = this.getRequired(transferId);
    this.stream.next(record);
    return record;
  }

  attachCommand(transferId: string, commandId: string, reqSeq: number | null, ts: string): FileTransferRecord {
    this.databaseService.connection
      .prepare(UPDATE_FILE_TRANSFER_COMMAND_SQL)
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
      .prepare(PREPARE_FILE_TRANSFER_RESUME_SQL)
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
      .prepare(DELETE_FINISHED_FILE_TRANSFERS_BY_DEVICE_SQL)
      .run(deviceId) as { changes?: number };

    return { deletedCount: Number(result.changes ?? 0) };
  }

  deleteAny(transferId: string): FileTransferRecord | undefined {
    const record = this.get(transferId);
    if (!record) {
      return undefined;
    }

    this.databaseService.connection
      .prepare(DELETE_FILE_TRANSFER_BY_TRANSFER_ID_SQL)
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
      .prepare(DELETE_FILE_TRANSFER_BY_TRANSFER_ID_SQL)
      .run(transferId);
    return record;
  }

  get(transferId: string): FileTransferRecord | undefined {
    const row = this.databaseService.connection
      .prepare(GET_FILE_TRANSFER_BY_TRANSFER_ID_SQL)
      .get(transferId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  listByDevice(deviceId: string, limit = 100): FileTransferRecord[] {
    const rows = this.databaseService.connection
      .prepare(LIST_FILE_TRANSFERS_BY_DEVICE_SQL)
      .all(deviceId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  listCompletedSince(sinceIso: string, deviceId?: string): FileTransferRecord[] {
    const normalizedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : '';
    const rows = normalizedDeviceId
      ? this.databaseService.connection
          .prepare(LIST_COMPLETED_FILE_TRANSFERS_BY_DEVICE_SINCE_SQL)
          .all(normalizedDeviceId, sinceIso)
      : this.databaseService.connection
          .prepare(LIST_COMPLETED_FILE_TRANSFERS_SINCE_SQL)
          .all(sinceIso);
    return (rows as Array<Record<string, unknown>>).map((row) => this.mapRow(row));
  }

  countActiveByDevice(deviceId: string): number {
    const row = this.databaseService.connection
      .prepare(COUNT_ACTIVE_FILE_TRANSFERS_BY_DEVICE_SQL)
      .get(deviceId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  listActive(limit = 100): FileTransferRecord[] {
    const rows = this.databaseService.connection
      .prepare(LIST_ACTIVE_FILE_TRANSFERS_SQL)
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  countActive(): number {
    const row = this.databaseService.connection
      .prepare(COUNT_ACTIVE_FILE_TRANSFERS_SQL)
      .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  sumTransferredBytesSince(sinceIso: string): number {
    const row = this.databaseService.connection
      .prepare(SUM_TRANSFERRED_BYTES_SINCE_SQL)
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
    return mapFileTransferRow(row);
  }
}
