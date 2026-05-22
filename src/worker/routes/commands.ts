import type { WorkerEnv } from '../types';
import { D1DeviceStore } from '../db/d1-device-store';
import { D1CommandStore } from '../db/d1-command-store';
import { D1LogStore } from '../db/d1-log-store';
import { D1PtyAuditStore, D1PtySessionStore } from '../db/d1-pty-store';
import { nowMs, makeUuid } from '../env-helpers';
import { jsonResponse, clampNumber, parseJsonBody, sseFrame, sseStreamResponse, streamPollMs } from '../http';
import {
  requireAdminAuth,
  requireAdmin,
  requireAdminAndDevice,
  requireCsrfForCookieMutation,
  adminActorType,
  adminActorId,
  getBearerToken,
} from '../auth';
import { publicCommand, notifyAgentDurableObject } from '../agent-transport';
import { ccPtySessionId, newServerSshStartSessionId } from '../../legacy/pty/ccPtySessionId';

export async function handleListCommands(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdmin(request, env);
  if (required instanceof Response) return required;
  const commands = await new D1CommandStore(required.db).listCommands({
    deviceId: url.searchParams.get('deviceId')?.trim() || undefined,
    state: url.searchParams.get('state')?.trim() || undefined,
    commandType: url.searchParams.get('commandType')?.trim() || undefined,
    actorType: url.searchParams.get('actorType')?.trim() || undefined,
    limit: clampNumber(url.searchParams.get('limit'), 100, 1, 500),
  });
  return jsonResponse({ items: commands });
}

export async function handleGetCommand(request: Request, env: WorkerEnv, commandId: string): Promise<Response> {
  const required = await requireAdmin(request, env);
  if (required instanceof Response) return required;
  const command = await new D1CommandStore(required.db).getCommand(commandId);
  if (!command) return jsonResponse({ error: 'Command not found' }, { status: 404 });
  return jsonResponse(command);
}

export async function handleListCommandAudit(request: Request, env: WorkerEnv, commandId: string): Promise<Response> {
  const required = await requireAdmin(request, env);
  if (required instanceof Response) return required;
  const store = new D1CommandStore(required.db);
  const command = await store.getCommand(commandId);
  if (!command) return jsonResponse({ error: 'Command not found' }, { status: 404 });
  return jsonResponse({ items: await store.listAudit(commandId) });
}

export async function handleCommandsStream(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'), ['device:read']);
  if (required instanceof Response) return required;
  const store = new D1CommandStore(required.db);
  const limit = clampNumber(url.searchParams.get('limit'), 100, 1, 500);
  const commands = await store.listCommands({ deviceId: required.deviceId, limit });
  let seen = new Map(commands.map((command) => [command.commandId, JSON.stringify(command)]));
  return sseStreamResponse([], {
    intervalMs: streamPollMs(env),
    next: async () => {
      const current = await store.listCommands({ deviceId: required.deviceId, limit });
      const nextSeen = new Map<string, string>();
      const changed = current.filter((command) => {
        const serialized = JSON.stringify(command);
        nextSeen.set(command.commandId, serialized);
        if (seen.get(command.commandId) === serialized) return false;
        return true;
      });
      seen = nextSeen;
      return changed.reverse().map((command) => sseFrame('command', command));
    },
  });
}

export async function dispatchGenericAgentCommand(request: Request, env: WorkerEnv, deviceId: string, commandType: string): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:control']);
  if (auth instanceof Response) return auth;
  const body = await parseJsonBody(request);
  const csrfFailure = requireCsrfForCookieMutation(request, env, body);
  if (csrfFailure) return csrfFailure;
  const device = await new D1DeviceStore(auth.db).getDevice(deviceId);
  if (!device) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  const payload = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== 'commandId' && key !== 'csrfToken'),
  );
  if (
    ['start_server_tunnel', 'restart_server_tunnel'].includes(commandType)
    && (typeof payload.serverId !== 'string' || !payload.serverId.trim())
  ) {
    return jsonResponse({ error: 'serverId is required' }, { status: 400 });
  }
  const commandId = typeof body.commandId === 'string' && body.commandId.trim() ? body.commandId.trim() : makeUuid(env);
  const now = new Date(nowMs(env)).toISOString();
  const commands = new D1CommandStore(auth.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(env), commandId, deviceId, commandType,
    actorType: getBearerToken(request) ? 'admin_env_token' : 'admin_session',
    actorId: getBearerToken(request) ? 'CC_ADMIN_API_TOKEN' : null,
    payload: Object.keys(payload).length ? payload : null,
    payloadSummary: `Request ${commandType}`, submittedAt: now,
  });
  await commands.appendAudit({
    id: makeUuid(env), commandId, ts: now, eventType: 'created',
    actorType: command.actorType, actorId: command.actorId, source: 'worker',
    summary: `Created ${commandType}`, details: { commandType },
  });
  const dispatchedAt = new Date(nowMs(env)).toISOString();
  const reqSeq = await commands.nextReqSeq(deviceId);
  command = await commands.markDispatched(commandId, reqSeq, dispatchedAt);
  await commands.appendAudit({
    id: makeUuid(env), commandId, ts: now, eventType: 'dispatched',
    actorType: command.actorType, actorId: command.actorId, source: 'worker',
    summary: `Dispatched ${commandType} to ${deviceId} (durable-object/websocket delivery with polling fallback)`,
    details: { reqSeq },
  });
  await notifyAgentDurableObject(env, deviceId, publicCommand(command), dispatchedAt);
  return jsonResponse({ ok: true, deviceId, reqSeq, requestedAt: dispatchedAt, command });
}

export async function handleStartServerSshCommand(request: Request, env: WorkerEnv, deviceId: string): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:control']);
  if (auth instanceof Response) return auth;
  const body = await parseJsonBody(request);
  const csrfFailure = requireCsrfForCookieMutation(request, env, body);
  if (csrfFailure) return csrfFailure;
  const device = await new D1DeviceStore(auth.db).getDevice(deviceId);
  if (!device) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  const serverId = typeof body.serverId === 'string' ? body.serverId.trim() : '';
  if (!serverId) return jsonResponse({ error: 'serverId is required' }, { status: 400 });
  const sessionId = newServerSshStartSessionId(deviceId);
  const cols = Math.min(Math.max(Number(body.cols) || 120, 20), 300);
  const rows = Math.min(Math.max(Number(body.rows) || 32, 5), 120);
  const now = new Date(nowMs(env)).toISOString();
  const actorType = adminActorType(auth.principal);
  const actorId = adminActorId(auth.principal);
  const ptySessions = new D1PtySessionStore(auth.db);
  await ptySessions.expireOpeningSessions(now, deviceId);
  const activeSession = await ptySessions.findActiveServerSshSession(deviceId, serverId);
  if (activeSession) {
    return jsonResponse({
      ok: true, deviceId, serverId, sessionId: activeSession.sessionId,
      reqSeq: 1, requestedAt: now, agentAck: null, reused: true,
      command: await new D1CommandStore(auth.db).getCommand(activeSession.sessionId),
    });
  }
  await ptySessions.createOpening({
    id: makeUuid(env), sessionId, deviceId, kind: 'server_ssh', serverId,
    cols, rows, openedAt: now, openedByActorType: actorType, openedByActorId: actorId,
    attachedActorType: actorType, attachedActorId: actorId,
  });
  await new D1PtyAuditStore(auth.db).append({
    id: makeUuid(env), sessionId, deviceId, ts: now,
    eventType: 'pty_open_requested', actorType, actorId,
    summary: 'Admin requested server SSH PTY open', details: { serverId, cols, rows },
  });
  const commands = new D1CommandStore(auth.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(env), commandId: sessionId, deviceId, commandType: 'start_server_ssh',
    actorType, actorId, payload: { serverId, sessionId, cols, rows },
    payloadSummary: `Start server SSH ${serverId}`, submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(deviceId);
  command = await commands.markDispatched(sessionId, reqSeq, now);
  await commands.appendAudit({
    id: makeUuid(env), commandId: sessionId, ts: now, eventType: 'dispatched',
    actorType, actorId, source: 'worker',
    summary: `Dispatched start_server_ssh to ${deviceId}`,
    details: { reqSeq, serverId, sessionId, cols, rows },
  });
  await notifyAgentDurableObject(env, deviceId, publicCommand(command), now);
  return jsonResponse({
    ok: true, deviceId, serverId, sessionId, reqSeq,
    requestedAt: now, agentAck: null, command,
  });
}

export async function handleAttachServerSshCommand(request: Request, env: WorkerEnv, deviceId: string): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:control']);
  if (auth instanceof Response) return auth;
  const body = await parseJsonBody(request);
  const csrfFailure = requireCsrfForCookieMutation(request, env, body);
  if (csrfFailure) return csrfFailure;
  const device = await new D1DeviceStore(auth.db).getDevice(deviceId);
  if (!device) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  const serverId = typeof body.serverId === 'string' ? body.serverId.trim() : '';
  if (!serverId) return jsonResponse({ error: 'serverId is required' }, { status: 400 });
  const localSessionId = typeof body.localSessionId === 'string' ? body.localSessionId.trim() : '';
  if (!localSessionId) return jsonResponse({ error: 'localSessionId is required' }, { status: 400 });
  let sessionId: string;
  try { sessionId = ccPtySessionId(deviceId, localSessionId); }
  catch { return jsonResponse({ error: 'Invalid deviceId or localSessionId for ccpty session id' }, { status: 400 }); }
  const requested = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (requested && requested !== sessionId) {
    return jsonResponse({ error: 'sessionId does not match canonical ccpty id for this device and localSessionId' }, { status: 400 });
  }
  const cols = Math.min(Math.max(Number(body.cols) || 120, 20), 300);
  const rows = Math.min(Math.max(Number(body.rows) || 32, 5), 120);
  const now = new Date(nowMs(env)).toISOString();
  const runtimeSummary = await new D1LogStore(auth.db).getDeviceRuntimeSummary(deviceId);
  const sshStatus = runtimeSummary.functions?.[`server-ssh-${serverId}`];
  const observedAtMs = typeof sshStatus?.observedAt === 'string' ? Date.parse(sshStatus.observedAt) : NaN;
  const state = typeof sshStatus?.state === 'string' ? sshStatus.state.trim().toLowerCase() : '';
  const statusSessionId = typeof sshStatus?.sessionId === 'string' ? sshStatus.sessionId.trim() : '';
  if (
    !['starting', 'running'].includes(state)
    || statusSessionId !== localSessionId
    || !Number.isFinite(observedAtMs)
    || Date.parse(now) - observedAtMs > 120_000
  ) {
    return jsonResponse({
      error: 'STALE_SSH_SESSION',
      message: 'Local SSH PTY session is not confirmed active by a recent device status update',
    }, { status: 409 });
  }
  const actorType = adminActorType(auth.principal);
  const actorId = adminActorId(auth.principal);
  const ptySessions = new D1PtySessionStore(auth.db);
  await ptySessions.expireOpeningSessions(now, deviceId);
  const activeSession = await ptySessions.findActiveServerSshSession(deviceId, serverId);
  if (activeSession) {
    return jsonResponse({
      ok: true, deviceId, serverId, sessionId: activeSession.sessionId,
      reqSeq: 1, requestedAt: now, agentAck: null, reused: true,
      command: await new D1CommandStore(auth.db).getCommand(activeSession.sessionId),
    });
  }
  await ptySessions.createOpening({
    id: makeUuid(env), sessionId, deviceId, kind: 'server_ssh', serverId,
    localSessionId, cols, rows, openedAt: now,
    openedByActorType: actorType, openedByActorId: actorId,
    attachedActorType: actorType, attachedActorId: actorId,
  });
  await new D1PtyAuditStore(auth.db).append({
    id: makeUuid(env), sessionId, deviceId, ts: now,
    eventType: 'pty_attach_requested', actorType, actorId,
    summary: 'Admin requested server SSH PTY attach',
    details: { serverId, sessionId, localSessionId, cols, rows },
  });
  const commands = new D1CommandStore(auth.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(env), commandId: sessionId, deviceId,
    commandType: 'request_attach_server_ssh', actorType, actorId,
    payload: { serverId, sessionId, localSessionId, cols, rows },
    payloadSummary: `Attach server SSH ${serverId}`, submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(deviceId);
  command = await commands.markDispatched(sessionId, reqSeq, now);
  await commands.appendAudit({
    id: makeUuid(env), commandId: sessionId, ts: now, eventType: 'dispatched',
    actorType, actorId, source: 'worker',
    summary: `Dispatched request_attach_server_ssh to ${deviceId}`,
    details: { reqSeq, serverId, sessionId, localSessionId, cols, rows },
  });
  await notifyAgentDurableObject(env, deviceId, publicCommand(command), now);
  return jsonResponse({
    ok: true, deviceId, serverId, sessionId, reqSeq,
    requestedAt: now, agentAck: null, command,
  });
}
