import { randomUUID } from 'node:crypto';
import { AgentGateway } from '../agent/agent.gateway';
import { DeviceStore } from '../devices/device.store';
import { PtyGatewayError } from './pty-gateway.errors';
import { mapPrincipalToPtyActor } from './pty-auth.service';
import { sanitizePtyInput } from './pty-input-sanitizer';
import {
  ensureActorMayAttach,
  ensureActorOwnsAttachment,
  ensureRecordingConsent,
  ensureRecordingScope,
  readPositiveInt,
  readRequiredSessionId,
  readSessionId,
  requireDeviceId,
  requirePtySession,
} from './pty-policy.service';
import { PtyHubService } from './pty-hub.service';
import { PtySessionRecord, PtySessionStore } from './pty-session.store';
import { consumeRateLimit, RateLimitBucket } from './pty-rate-limit';
import { PtyAuditStore } from './pty-audit.store';
import { newServerSshStartSessionId } from './ccPtySessionId';

export type PtyHandlerDeps = {
  deviceStore: DeviceStore;
  agentGateway: AgentGateway;
  ptySessions: PtySessionStore;
  ptyHub: PtyHubService;
  ptyAudit: PtyAuditStore;
  writeRateLimits: Map<string, RateLimitBucket>;
  resizeRateLimits: Map<string, RateLimitBucket>;
  appendAudit: (
    record: Pick<PtySessionRecord, 'sessionId' | 'deviceId'>,
    eventType: string,
    actor: { actorType: string; actorId: string | null },
    summary: string,
    details?: Record<string, unknown>,
  ) => void;
  auditExpiredSessions: (records: PtySessionRecord[]) => void;
};

export function handleOpenAction(client: any, payload: Record<string, unknown>, deps: PtyHandlerDeps) {
  const actor = mapPrincipalToPtyActor(client.principal);
  const deviceId = requireDeviceId(payload, deps.deviceStore);
  deps.auditExpiredSessions(deps.ptySessions.expireDetachedSessions(new Date().toISOString()));
  const sessionId = readSessionId(payload) || newServerSshStartSessionId(deviceId);
  const cols = readPositiveInt(payload.cols, 'cols');
  const rows = readPositiveInt(payload.rows, 'rows');
  deps.ptyHub.clearScrollback(sessionId);
  ensureRecordingScope(client.principal, Boolean(payload.recording));
  const result = deps.agentGateway.openPty(deviceId, {
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
  deps.appendAudit(
    deps.ptySessions.get(sessionId) ?? ({ sessionId, deviceId } as any),
    'pty_open_requested',
    actor,
    'PTY open requested',
    { recordingEnabled: Boolean(payload.recording), cols, rows },
  );
  deps.ptyHub.attachClient(client, sessionId);
  deps.ptyHub.replayToClient(client, sessionId);
  deps.ptyHub.send(client, {
    type: 'pty_opened',
    payload: {
      sessionId,
      state: 'opening',
      deviceId,
    },
  });
}

export function handleAttachAction(client: any, payload: Record<string, unknown>, deps: PtyHandlerDeps) {
  const actor = mapPrincipalToPtyActor(client.principal);
  const deviceId = requireDeviceId(payload, deps.deviceStore);
  deps.auditExpiredSessions(deps.ptySessions.expireDetachedSessions(new Date().toISOString()));
  const requestedSessionId = readRequiredSessionId(payload);
  console.log(
    `[PTY-TRACE] admin-ws: pty_attach deviceId=${deviceId} requestedSessionId=${requestedSessionId}`,
  );
  const record = requirePtySession(deps.ptySessions, deviceId, requestedSessionId);
  ensureRecordingScope(client.principal, record.recordingEnabled);
  ensureActorMayAttach(record, actor.actorType, actor.actorId);
  const updated = deps.ptySessions.attach(record.sessionId, actor.actorType, actor.actorId, new Date().toISOString());
  deps.ptyHub.attachClient(client, updated.sessionId);
  console.log(
    `[PTY-TRACE] admin-ws: client subscribed sessionId=${updated.sessionId}`,
  );
  deps.ptyHub.replayToClient(client, updated.sessionId);
  deps.ptyHub.send(client, {
    type: 'pty_opened',
    payload: {
      sessionId: updated.sessionId,
      state: updated.state,
      deviceId,
    },
  });
  deps.appendAudit(updated, 'pty_attach_succeeded', actor, 'PTY session attached');
}

export function handleDetachAction(client: any, payload: Record<string, unknown>, deps: PtyHandlerDeps) {
  const actor = mapPrincipalToPtyActor(client.principal);
  const record = requirePtySession(
    deps.ptySessions,
    requireDeviceId(payload, deps.deviceStore),
    readRequiredSessionId(payload),
  );
  ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
  const updated = deps.ptySessions.detach(record.sessionId, new Date().toISOString());
  deps.ptyHub.detachClient(client, record.sessionId);
  deps.appendAudit(updated, 'pty_detached', actor, 'PTY session detached');
  deps.ptyHub.send(client, {
    type: 'pty_state',
    payload: {
      sessionId: updated.sessionId,
      state: updated.state,
      detached: true,
    },
  });
}

export function handleRecordingConsentAction(client: any, payload: Record<string, unknown>, deps: PtyHandlerDeps) {
  const actor = mapPrincipalToPtyActor(client.principal);
  const deviceId = requireDeviceId(payload, deps.deviceStore);
  const record = requirePtySession(deps.ptySessions, deviceId, readRequiredSessionId(payload));
  ensureRecordingScope(client.principal, record.recordingEnabled);
  ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
  if (!record.recordingEnabled) {
    throw new PtyGatewayError('PTY_RECORDING_NOT_ENABLED', 'PTY session is not recording-enabled');
  }
  const ts = new Date().toISOString();
  const updated = deps.ptySessions.markRecordingConsent(record.sessionId, ts);
  deps.ptyAudit.append({
    id: randomUUID(),
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
  deps.ptyHub.send(client, {
    type: 'pty_state',
    payload: {
      sessionId: updated.sessionId,
      recordingEnabled: true,
      recordingConsentAt: updated.recordingConsentAt,
      consentGranted: true,
    },
  });
}

export function handleWriteAction(client: any, payload: Record<string, unknown>, deps: PtyHandlerDeps) {
  const actor = mapPrincipalToPtyActor(client.principal);
  const deviceId = requireDeviceId(payload, deps.deviceStore);
  const record = requirePtySession(deps.ptySessions, deviceId, readRequiredSessionId(payload));
  ensureRecordingScope(client.principal, record.recordingEnabled);
  ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
  ensureRecordingConsent(record);
  const rateLimit = consumeRateLimit(deps.writeRateLimits, record.sessionId, 200, 100, Date.now());
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
    deps.ptyHub.send(client, {
      type: 'pty_state',
      payload: {
        sessionId: record.sessionId,
        warning: 'PTY input was sanitized before sending to the agent.',
      },
    });
  }
  const result = deps.agentGateway.writePty(deviceId, {
    sessionId: record.sessionId,
    data: sanitized.data,
  });
  if (!result.ok) {
    throw new PtyGatewayError(result.reason ?? 'PTY_WRITE_REJECTED', 'Failed to write PTY');
  }
}

export function handleResizeAction(client: any, payload: Record<string, unknown>, deps: PtyHandlerDeps) {
  const actor = mapPrincipalToPtyActor(client.principal);
  const deviceId = requireDeviceId(payload, deps.deviceStore);
  const record = requirePtySession(deps.ptySessions, deviceId, readRequiredSessionId(payload));
  ensureRecordingScope(client.principal, record.recordingEnabled);
  ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
  const rateLimit = consumeRateLimit(deps.resizeRateLimits, record.sessionId, 20, 10, Date.now());
  if (!rateLimit.allowed) {
    throw new PtyGatewayError('PTY_RATE_LIMITED', 'PTY resize rate limited', {
      rate_limited: true,
      retryAfterMs: rateLimit.retryAfterMs,
    });
  }
  const cols = readPositiveInt(payload.cols, 'cols');
  const rows = readPositiveInt(payload.rows, 'rows');
  const result = deps.agentGateway.resizePty(deviceId, {
    sessionId: record.sessionId,
    cols,
    rows,
  });
  if (result.ok) {
    deps.ptySessions.updateSize(record.sessionId, cols, rows);
  }
  if (!result.ok) {
    throw new PtyGatewayError(result.reason ?? 'PTY_INVALID_SIZE', 'Failed to resize PTY');
  }
}

export function handleCloseAction(client: any, payload: Record<string, unknown>, deps: PtyHandlerDeps) {
  const actor = mapPrincipalToPtyActor(client.principal);
  const deviceId = requireDeviceId(payload, deps.deviceStore);
  const record = requirePtySession(deps.ptySessions, deviceId, readRequiredSessionId(payload));
  ensureRecordingScope(client.principal, record.recordingEnabled);
  ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
  const result = deps.agentGateway.closePty(deviceId, {
    sessionId: record.sessionId,
  });
  if (!result.ok) {
    throw new PtyGatewayError(result.reason ?? 'PTY_INTERNAL_ERROR', 'Failed to close PTY');
  }
  deps.appendAudit(record, 'pty_close_requested', actor, 'PTY close requested');
}
