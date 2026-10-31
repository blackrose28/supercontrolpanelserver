import { randomUUID } from 'node:crypto';
import { PtyAuditStore } from './pty-audit.store';
import { PtySessionStore } from './pty-session.store';

export class PtyGatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function shouldAuditReject(msgType: string) {
  return ['pty_open', 'pty_attach', 'pty_detach', 'pty_close'].includes(msgType);
}

export function auditRejectedAction(
  audit: PtyAuditStore,
  sessionStore: PtySessionStore,
  msgType: string,
  payload: Record<string, unknown>,
  actor: { actorType: string; actorId: string | null },
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  const requestedSessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  const record = requestedSessionId ? sessionStore.get(requestedSessionId) : null;
  if (!record) {
    return;
  }
  audit.append({
    id: randomUUID(),
    sessionId: record.sessionId,
    deviceId: record.deviceId,
    ts: new Date().toISOString(),
    eventType: msgType === 'pty_attach' ? 'pty_attach_rejected' : 'pty_rejected',
    actorType: actor.actorType as any,
    actorId: actor.actorId,
    summary: `${msgType} rejected: ${message}`,
    details: { code, ...(details ?? {}) },
  });
}

export function errorMessage(type: string, code: string, message: string, details?: Record<string, unknown>) {
  return {
    type,
    payload: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}
