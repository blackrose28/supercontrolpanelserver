import { HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export function readRequiredStringField(payload: unknown, field: string): string {
  if (!payload || typeof payload !== 'object') {
    throw new HttpException({ ok: false, code: 'INVALID_PAYLOAD', message: `${field} is required` }, HttpStatus.BAD_REQUEST);
  }
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpException({ ok: false, code: 'INVALID_PAYLOAD', message: `${field} is required` }, HttpStatus.BAD_REQUEST);
  }
  return value.trim();
}

export function readOptionalStringField(payload: unknown, field: string): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readBooleanField(payload: unknown, field: string, fallback: boolean): boolean {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'boolean' ? value : fallback;
}

export function readNullablePositiveIntField(payload: unknown, field: string): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as Record<string, unknown>)[field];
  if (value == null || value === '') {
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) {
    throw new HttpException({ ok: false, code: 'INVALID_PAYLOAD', message: `${field} must be a positive integer` }, HttpStatus.BAD_REQUEST);
  }
  return num;
}

export function readNullableNonNegativeIntField(payload: unknown, field: string): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as Record<string, unknown>)[field];
  if (value == null || value === '') {
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new HttpException({ ok: false, code: 'INVALID_PAYLOAD', message: `${field} must be a non-negative integer` }, HttpStatus.BAD_REQUEST);
  }
  return num;
}

export function buildTransferPayload(payload: unknown, direction: 'upload' | 'download') {
  const transferId = readOptionalStringField(payload, 'transferId') || randomUUID();
  const serverId = readRequiredStringField(payload, 'serverId');
  const localPath = readRequiredStringField(payload, 'localPath');
  const remotePath = readRequiredStringField(payload, 'remotePath');
  const overwritePolicy = readOptionalStringField(payload, 'overwritePolicy') || 'prompt';
  const resumeToken = readOptionalStringField(payload, 'resumeToken');
  const resumeOffsetBytes = readNullableNonNegativeIntField(payload, 'resumeOffsetBytes');
  const tempPathHint = readOptionalStringField(payload, 'tempPathHint');
  if (!['prompt', 'force', 'skip'].includes(overwritePolicy)) {
    throw new HttpException(
      { ok: false, code: 'INVALID_PAYLOAD', message: 'overwritePolicy must be one of prompt, force, skip' },
      HttpStatus.BAD_REQUEST,
    );
  }
  const resumeFieldCount = [resumeToken, resumeOffsetBytes, tempPathHint].filter((value) => value != null).length;
  if (resumeFieldCount > 0 && resumeFieldCount < 3) {
    throw new HttpException(
      { ok: false, code: 'INVALID_PAYLOAD', message: 'resumeToken, resumeOffsetBytes, and tempPathHint must be provided together' },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (resumeOffsetBytes === 0) {
    throw new HttpException(
      { ok: false, code: 'INVALID_PAYLOAD', message: 'resumeOffsetBytes must be greater than zero when resuming a transfer' },
      HttpStatus.BAD_REQUEST,
    );
  }
  return {
    transferId,
    serverId,
    browserSessionId: readOptionalStringField(payload, 'browserSessionId'),
    localPath,
    remotePath,
    recursive: readBooleanField(payload, 'recursive', false),
    overwritePolicy,
    followSymlinks: readBooleanField(payload, 'followSymlinks', direction === 'download'),
    rateLimitKbps: readNullablePositiveIntField(payload, 'rateLimitKbps'),
    verifyChecksum: readBooleanField(payload, 'verifyChecksum', false),
    preserveMtime: readBooleanField(payload, 'preserveMtime', false),
    preserveMode: readBooleanField(payload, 'preserveMode', false),
    resumeToken,
    resumeOffsetBytes,
    tempPathHint,
  };
}

export function isResumeTransferPayload(payload: {
  resumeToken?: string | null;
  resumeOffsetBytes?: number | null;
  tempPathHint?: string | null;
}) {
  return Boolean(payload.resumeToken && payload.tempPathHint && typeof payload.resumeOffsetBytes === 'number');
}

export function describeSymlinkPolicy(direction: 'upload' | 'download', followSymlinks: boolean): string {
  if (direction === 'upload') {
    return followSymlinks
      ? 'symlink policy: follow local symlink targets'
      : 'symlink policy: reject local symlink sources';
  }
  return followSymlinks
    ? 'symlink policy: follow remote symlink targets'
    : 'symlink policy: preserve remote symlinks (not yet supported by agent)';
}

export function readRequiredServerId(payload: unknown): string {
  const serverId =
    payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).serverId === 'string'
      ? (payload as Record<string, string>).serverId.trim()
      : '';
  if (!serverId) {
    throw new HttpException('payload.serverId is required', HttpStatus.BAD_REQUEST);
  }
  return serverId;
}
