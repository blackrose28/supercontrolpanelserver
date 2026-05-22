import type { WorkerEnv } from './types';
import { D1LogStore } from './db/d1-log-store';
import { D1CommandStore } from './db/d1-command-store';
import { D1PtySessionStore } from './db/d1-pty-store';
import { D1FileTransferStore } from './db/d1-file-op-store';
import { D1DeviceStore } from './db/d1-device-store';
import { nowMs, makeUuid } from './env-helpers';
import { coalesceFunctionStatusSessionId } from '../legacy/logs/functionStatusSessionId';
import { relayPtyToAdminSubscribers } from './admin-pty-routes';

export async function appendAgentTelemetry(db: any, env: WorkerEnv, deviceId: string, envelope: Record<string, any>, overrides: Partial<{ type: string; sessionId: string | null; functionId: string | null; seq: number; ts: string; payload: unknown }> = {}) {
  const payload = overrides.payload !== undefined ? overrides.payload : envelope.payload ?? null;
  await new D1LogStore(db).append({
    id: makeUuid(env),
    deviceId,
    type: overrides.type ?? String(envelope.type || 'unknown'),
    sessionId: overrides.sessionId !== undefined ? overrides.sessionId : null,
    functionId: overrides.functionId !== undefined ? overrides.functionId : null,
    seq: overrides.seq ?? (typeof envelope.seq === 'number' ? envelope.seq : nowMs(env)),
    ts: overrides.ts ?? (typeof envelope.ts === 'string' && envelope.ts.trim() ? envelope.ts : new Date(nowMs(env)).toISOString()),
    payload,
  });
}

export async function handleAgentRunObservation(db: any, env: WorkerEnv, deviceId: string, payload: Record<string, unknown>, ts: string): Promise<void> {
  const agentRunId = typeof payload.agentRunId === 'string' && payload.agentRunId.trim() ? payload.agentRunId.trim() : '';
  if (!agentRunId) return;
  const result = await new D1LogStore(db).noteAgentRun(deviceId, agentRunId, ts);
  if (!result.changed) return;
  const expired = await new D1PtySessionStore(db).expireDeviceSessions(
    deviceId,
    ts,
    'AGENT_RESTARTED',
    'Agent process restarted; previous in-memory PTY sessions were discarded',
  );
  for (const session of expired) {
    await relayPtyToAdminSubscribers(env, session.sessionId, 'pty_error', {
      sessionId: session.sessionId,
      deviceId,
      code: 'AGENT_RESTARTED',
      message: 'Agent restarted; PTY session no longer exists',
    });
  }
  console.warn('Agent run changed; expired volatile sessions', {
    deviceId,
    previousAgentRunId: result.previousAgentRunId,
    agentRunId,
    expiredPtySessions: expired.length,
  });
}

export function sendAgentAck(socket: { send?: (message: string) => void }, reqSeq: unknown) {
  if (typeof reqSeq !== 'number') return;
  socket.send?.(JSON.stringify({ type: 'ack', reqSeq, payload: { status: 'ok' } }));
}

export async function updateCommandFromAgentResponse(db: any, env: WorkerEnv, deviceId: string, envelope: Record<string, any>, type: 'ack' | 'nack') {
  const reqSeq = typeof envelope.reqSeq === 'number' ? envelope.reqSeq : null;
  if (reqSeq == null) return;
  const commands = new D1CommandStore(db);
  const command = await commands.findByReqSeq(deviceId, reqSeq);
  if (!command) return;
  const ts = typeof envelope.ts === 'string' && envelope.ts.trim() ? envelope.ts : new Date(nowMs(env)).toISOString();
  if (type === 'ack') {
    const updated = await commands.markExecuting(command.commandId, ts);
    await markPtySessionOpenForAgentAck(db, env, deviceId, updated, envelope.payload, ts);
    if (updated.commandType === 'request_pty_scrollback') {
      await commands.markSucceeded(command.commandId, null, ts);
    }
    await commands.appendAuditIfMissing({
      id: makeUuid(env),
      commandId: command.commandId,
      ts,
      eventType: 'acknowledged',
      actorType: updated.actorType,
      actorId: updated.actorId,
      source: 'agent',
      summary: `Agent acknowledged reqSeq ${reqSeq}`,
      details: { reqSeq, payload: envelope.payload ?? null },
    });
    return;
  }
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : {};
  const reasonCode = typeof payload.error === 'string' && payload.error.trim() ? payload.error.trim() : 'AGENT_NACK';
  const reasonDetail = typeof payload.detail === 'string' ? payload.detail : reasonCode;
  const updated = await commands.markFailed(command.commandId, reasonCode, reasonDetail, ts);
  await failPtySessionForMissingAgentPty(db, env, deviceId, command, reasonCode, reasonDetail, ts);
  await commands.appendAuditIfMissing({
    id: makeUuid(env),
    commandId: command.commandId,
    ts,
    eventType: 'failed',
    actorType: updated.actorType,
    actorId: updated.actorId,
    source: 'agent',
    summary: `Agent rejected reqSeq ${reqSeq}: ${reasonCode}`,
    details: { reqSeq, payload: envelope.payload ?? null },
  });
}

export async function markPtySessionOpenForAgentAck(
  db: any,
  env: WorkerEnv,
  deviceId: string,
  command: { commandId: string; commandType: string; payload?: unknown },
  ackPayload: unknown,
  ts: string,
): Promise<void> {
  if (!['open_pty', 'start_server_ssh', 'request_attach_server_ssh'].includes(command.commandType)) {
    return;
  }
  const commandPayload = command.payload && typeof command.payload === 'object' ? command.payload as Record<string, unknown> : {};
  const payload = ackPayload && typeof ackPayload === 'object' ? ackPayload as Record<string, unknown> : {};
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
    ? payload.sessionId.trim()
    : (typeof commandPayload.sessionId === 'string' && commandPayload.sessionId.trim() ? commandPayload.sessionId.trim() : command.commandId);
  const localSessionId = typeof payload.localSessionId === 'string' && payload.localSessionId.trim()
    ? payload.localSessionId.trim()
    : (typeof commandPayload.localSessionId === 'string' && commandPayload.localSessionId.trim() ? commandPayload.localSessionId.trim() : null);
  const sessions = new D1PtySessionStore(db);
  const session = await sessions.get(sessionId);
  if (session && session.deviceId === deviceId && session.state === 'opening') {
    await sessions.markOpen(sessionId, ts, localSessionId);
    await relayPtyToAdminSubscribers(env, sessionId, 'pty_opened', {
      sessionId,
      deviceId,
      state: 'open',
      localSessionId,
    });
  }
}

export async function failPtySessionForMissingAgentPty(
  db: any,
  env: WorkerEnv,
  deviceId: string,
  command: { commandId: string; commandType: string; payload?: unknown },
  reasonCode: string | null,
  reasonDetail: string | null,
  ts: string,
): Promise<void> {
  if (
    !['write_pty', 'resize_pty', 'close_pty', 'open_pty', 'start_server_ssh', 'request_attach_server_ssh'].includes(command.commandType)
    || !['PTY_NOT_FOUND', 'PTY_SESSION_NOT_FOUND'].includes(reasonCode ?? '')
  ) {
    return;
  }
  const commandPayload = command.payload && typeof command.payload === 'object' ? command.payload as Record<string, unknown> : {};
  const sessionId = typeof commandPayload.sessionId === 'string' && commandPayload.sessionId.trim()
    ? commandPayload.sessionId.trim()
    : command.commandId;
  const sessions = new D1PtySessionStore(db);
  const session = await sessions.get(sessionId);
  if (session && ['opening', 'open', 'closing'].includes(session.state)) {
    await sessions.markOpenFailed(sessionId, reasonCode ?? 'PTY_NOT_FOUND', reasonDetail, ts);
    await relayPtyToAdminSubscribers(env, sessionId, 'pty_error', {
      sessionId,
      deviceId,
      code: reasonCode ?? 'PTY_NOT_FOUND',
      message: reasonDetail || 'PTY session not found',
    });
  }
}

export async function updateCommandFromAgentStatus(db: any, env: WorkerEnv, deviceId: string, envelope: Record<string, any>) {
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : {};
  const commandId =
    typeof envelope.commandId === 'string' && envelope.commandId.trim()
      ? envelope.commandId.trim()
      : (typeof payload.commandId === 'string' && payload.commandId.trim() ? payload.commandId.trim() : '');
  if (!commandId) return;

  const commands = new D1CommandStore(db);
  const command = await commands.getCommand(commandId);
  if (!command || command.deviceId !== deviceId) return;

  const state = typeof payload.state === 'string' ? payload.state.trim() : '';
  const outcome = typeof payload.outcome === 'string' && payload.outcome.trim() ? payload.outcome.trim() : null;
  const reasonCode = typeof payload.reasonCode === 'string' && payload.reasonCode.trim() ? payload.reasonCode.trim() : null;
  const reasonDetail = typeof payload.reasonDetail === 'string' && payload.reasonDetail.trim() ? payload.reasonDetail.trim() : null;
  const ts = typeof envelope.ts === 'string' && envelope.ts.trim() ? envelope.ts : new Date(nowMs(env)).toISOString();

  if (state === 'acknowledged') {
    if (!(await commands.hasAuditEvent(commandId, ['acknowledged', 'executing', 'succeeded', 'failed', 'canceled'], 'agent'))) {
      await commands.appendAuditIfMissing({
        id: makeUuid(env),
        commandId,
        ts,
        eventType: 'acknowledged',
        actorType: command.actorType,
        actorId: command.actorId,
        source: 'agent',
        summary: `Agent acknowledged ${command.commandType}`,
        details: payload,
      });
    }
    return;
  }

  if (state === 'executing') {
    const updated = await commands.markExecuting(commandId, ts);
    await commands.appendAuditIfMissing({
      id: makeUuid(env),
      commandId,
      ts,
      eventType: 'executing',
      actorType: updated.actorType,
      actorId: updated.actorId,
      source: 'agent',
      summary: `Agent started ${updated.commandType}`,
      details: payload,
    });
    return;
  }

  if (state === 'succeeded') {
    const updated = await commands.markSucceeded(commandId, outcome, ts);
    await commands.appendAuditIfMissing({
      id: makeUuid(env),
      commandId,
      ts,
      eventType: 'succeeded',
      actorType: updated.actorType,
      actorId: updated.actorId,
      source: 'agent',
      summary: `Agent completed ${updated.commandType}`,
      details: payload,
    });
    return;
  }

  if (state === 'failed') {
    const updated = await commands.markFailed(commandId, reasonCode ?? 'COMMAND_FAILED', reasonDetail, ts);
    await failPtySessionForMissingAgentPty(db, env, deviceId, updated, reasonCode, reasonDetail, ts);
    await commands.appendAuditIfMissing({
      id: makeUuid(env),
      commandId,
      ts,
      eventType: 'failed',
      actorType: updated.actorType,
      actorId: updated.actorId,
      source: 'agent',
      summary: `Agent failed ${updated.commandType}`,
      details: payload,
    });
  }
}

export async function handleAgentSocketMessage(db: any, env: WorkerEnv, deviceId: string, socket: { send?: (message: string) => void }, data: unknown) {
  let envelope: Record<string, any>;
  try {
    envelope = JSON.parse(String(data || '{}'));
  } catch {
    return;
  }
  const type = typeof envelope.type === 'string' ? envelope.type : '';
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : {};
  const devices = new D1DeviceStore(db);

  if (type === 'ack' || type === 'nack') {
    await updateCommandFromAgentResponse(db, env, deviceId, envelope, type);
    return;
  }

  if (type === 'pty-scrollback') {
    const sessionId = typeof payload.sessionId === 'string'
      ? payload.sessionId
      : (typeof envelope.sessionId === 'string' ? envelope.sessionId : '');
    const data = typeof payload.data === 'string' ? payload.data : '';
    const truncated = payload.truncated === true;
    if (sessionId) {
      await relayPtyToAdminSubscribers(env, sessionId, 'pty_output', {
        sessionId,
        deviceId,
        data,
        replay: true,
        truncated,
      });
    }
    sendAgentAck(socket, envelope.seq);
    return;
  }

  if (type === 'command_status') {
    await updateCommandFromAgentStatus(db, env, deviceId, envelope);
    sendAgentAck(socket, envelope.seq);
    return;
  }

  if (type === 'heartbeat') {
    const ts = typeof envelope.ts === 'string' ? envelope.ts : new Date(nowMs(env)).toISOString();
    await handleAgentRunObservation(db, env, deviceId, payload, ts);
    await devices.updateDeviceStatus(deviceId, 'connected', ts);
    if (typeof payload.os === 'string' && payload.os.trim()) {
      await devices.updateDeviceOs(deviceId, payload.os.trim());
    }
    sendAgentAck(socket, envelope.seq);
    return;
  }

  if (type === 'function-status') {
    const sessionId = coalesceFunctionStatusSessionId(
      typeof envelope.sessionId === 'string' ? envelope.sessionId : null,
      payload,
    );
    const functionId = typeof payload.functionId === 'string' ? payload.functionId : null;
    await appendAgentTelemetry(db, env, deviceId, envelope, { type: 'function-status', sessionId, functionId, payload: envelope.payload ?? null });
    sendAgentAck(socket, envelope.seq);
    return;
  }

  if (type === 'pty-output') {
    const sessionId = typeof envelope.sessionId === 'string'
      ? envelope.sessionId
      : (typeof payload.sessionId === 'string' ? payload.sessionId : '');
    const outputChunk = typeof envelope.data === 'string'
      ? envelope.data
      : (typeof payload.data === 'string' ? payload.data : '');
    console.log(
      `[PTY-TRACE] worker: received pty-output deviceId=${deviceId} sessionId=${sessionId || 'EMPTY'} bytes=${outputChunk.length}`,
    );
    if (sessionId) {
      const ts = typeof envelope.ts === 'string' && envelope.ts.trim() ? envelope.ts : new Date(nowMs(env)).toISOString();
      await new D1PtySessionStore(db).noteOutput(sessionId, ts);
      await appendAgentTelemetry(db, env, deviceId, envelope, { type: 'pty-output', sessionId, payload: envelope.payload ?? { data: outputChunk } });
      console.log(
        `[PTY-TRACE] worker: relaying pty_output to admin subscribers sessionId=${sessionId} bytes=${outputChunk.length}`,
      );
      await relayPtyToAdminSubscribers(env, sessionId, 'pty_output', { sessionId, deviceId, data: outputChunk });
    } else {
      console.warn(`[PTY-TRACE] worker: pty-output had no sessionId — dropping`);
    }
    sendAgentAck(socket, envelope.seq);
    return;
  }

  if (type === 'pty-exit' || type === 'pty_exit') {
    const sessionId = typeof envelope.sessionId === 'string'
      ? envelope.sessionId
      : (typeof payload.sessionId === 'string'
        ? payload.sessionId
        : (typeof payload.id === 'string' ? payload.id : ''));
    if (sessionId) {
      const ts = typeof envelope.ts === 'string' && envelope.ts.trim() ? envelope.ts : new Date(nowMs(env)).toISOString();
      const reason = typeof payload.reason === 'string'
        ? payload.reason
        : (typeof payload.reasonDetail === 'string' ? payload.reasonDetail : null);
      const sessions = new D1PtySessionStore(db);
      const existing = await sessions.get(sessionId);
      if (existing && ['opening', 'open', 'closing'].includes(existing.state)) {
        await sessions.markClosed(sessionId, ts, reason);
      }
      await appendAgentTelemetry(db, env, deviceId, envelope, { type: 'pty-exit', sessionId, payload: envelope.payload ?? null });
      await relayPtyToAdminSubscribers(env, sessionId, 'pty_exit', { sessionId, deviceId, exitCode: payload.exitCode ?? null, reason });
    }
    sendAgentAck(socket, envelope.seq);
    return;
  }

  if (type === 'transfer_progress') {
    const transferId = typeof payload.transferId === 'string' ? payload.transferId : '';
    if (transferId) {
      const ts = typeof envelope.ts === 'string' && envelope.ts.trim() ? envelope.ts : new Date(nowMs(env)).toISOString();
      await new D1FileTransferStore(db).updateProgress(transferId, ts, {
        bytesTransferred: typeof payload.bytesTransferred === 'number' ? payload.bytesTransferred : 0,
        bytesTotal: typeof payload.bytesTotal === 'number' ? payload.bytesTotal : null,
        percent: typeof payload.percent === 'number' ? payload.percent : null,
        throughputBps: typeof payload.throughputBps === 'number' ? payload.throughputBps : null,
        etaSec: typeof payload.etaSec === 'number' ? payload.etaSec : null,
        phase: typeof payload.phase === 'string' ? payload.phase : null,
        message: typeof payload.message === 'string' ? payload.message : null,
        attempt: typeof payload.attempt === 'number' ? payload.attempt : null,
        maxAttempts: typeof payload.maxAttempts === 'number' ? payload.maxAttempts : null,
        resumeSupported: typeof payload.resumeSupported === 'boolean' ? payload.resumeSupported : null,
        retryScheduled: typeof payload.retryScheduled === 'boolean' ? payload.retryScheduled : null,
        resumeToken: typeof payload.resumeToken === 'string' ? payload.resumeToken : null,
        resumeOffsetBytes: typeof payload.resumeOffsetBytes === 'number' ? payload.resumeOffsetBytes : null,
        tempPathHint: typeof payload.tempPathHint === 'string' ? payload.tempPathHint : null,
      });
      await appendAgentTelemetry(db, env, deviceId, envelope, { type: 'transfer_progress', payload: envelope.payload ?? null });
    }
    sendAgentAck(socket, envelope.seq);
    return;
  }

  if (type === 'transfer_status') {
    const transferId = typeof payload.transferId === 'string' ? payload.transferId : '';
    const state = typeof payload.state === 'string' ? payload.state : '';
    if (transferId && ['queued', 'starting', 'running', 'succeeded', 'failed', 'canceled'].includes(state)) {
      const ts = typeof envelope.ts === 'string' && envelope.ts.trim() ? envelope.ts : new Date(nowMs(env)).toISOString();
      await new D1FileTransferStore(db).markState(transferId, state as any, ts, {
        phase: typeof payload.phase === 'string' ? payload.phase : null,
        reasonCode: typeof payload.reasonCode === 'string' ? payload.reasonCode : null,
        reasonDetail: typeof payload.reasonDetail === 'string' ? payload.reasonDetail : null,
        message: typeof payload.message === 'string' ? payload.message : null,
        attempt: typeof payload.attempt === 'number' ? payload.attempt : null,
        maxAttempts: typeof payload.maxAttempts === 'number' ? payload.maxAttempts : null,
        resumeSupported: typeof payload.resumeSupported === 'boolean' ? payload.resumeSupported : null,
        retryScheduled: typeof payload.retryScheduled === 'boolean' ? payload.retryScheduled : null,
        resumeToken: typeof payload.resumeToken === 'string' ? payload.resumeToken : null,
        resumeOffsetBytes: typeof payload.resumeOffsetBytes === 'number' ? payload.resumeOffsetBytes : null,
        tempPathHint: typeof payload.tempPathHint === 'string' ? payload.tempPathHint : null,
      });
      await appendAgentTelemetry(db, env, deviceId, envelope, { type: 'transfer_status', payload: envelope.payload ?? null });
    }
    sendAgentAck(socket, envelope.seq);
    return;
  }

  if (type === 'status_snapshot' || type === 'inventory') {
    if (type === 'status_snapshot') {
      const ts = typeof envelope.ts === 'string' && envelope.ts.trim() ? envelope.ts : new Date(nowMs(env)).toISOString();
      await handleAgentRunObservation(db, env, deviceId, payload, ts);
    }
    await appendAgentTelemetry(db, env, deviceId, envelope, { type, payload: envelope.payload ?? null });
    sendAgentAck(socket, envelope.seq);
    return;
  }

  if (type === 'recent_logs') {
    await appendAgentTelemetry(db, env, deviceId, envelope, { type: 'recent_logs', payload: envelope.payload ?? null });
    const events = Array.isArray(payload.events) ? payload.events : [];
    for (const event of events) {
      const record = event && typeof event === 'object' ? event as Record<string, unknown> : {};
      await appendAgentTelemetry(db, env, deviceId, envelope, {
        type: typeof record.type === 'string' ? record.type : 'unknown',
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
        functionId: typeof record.functionId === 'string' ? record.functionId : null,
        seq: typeof record.seq === 'number' ? record.seq : undefined,
        ts: typeof record.ts === 'string' && record.ts.trim() ? record.ts : undefined,
        payload: record.payload ?? null,
      });
    }
    sendAgentAck(socket, envelope.seq);
  }
}
