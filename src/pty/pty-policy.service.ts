import { ForbiddenException } from '@nestjs/common';
import { AdminAuthPrincipal } from '../admin/admin-auth';
import { DeviceStore } from '../devices/device.store';
import { PtyGatewayError } from './pty-gateway.errors';
import { PtySessionRecord, PtySessionStore } from './pty-session.store';

export function ensureRecordingScope(principal: AdminAuthPrincipal, recordingEnabled: boolean) {
  if (!recordingEnabled || principal.kind === 'session' || principal.kind === 'env-token') {
    return;
  }
  if (!principal.scopes.includes('device:record')) {
    throw new ForbiddenException('Missing device:record scope');
  }
}

export function ensureRecordingConsent(record: PtySessionRecord) {
  if (!record.recordingEnabled || record.recordingConsentAt) {
    return;
  }
  throw new PtyGatewayError(
    'PTY_RECORDING_CONSENT_REQUIRED',
    'Acknowledge recording before sending PTY input',
    { consentRequired: true },
  );
}

export function requireDeviceId(payload: Record<string, unknown>, deviceStore: DeviceStore): string {
  const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId.trim() : '';
  if (!deviceId || !deviceStore.getDevice(deviceId)) {
    throw new PtyGatewayError('DEVICE_NOT_FOUND', 'Device not found');
  }
  return deviceId;
}

export function readSessionId(payload: Record<string, unknown>): string {
  return typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
}

export function readRequiredSessionId(payload: Record<string, unknown>): string {
  const sessionId = readSessionId(payload);
  if (!sessionId) {
    throw new PtyGatewayError('SESSION_ID_REQUIRED', 'sessionId is required');
  }
  return sessionId;
}

export function readPositiveInt(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new PtyGatewayError('PTY_INVALID_SIZE', `${field} must be a positive integer`);
  }
  return normalized;
}

export function requirePtySession(store: PtySessionStore, deviceId: string, sessionId: string): PtySessionRecord {
  const record = store.get(sessionId);
  if (!record || record.deviceId !== deviceId) {
    throw new PtyGatewayError('PTY_NOT_FOUND', 'PTY session not found for this device');
  }
  return record;
}

export function ensureActorMayAttach(record: PtySessionRecord, actorType: string, actorId: string | null) {
  if (['closed', 'expired', 'failed'].includes(record.state)) {
    throw new PtyGatewayError('PTY_ALREADY_CLOSED', `PTY session is in terminal state ${record.state}`);
  }
  if (!record.attachedActorType) {
    return;
  }
  if (isSameActor(record, actorType, actorId)) {
    return;
  }
  throw new PtyGatewayError('PTY_UNAUTHORIZED', 'PTY session is already attached by another operator');
}

export function ensureActorOwnsAttachment(record: PtySessionRecord, actorType: string, actorId: string | null) {
  if (isSameActor(record, actorType, actorId)) {
    return;
  }
  throw new PtyGatewayError('PTY_UNAUTHORIZED', 'PTY session is not attached to the current operator');
}

export function isSameActor(record: PtySessionRecord, actorType: string, actorId: string | null) {
  return record.attachedActorType === actorType && record.attachedActorId === actorId;
}
