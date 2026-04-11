import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  AdminAuthPrincipal,
  authenticateAdminApiToken,
  hasValidAdminSession,
  parseCookies,
} from '../admin/admin-auth';
import { AdminSessionService } from '../admin/admin-session.service';
import { AdminApiTokenService } from '../admin/admin-api-token.service';
import { DeviceStore } from '../devices/device.store';
import { AgentGateway } from '../agent/agent.gateway';
import { PtySessionRecord, PtySessionStore } from './pty-session.store';
import { PtyHubService } from './pty-hub.service';
import { PtyAuditStore } from './pty-audit.store';

@WebSocketGateway({ path: '/admin/ws/pty' })
export class PtyGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly writeRateLimits = new Map<string, RateLimitBucket>();
  private readonly resizeRateLimits = new Map<string, RateLimitBucket>();

  constructor(
    private readonly adminSessions: AdminSessionService,
    private readonly adminApiTokens: AdminApiTokenService,
    private readonly deviceStore: DeviceStore,
    private readonly agentGateway: AgentGateway,
    private readonly ptySessions: PtySessionStore,
    private readonly ptyHub: PtyHubService,
    private readonly ptyAudit: PtyAuditStore,
  ) {}

  handleConnection(client: any, request: any) {
    try {
      client.principal = authenticatePtyPrincipal(
        request?.headers?.authorization,
        request?.headers?.cookie,
        this.adminSessions,
        this.adminApiTokens,
      );
    } catch (error) {
      client.close(1008, error instanceof Error ? error.message : 'AUTH_FAILED');
      return;
    }

    this.ptyHub.registerClient(client);
    client.on('message', (raw: Buffer | string) => {
      const data = typeof raw === 'string' ? raw : raw.toString('utf8');
      this.handleRawMessage(data, client);
    });

    this.ptyHub.send(client, {
      type: 'pty_state',
      payload: { state: 'connected' },
    });
  }

  handleDisconnect(client: any) {
    const principal = client?.principal;
    if (!principal) {
      this.ptyHub.unregisterClient(client);
      return;
    }
    const actor = mapPrincipalToPtyActor(principal);
    for (const sessionId of this.ptyHub.sessionsForClient(client)) {
      const record = this.ptySessions.get(sessionId);
      if (record && isSameActor(record, actor.actorType, actor.actorId)) {
        const detached = this.ptySessions.detach(sessionId, new Date().toISOString());
        this.appendAudit(detached, 'pty_detached', actor, 'PTY session detached because browser websocket disconnected');
      }
    }
    this.ptyHub.unregisterClient(client);
  }

  publishPtyOutput(sessionId: string, payload: Record<string, unknown>) {
    this.ptyHub.broadcast(sessionId, {
      type: 'pty_output',
      payload,
    });
  }

  publishPtyExit(sessionId: string, payload: Record<string, unknown>) {
    this.ptyHub.broadcast(sessionId, {
      type: 'pty_exit',
      payload,
    });
  }

  private appendAudit(
    record: Pick<PtySessionRecord, 'sessionId' | 'deviceId'>,
    eventType: string,
    actor: { actorType: string; actorId: string | null },
    summary: string,
    details?: Record<string, unknown>,
  ) {
    this.ptyAudit.append({
      id: uuidv4(),
      sessionId: record.sessionId,
      deviceId: record.deviceId,
      ts: new Date().toISOString(),
      eventType,
      actorType: actor.actorType as any,
      actorId: actor.actorId,
      summary,
      details,
    });
  }

  private auditExpiredSessions(records: PtySessionRecord[]) {
    for (const record of records) {
      this.ptyAudit.append({
        id: uuidv4(),
        sessionId: record.sessionId,
        deviceId: record.deviceId,
        ts: record.expiredAt || new Date().toISOString(),
        eventType: 'pty_expired',
        actorType: 'system',
        actorId: null,
        summary: 'PTY session expired after detach grace window elapsed',
        details: { reasonCode: record.failureCode, reasonDetail: record.failureDetail },
      });
    }
  }

  private handleRawMessage(data: string, client: any) {
    let envelope: any;
    try {
      envelope = JSON.parse(data);
    } catch {
      this.ptyHub.send(client, errorMessage('pty_error', 'INVALID_JSON', 'Invalid PTY websocket JSON message'));
      return;
    }

    const msgType = typeof envelope?.type === 'string' ? envelope.type.trim() : '';
    const payload =
      envelope?.payload && typeof envelope.payload === 'object' ? envelope.payload : {};

    try {
      switch (msgType) {
        case 'pty_open':
          this.handleOpen(client, payload);
          return;
        case 'pty_attach':
          this.handleAttach(client, payload);
          return;
        case 'pty_detach':
          this.handleDetach(client, payload);
          return;
        case 'pty_recording_consent':
          this.handleRecordingConsent(client, payload);
          return;
        case 'pty_write':
          this.handleWrite(client, payload);
          return;
        case 'pty_resize':
          this.handleResize(client, payload);
          return;
        case 'pty_close':
          this.handleClose(client, payload);
          return;
        default:
          this.ptyHub.send(client, errorMessage('pty_error', 'UNSUPPORTED_MESSAGE_TYPE', `Unsupported PTY message type: ${msgType || 'unknown'}`));
      }
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
        auditRejectedAction(this.ptyAudit, this.ptySessions, msgType, payload, this.deviceStore, client.principal, 'PTY_UNAUTHORIZED', 'PTY access denied');
        this.ptyHub.send(client, errorMessage('pty_error', 'PTY_UNAUTHORIZED', 'PTY access denied'));
        return;
      }
      if (error instanceof PtyGatewayError) {
        if (shouldAuditReject(msgType)) {
          auditRejectedAction(this.ptyAudit, this.ptySessions, msgType, payload, this.deviceStore, client.principal, error.code, error.message, error.details);
        }
        this.ptyHub.send(client, errorMessage('pty_error', error.code, error.message, error.details));
        return;
      }
      this.ptyHub.send(client, errorMessage('pty_error', 'PTY_INTERNAL_ERROR', error instanceof Error ? error.message : 'PTY websocket action failed'));
    }
  }

  private handleOpen(client: any, payload: Record<string, unknown>) {
    const actor = mapPrincipalToPtyActor(client.principal);
    const deviceId = requireDeviceId(payload, this.deviceStore);
    this.auditExpiredSessions(this.ptySessions.expireDetachedSessions(new Date().toISOString()));
    const sessionId = readSessionId(payload) || `pty-${uuidv4()}`;
    const cols = readPositiveInt(payload.cols, 'cols');
    const rows = readPositiveInt(payload.rows, 'rows');
    this.ptyHub.clearScrollback(sessionId);
    ensureRecordingScope(client.principal, Boolean(payload.recording));
    const result = this.agentGateway.openPty(deviceId, {
      sessionId,
      cols,
      rows,
      recording: Boolean(payload.recording),
      actorType: actor.actorType,
      actorId: actor.actorId,
    });
    if (!result.ok) {
      throw new PtyGatewayError(result.reason ?? 'DEVICE_NOT_CONNECTED', 'Failed to open PTY');
    }
    this.appendAudit(this.ptySessions.get(sessionId) ?? { sessionId, deviceId } as any, 'pty_open_requested', actor, 'PTY open requested', { recordingEnabled: Boolean(payload.recording), cols, rows });
    this.ptyHub.attachClient(client, sessionId);
    this.ptyHub.replayToClient(client, sessionId);
    this.ptyHub.send(client, {
      type: 'pty_opened',
      payload: {
        sessionId,
        state: 'opening',
        deviceId,
      },
    });
  }

  private handleAttach(client: any, payload: Record<string, unknown>) {
    const actor = mapPrincipalToPtyActor(client.principal);
    const deviceId = requireDeviceId(payload, this.deviceStore);
    this.auditExpiredSessions(this.ptySessions.expireDetachedSessions(new Date().toISOString()));
    const record = requirePtySession(this.ptySessions, deviceId, readRequiredSessionId(payload));
    ensureRecordingScope(client.principal, record.recordingEnabled);
    ensureActorMayAttach(record, actor.actorType, actor.actorId);
    const updated = this.ptySessions.attach(record.sessionId, actor.actorType, actor.actorId, new Date().toISOString());
    this.ptyHub.attachClient(client, updated.sessionId);
    this.ptyHub.replayToClient(client, updated.sessionId);
    this.ptyHub.send(client, {
      type: 'pty_opened',
      payload: {
        sessionId: updated.sessionId,
        state: updated.state,
        deviceId,
      },
    });
    this.appendAudit(updated, 'pty_attach_succeeded', actor, 'PTY session attached');
  }

  private handleDetach(client: any, payload: Record<string, unknown>) {
    const actor = mapPrincipalToPtyActor(client.principal);
    const record = requirePtySession(this.ptySessions, requireDeviceId(payload, this.deviceStore), readRequiredSessionId(payload));
    ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
    const updated = this.ptySessions.detach(record.sessionId, new Date().toISOString());
    this.ptyHub.detachClient(client, record.sessionId);
    this.appendAudit(updated, 'pty_detached', actor, 'PTY session detached');
    this.ptyHub.send(client, {
      type: 'pty_state',
      payload: {
        sessionId: updated.sessionId,
        state: updated.state,
        detached: true,
      },
    });
  }


  private handleRecordingConsent(client: any, payload: Record<string, unknown>) {
    const actor = mapPrincipalToPtyActor(client.principal);
    const deviceId = requireDeviceId(payload, this.deviceStore);
    const record = requirePtySession(this.ptySessions, deviceId, readRequiredSessionId(payload));
    ensureRecordingScope(client.principal, record.recordingEnabled);
    ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
    if (!record.recordingEnabled) {
      throw new PtyGatewayError('PTY_RECORDING_NOT_ENABLED', 'PTY session is not recording-enabled');
    }
    const ts = new Date().toISOString();
    const updated = this.ptySessions.markRecordingConsent(record.sessionId, ts);
    this.ptyAudit.append({
      id: uuidv4(),
      sessionId: updated.sessionId,
      deviceId: updated.deviceId,
      ts,
      eventType: 'pty_recording_consent_granted',
      actorType: actor.actorType as any,
      actorId: actor.actorId,
      summary: 'Recording consent granted for PTY session',
      details: {
        recordingEnabled: true,
      },
    });
    this.ptyHub.send(client, {
      type: 'pty_state',
      payload: {
        sessionId: updated.sessionId,
        recordingEnabled: true,
        recordingConsentAt: updated.recordingConsentAt,
        consentGranted: true,
      },
    });
  }

  private handleWrite(client: any, payload: Record<string, unknown>) {
    const actor = mapPrincipalToPtyActor(client.principal);
    const deviceId = requireDeviceId(payload, this.deviceStore);
    const record = requirePtySession(this.ptySessions, deviceId, readRequiredSessionId(payload));
    ensureRecordingScope(client.principal, record.recordingEnabled);
    ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
    ensureRecordingConsent(record);
    const rateLimit = consumeRateLimit(this.writeRateLimits, record.sessionId, 200, 100, Date.now());
    if (!rateLimit.allowed) {
      throw new PtyGatewayError('PTY_RATE_LIMITED', 'PTY input rate limited', {
        rate_limited: true,
        retryAfterMs: rateLimit.retryAfterMs,
      });
    }
    const sanitized = sanitizePtyInput(typeof payload.data === 'string' ? payload.data : '');
    if (!sanitized.data.length) {
      throw new PtyGatewayError('PTY_INPUT_REJECTED', 'PTY input was empty after sanitization', {
        filtered: sanitized.filtered,
      });
    }
    if (sanitized.filtered) {
      this.ptyHub.send(client, {
        type: 'pty_state',
        payload: {
          sessionId: record.sessionId,
          warning: 'PTY input was sanitized before sending to the agent.',
        },
      });
    }
    const result = this.agentGateway.writePty(deviceId, {
      sessionId: record.sessionId,
      data: sanitized.data,
    });
    if (!result.ok) {
      throw new PtyGatewayError(result.reason ?? 'PTY_WRITE_REJECTED', 'Failed to write PTY');
    }
  }

  private handleResize(client: any, payload: Record<string, unknown>) {
    const actor = mapPrincipalToPtyActor(client.principal);
    const deviceId = requireDeviceId(payload, this.deviceStore);
    const record = requirePtySession(this.ptySessions, deviceId, readRequiredSessionId(payload));
    ensureRecordingScope(client.principal, record.recordingEnabled);
    ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
    const rateLimit = consumeRateLimit(this.resizeRateLimits, record.sessionId, 20, 10, Date.now());
    if (!rateLimit.allowed) {
      throw new PtyGatewayError('PTY_RATE_LIMITED', 'PTY resize rate limited', {
        rate_limited: true,
        retryAfterMs: rateLimit.retryAfterMs,
      });
    }
    const cols = readPositiveInt(payload.cols, 'cols');
    const rows = readPositiveInt(payload.rows, 'rows');
    const result = this.agentGateway.resizePty(deviceId, {
      sessionId: record.sessionId,
      cols,
      rows,
    });
    if (result.ok) {
      this.ptySessions.updateSize(record.sessionId, cols, rows);
    }
    if (!result.ok) {
      throw new PtyGatewayError(result.reason ?? 'PTY_INVALID_SIZE', 'Failed to resize PTY');
    }
  }

  private handleClose(client: any, payload: Record<string, unknown>) {
    const actor = mapPrincipalToPtyActor(client.principal);
    const deviceId = requireDeviceId(payload, this.deviceStore);
    const record = requirePtySession(this.ptySessions, deviceId, readRequiredSessionId(payload));
    ensureRecordingScope(client.principal, record.recordingEnabled);
    ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
    const result = this.agentGateway.closePty(deviceId, {
      sessionId: record.sessionId,
    });
    if (!result.ok) {
      throw new PtyGatewayError(result.reason ?? 'PTY_INTERNAL_ERROR', 'Failed to close PTY');
    }
    this.appendAudit(record, 'pty_close_requested', actor, 'PTY close requested');
  }
}


type RateLimitBucket = {
  tokens: number;
  lastRefillAt: number;
};

function consumeRateLimit(
  buckets: Map<string, RateLimitBucket>,
  key: string,
  burst: number,
  refillPerSecond: number,
  now: number,
): { allowed: boolean; retryAfterMs: number } {
  const bucket = buckets.get(key) ?? { tokens: burst, lastRefillAt: now };
  const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
  const refilledTokens = (elapsedMs / 1000) * refillPerSecond;
  bucket.tokens = Math.min(burst, bucket.tokens + refilledTokens);
  bucket.lastRefillAt = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return { allowed: true, retryAfterMs: 0 };
  }
  buckets.set(key, bucket);
  const missingTokens = 1 - bucket.tokens;
  return {
    allowed: false,
    retryAfterMs: Math.max(1, Math.ceil((missingTokens / refillPerSecond) * 1000)),
  };
}

class PtyGatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}


function sanitizePtyInput(value: string): { data: string; filtered: boolean } {
  let filtered = false;
  const normalized = value.replace(/\r\n/g, '\n');
  let output = '';
  for (const char of normalized) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x1b) {
      filtered = true;
      continue;
    }
    if (code === 0x03 || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x7f) {
      output += char;
      continue;
    }
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x80 && code <= 0x9f)) {
      filtered = true;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      output += '\uFFFD';
      filtered = true;
      continue;
    }
    output += char;
  }
  return { data: output, filtered };
}


function ensureRecordingScope(principal: AdminAuthPrincipal, recordingEnabled: boolean) {
  if (!recordingEnabled || principal.kind === 'session' || principal.kind === 'env-token') {
    return;
  }
  if (!principal.scopes.includes('device:record')) {
    throw new ForbiddenException('Missing device:record scope');
  }
}

function ensureRecordingConsent(record: PtySessionRecord) {
  if (!record.recordingEnabled || record.recordingConsentAt) {
    return;
  }
  throw new PtyGatewayError(
    'PTY_RECORDING_CONSENT_REQUIRED',
    'Acknowledge recording before sending PTY input',
    { consentRequired: true },
  );
}

function authenticatePtyPrincipal(
  authHeader: string | undefined,
  cookieHeader: string | undefined,
  sessions: AdminSessionService,
  apiTokens: AdminApiTokenService,
): AdminAuthPrincipal {
  const tokenPrincipal = authenticateAdminApiToken(authHeader, apiTokens);
  if (tokenPrincipal) {
    if (tokenPrincipal.kind === 'db-token' && !tokenPrincipal.scopes.includes('device:control')) {
      throw new ForbiddenException('Missing device:control scope');
    }
    return tokenPrincipal;
  }

  const cookies = parseCookies(cookieHeader);
  if (!sessions.isValid(cookies.cc_admin_session)) {
    throw new UnauthorizedException('Browser admin session required');
  }
  return { kind: 'session', scopes: null };
}

function mapPrincipalToPtyActor(principal: AdminAuthPrincipal): { actorType: string; actorId: string | null } {
  switch (principal.kind) {
    case 'db-token':
      return { actorType: 'admin_api_token', actorId: principal.tokenId };
    case 'env-token':
      return { actorType: 'admin_env_token', actorId: 'CC_ADMIN_API_TOKEN' };
    case 'session':
    default:
      return { actorType: 'admin_session', actorId: null };
  }
}

function requireDeviceId(payload: Record<string, unknown>, deviceStore: DeviceStore): string {
  const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId.trim() : '';
  if (!deviceId || !deviceStore.getDevice(deviceId)) {
    throw new PtyGatewayError('DEVICE_NOT_FOUND', 'Device not found');
  }
  return deviceId;
}

function readSessionId(payload: Record<string, unknown>): string {
  return typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
}

function readRequiredSessionId(payload: Record<string, unknown>): string {
  const sessionId = readSessionId(payload);
  if (!sessionId) {
    throw new PtyGatewayError('SESSION_ID_REQUIRED', 'sessionId is required');
  }
  return sessionId;
}

function readPositiveInt(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new PtyGatewayError('PTY_INVALID_SIZE', `${field} must be a positive integer`);
  }
  return normalized;
}

function requirePtySession(store: PtySessionStore, deviceId: string, sessionId: string): PtySessionRecord {
  const record = store.get(sessionId);
  if (!record || record.deviceId !== deviceId) {
    throw new PtyGatewayError('PTY_NOT_FOUND', 'PTY session not found for this device');
  }
  return record;
}

function ensureActorMayAttach(record: PtySessionRecord, actorType: string, actorId: string | null) {
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

function ensureActorOwnsAttachment(record: PtySessionRecord, actorType: string, actorId: string | null) {
  if (isSameActor(record, actorType, actorId)) {
    return;
  }
  throw new PtyGatewayError('PTY_UNAUTHORIZED', 'PTY session is not attached to the current operator');
}

function isSameActor(record: PtySessionRecord, actorType: string, actorId: string | null) {
  return record.attachedActorType === actorType && record.attachedActorId === actorId;
}


function shouldAuditReject(msgType: string) {
  return ['pty_open', 'pty_attach', 'pty_detach', 'pty_close'].includes(msgType);
}

function auditRejectedAction(
  audit: PtyAuditStore,
  sessionStore: PtySessionStore,
  msgType: string,
  payload: Record<string, unknown>,
  deviceStore: DeviceStore,
  principal: AdminAuthPrincipal,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  const actor = mapPrincipalToPtyActor(principal);
  const deviceId = typeof payload.deviceId === 'string' && deviceStore.getDevice(payload.deviceId.trim()) ? payload.deviceId.trim() : 'unknown';
  const requestedSessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  const record = requestedSessionId ? sessionStore.get(requestedSessionId) : null;
  if (!record) {
    return;
  }
  audit.append({
    id: uuidv4(),
    sessionId: record.sessionId,
    deviceId: record.deviceId || deviceId,
    ts: new Date().toISOString(),
    eventType: msgType === 'pty_attach' ? 'pty_attach_rejected' : 'pty_rejected',
    actorType: actor.actorType as any,
    actorId: actor.actorId,
    summary: `${msgType} rejected: ${message}`,
    details: { code, ...(details ?? {}) },
  });
}

function errorMessage(type: string, code: string, message: string, details?: Record<string, unknown>) {
  return {
    type,
    payload: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}
