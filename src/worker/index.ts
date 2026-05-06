import { D1DeviceStore } from './db/d1-device-store';
import { D1RateLimitStore, D1TotpStore } from './db/d1-rate-totp-store';
import { D1LogStore, WorkerTelemetryFilter } from './db/d1-log-store';
import { D1CommandStore } from './db/d1-command-store';
import { D1PtyAuditStore, D1PtySessionStore } from './db/d1-pty-store';
import { D1FileTransferStore, D1RemoteBrowserSessionStore } from './db/d1-file-op-store';
import { D1AdminSessionStore } from './db/d1-admin-session-store';
import { D1AdminApiTokenStore, WorkerAdminApiTokenScope } from './db/d1-admin-api-token-store';
import { D1AdminAuditStore } from './db/d1-admin-audit-store';
import { BoundedSeenIds } from './stream-dedupe';

type WorkerEnv = {
  CC_DB?: unknown;
  CC_BOOTSTRAP_TOKEN?: string;
  CC_ADMIN_API_TOKEN?: string;
  CC_ADMIN_PASSWORD?: string;
  CC_TOTP_ENCRYPTION_KEY?: string;
  CC_AGENT_DO?: DurableObjectNamespaceLike;
  now?: () => number;
  uuid?: () => string;
  sessionTokenFactory?: () => string;
  csrfTokenFactory?: () => string;
  streamPollMs?: number;
  requestSlowLogMs?: number;
};

type AdminPrincipal =
  | { kind: 'session' }
  | { kind: 'env-token' }
  | { kind: 'db-token'; tokenId: string; scopes: WorkerAdminApiTokenScope[] };

type DurableObjectNamespaceLike = {
  idFromName: (name: string) => unknown;
  get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
};

type DurableObjectStateLike = {
  acceptWebSocket?: (socket: WebSocket, tags?: string[]) => void;
  getWebSockets?: (tag?: string) => WebSocket[];
};

type WorkerExecutionContext = {
  waitUntil?: (promise: Promise<unknown>) => void;
  passThroughOnException?: () => void;
};

function applySecurityHeaders(headers: Headers): Headers {
  if (!headers.has('x-content-type-options')) headers.set('x-content-type-options', 'nosniff');
  if (!headers.has('referrer-policy')) headers.set('referrer-policy', 'no-referrer');
  if (!headers.has('permissions-policy')) headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  if (!headers.has('content-security-policy')) headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'self'; base-uri 'none'");
  return headers;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = applySecurityHeaders(new Headers(init.headers));
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}


const ADMIN_SESSION_COOKIE = 'cc_admin_session';
const ADMIN_CSRF_COOKIE = 'cc_admin_csrf';

function parseCookies(cookieHeader?: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) continue;
    result[rawKey] = decodeURIComponent(rest.join('=') || '');
  }
  return result;
}

function appendCookie(headers: Headers, name: string, value: string, options: { httpOnly?: boolean; maxAge?: number; path?: string; sameSite?: 'Strict' | 'Lax' | 'None'; secure?: boolean } = {}): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push('Secure');
  headers.append('set-cookie', parts.join('; '));
}

function redirectResponse(location: string, init: ResponseInit = {}): Response {
  const headers = applySecurityHeaders(new Headers(init.headers));
  headers.set('location', location);
  return new Response(null, { ...init, status: init.status ?? 302, headers });
}

function nowMs(env: WorkerEnv): number {
  return typeof env.now === 'function' ? env.now() : Date.now();
}

function adminSessionStore(db: any, env: WorkerEnv): D1AdminSessionStore {
  return new D1AdminSessionStore(db, { now: () => nowMs(env), tokenFactory: env.sessionTokenFactory });
}

const totpStores = new WeakMap<object, D1TotpStore>();

function totpStore(db: any, env: WorkerEnv): D1TotpStore {
  const key = db as object;
  let store = totpStores.get(key);
  if (!store) {
    store = new D1TotpStore(db, {
      now: () => nowMs(env),
      encryptionKeyMaterial: env.CC_TOTP_ENCRYPTION_KEY ?? env.CC_BOOTSTRAP_TOKEN ?? 'fallback-key',
    });
    totpStores.set(key, store);
  }
  return store;
}

function makeCsrfToken(env: WorkerEnv): string {
  return typeof env.csrfTokenFactory === 'function' ? env.csrfTokenFactory() : makeUuid(env);
}

async function parseRequestFields(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return parseJsonBody(request);
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(await request.text());
    return Object.fromEntries(form.entries());
  }
  try {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch {
    return {};
  }
}

function getClientId(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  return forwardedFor || realIp || 'unknown';
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function makeUuid(env: WorkerEnv): string {
  return typeof env.uuid === 'function' ? env.uuid() : crypto.randomUUID();
}


function getBearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
}


function hasValidStaticAdminBearer(request: Request, env: WorkerEnv): boolean {
  const token = getBearerToken(request);
  return Boolean(token && env.CC_ADMIN_API_TOKEN && token === env.CC_ADMIN_API_TOKEN);
}

function csrfTokenFromBody(body: Record<string, unknown>): string {
  return typeof body.csrfToken === 'string' ? body.csrfToken : '';
}

function requireCsrfForCookieMutation(request: Request, env: WorkerEnv, body: Record<string, unknown>): Response | null {
  if (getBearerToken(request)) return null;
  const cookies = parseCookies(request.headers.get('cookie'));
  const expected = cookies[ADMIN_CSRF_COOKIE];
  const provided = csrfTokenFromBody(body);
  if (!expected || !provided || provided !== expected) {
    return jsonResponse({ error: 'CSRF_INVALID' }, { status: 403 });
  }
  return null;
}

function hasScopes(principal: AdminPrincipal, requiredScopes: WorkerAdminApiTokenScope[]): boolean {
  if (!requiredScopes.length || principal.kind !== 'db-token') return true;
  return requiredScopes.every((scope) => principal.scopes.includes(scope));
}

async function authenticateAdmin(request: Request, env: WorkerEnv): Promise<{ db: any; principal: AdminPrincipal } | null> {
  const db = requireD1(env);
  if (db instanceof Response) return null;
  const token = getBearerToken(request);
  if (token) {
    if (env.CC_ADMIN_API_TOKEN && token === env.CC_ADMIN_API_TOKEN) {
      return { db, principal: { kind: 'env-token' } };
    }
    const record = await new D1AdminApiTokenStore(db, { now: () => nowMs(env) }).authenticateToken(token);
    if (record) {
      return { db, principal: { kind: 'db-token', tokenId: record.tokenId, scopes: record.scopes } };
    }
    return null;
  }
  const sessionToken = parseCookies(request.headers.get('cookie'))[ADMIN_SESSION_COOKIE];
  return (await adminSessionStore(db, env).isValid(sessionToken)) ? { db, principal: { kind: 'session' } } : null;
}

async function requireAdminAuth(request: Request, env: WorkerEnv, requiredScopes: WorkerAdminApiTokenScope[] = []): Promise<{ db: any; principal: AdminPrincipal } | Response> {
  const auth = await authenticateAdmin(request, env);
  if (!auth) return jsonResponse({ error: 'ADMIN_API_AUTH_FAILED' }, { status: 401 });
  if (!hasScopes(auth.principal, requiredScopes)) return jsonResponse({ error: 'ADMIN_API_SCOPE_FORBIDDEN' }, { status: 403 });
  return auth;
}

async function isAdminAuthorized(request: Request, env: WorkerEnv): Promise<boolean> {
  return Boolean(await authenticateAdmin(request, env));
}

function publicDevice(device: { id: string; name: string; lastSeenAt: string; status: string; os?: string | null }) {
  return {
    id: device.id,
    name: device.name,
    lastSeenAt: device.lastSeenAt,
    status: device.status,
    os: device.os ?? undefined,
  };
}

function publicCommand(cmd: { commandId: string; commandType: string; state: string; payloadJson?: string | null; payload?: unknown; submittedAt: string; deviceId: string; actorType: string; reqSeq?: number | null }) {
  return {
    commandId: cmd.commandId,
    commandType: cmd.commandType,
    state: cmd.state,
    payload: cmd.payload !== undefined ? cmd.payload : (cmd.payloadJson ? JSON.parse(cmd.payloadJson) : null),
    reqSeq: cmd.reqSeq ?? null,
    submittedAt: cmd.submittedAt,
    deviceId: cmd.deviceId,
    actorType: cmd.actorType,
  };
}

function requireD1(env: WorkerEnv): any | Response {
  if (!env.CC_DB || typeof (env.CC_DB as any).prepare !== 'function') {
    return jsonResponse({ error: 'D1_NOT_CONFIGURED' }, { status: 500 });
  }
  return env.CC_DB as any;
}



async function appendAgentTelemetry(db: any, env: WorkerEnv, deviceId: string, envelope: Record<string, any>, overrides: Partial<{ type: string; sessionId: string | null; functionId: string | null; seq: number; ts: string; payload: unknown }> = {}) {
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

async function handleAgentRunObservation(db: any, env: WorkerEnv, deviceId: string, payload: Record<string, unknown>, ts: string): Promise<void> {
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
    relayPtyToAdminSubscribers(env, session.sessionId, 'pty_error', {
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

function sendAgentAck(socket: { send?: (message: string) => void }, reqSeq: unknown) {
  if (typeof reqSeq !== 'number') return;
  socket.send?.(JSON.stringify({ type: 'ack', reqSeq, payload: { status: 'ok' } }));
}


async function updateCommandFromAgentResponse(db: any, env: WorkerEnv, deviceId: string, envelope: Record<string, any>, type: 'ack' | 'nack') {
  const reqSeq = typeof envelope.reqSeq === 'number' ? envelope.reqSeq : null;
  if (reqSeq == null) return;
  const commands = new D1CommandStore(db);
  const command = await commands.findByReqSeq(deviceId, reqSeq);
  if (!command) return;
  const ts = typeof envelope.ts === 'string' && envelope.ts.trim() ? envelope.ts : new Date(nowMs(env)).toISOString();
  if (type === 'ack') {
    const updated = await commands.markExecuting(command.commandId, ts);
    await markPtySessionOpenForAgentAck(db, env, deviceId, updated, envelope.payload, ts);
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

async function markPtySessionOpenForAgentAck(
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
    relayPtyToAdminSubscribers(env, sessionId, 'pty_opened', {
      sessionId,
      deviceId,
      state: 'open',
      localSessionId,
    });
  }
}

async function failPtySessionForMissingAgentPty(
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
    relayPtyToAdminSubscribers(env, sessionId, 'pty_error', {
      sessionId,
      deviceId,
      code: reasonCode ?? 'PTY_NOT_FOUND',
      message: reasonDetail || 'PTY session not found',
    });
  }
}

async function updateCommandFromAgentStatus(db: any, env: WorkerEnv, deviceId: string, envelope: Record<string, any>) {
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

async function handleAgentSocketMessage(db: any, env: WorkerEnv, deviceId: string, socket: { send?: (message: string) => void }, data: unknown) {
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
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
    const functionId = typeof payload.functionId === 'string' ? payload.functionId : null;
    await appendAgentTelemetry(db, env, deviceId, envelope, { type: 'function-status', sessionId, functionId, payload: envelope.payload ?? null });
    sendAgentAck(socket, envelope.seq);
    return;
  }

  if (type === 'pty-output') {
    const sessionId = typeof envelope.sessionId === 'string'
      ? envelope.sessionId
      : (typeof payload.sessionId === 'string' ? payload.sessionId : '');
    const data = typeof envelope.data === 'string'
      ? envelope.data
      : (typeof payload.data === 'string' ? payload.data : '');
    if (sessionId) {
      const ts = typeof envelope.ts === 'string' && envelope.ts.trim() ? envelope.ts : new Date(nowMs(env)).toISOString();
      await new D1PtySessionStore(db).noteOutput(sessionId, ts);
      await appendAgentTelemetry(db, env, deviceId, envelope, { type: 'pty-output', sessionId, payload: envelope.payload ?? { data } });
      relayPtyToAdminSubscribers(env, sessionId, 'pty_output', { sessionId, deviceId, data });
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
      relayPtyToAdminSubscribers(env, sessionId, 'pty_exit', { sessionId, deviceId, exitCode: payload.exitCode ?? null, reason });
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

// D1/Cloudflare Workers mode: agents prefer Durable Object WebSockets with
// hibernation. POST/GET polling remains as a compatibility fallback.

// Legacy command waiters - retained for compatibility with older polling code paths.
type CommandWaiter = {
  controller: ReadableStreamDefaultController;
  deviceId: string;
  resolve: (commands: any[]) => void;
  timeout: NodeJS.Timeout;
};
const commandWaiters = new Map<string, CommandWaiter>();


async function authenticateAgentRequest(request: Request, env: WorkerEnv): Promise<{ db: any; device: any } | Response> {
  const token = getBearerToken(request);
  if (!token) return jsonResponse({ error: 'AGENT_AUTH_REQUIRED' }, { status: 401 });
  const db = requireD1(env);
  if (db instanceof Response) return db;
  const device = await new D1DeviceStore(db).findDeviceByAgentToken(token);
  if (!device) return jsonResponse({ error: 'AGENT_AUTH_FAILED' }, { status: 401 });
  return { db, device };
}

function agentDurableObjectStub(env: WorkerEnv, deviceId: string): { fetch: (request: Request) => Promise<Response> } | null {
  if (!env.CC_AGENT_DO) return null;
  return env.CC_AGENT_DO.get(env.CC_AGENT_DO.idFromName(deviceId));
}

function agentEnvelopeTypeForCommand(commandType: string): string {
  switch (commandType) {
    case 'restart_openvpn':
      return 'request_restart_openvpn';
    case 'restart_boundary_auth':
      return 'request_restart_boundary_auth';
    case 'restart_server_tunnel':
      return 'request_restart_server_tunnel';
    case 'restart_server_ssh':
      return 'request_restart_server_ssh';
    case 'start_server_ssh':
      return 'request_start_server_ssh';
    case 'start_server_tunnel':
      return 'request_start_server_tunnel';
    case 'stop_server_tunnel':
      return 'request_stop_server_tunnel';
    default:
      return commandType;
  }
}

function makeCommandEnvelope(deviceId: string, command: ReturnType<typeof publicCommand>, now: string) {
  const seq = typeof command.reqSeq === 'number' && Number.isFinite(command.reqSeq) && command.reqSeq > 0
    ? command.reqSeq
    : 1;
  return {
    type: agentEnvelopeTypeForCommand(command.commandType),
    commandType: command.commandType,
    deviceId,
    seq,
    ts: now,
    commandId: command.commandId,
    payload: command.payload,
  };
}

function safeWebSocketSend(socket: WebSocket, message: string): boolean {
  try {
    socket.send(message);
    return true;
  } catch (err) {
    const reason = String(err).includes('Network connection lost')
      ? 'network_connection_lost'
      : 'send_failed';
    if (reason === 'send_failed') {
      console.warn('WebSocket send failed:', err);
    }
    try {
      socket.close(1011, reason);
    } catch {
      // Ignore close failures for already-lost sockets.
    }
    return false;
  }
}

async function notifyAgentDurableObject(env: WorkerEnv, deviceId: string, command: ReturnType<typeof publicCommand>, now: string): Promise<void> {
  const stub = agentDurableObjectStub(env, deviceId);
  if (!stub) return;
  try {
    await stub.fetch(new Request('https://cc.internal/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeCommandEnvelope(deviceId, command, now)),
    }));
  } catch (err) {
    console.error('Durable Object dispatch notification failed; polling fallback remains available:', err);
  }
}

async function handleAgentWebSocket(request: Request, env: WorkerEnv): Promise<Response> {
  // Check for agent heartbeat polling (POST)
  if (request.method === 'POST') {
    return handleAgentPolling(request, env);
  }

  // Agent WebSocket upgrade. In Workers, route live agent sockets to a per-device
  // Durable Object so hibernated sockets can be woken instantly for command dispatch.
  if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
    const auth = await authenticateAgentRequest(request, env);
    if (auth instanceof Response) return auth;
    const stub = agentDurableObjectStub(env, auth.device.id);
    if (stub) return stub.fetch(request);
    return handleAdminPtyWebSocket(request, env);
  }

  // SSE endpoint for agent command delivery
  if (request.headers.get('accept')?.includes('text/event-stream')) {
    return handleAgentSSE(request, env);
  }

  return jsonResponse({ error: 'WEBSOCKET_UPGRADE_REQUIRED' }, { status: 426 });
}

async function handleAgentProtocolProbe(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  const auth = await authenticateAgentRequest(request, env);
  if (auth instanceof Response) return auth;
  return jsonResponse({
    protocol: 'scp.cc.v1',
    transports: ['websocket', 'sse', 'long-poll'],
  });
}

async function handleAgentPolling(request: Request, env: WorkerEnv): Promise<Response> {
  const token = getBearerToken(request);
  if (!token) {
    return jsonResponse({ error: 'AGENT_AUTH_REQUIRED' }, { status: 401 });
  }
  const db = requireD1(env);
  if (db instanceof Response) return db;
  const devices = new D1DeviceStore(db);
  const device = await devices.findDeviceByAgentToken(token);
  if (!device) {
    return jsonResponse({ error: 'AGENT_AUTH_FAILED' }, { status: 401 });
  }

  const body = await parseJsonBody(request);
  const now = new Date(nowMs(env)).toISOString();

  // Update device status on heartbeat
  await devices.updateDeviceStatus(device.id, 'connected', now);

  // Check for pending commands from other requests
  const commands = new D1CommandStore(db);
  const pendingCommands = await commands.listCommands({
    deviceId: device.id,
    state: 'dispatched',
    limit: 10,
  });

  // Mark commands as delivered to prevent duplicate delivery
  for (const cmd of pendingCommands) {
    await commands.markExecuting(cmd.commandId, now);
  }

  return jsonResponse({
    heartbeatAck: true,
    commands: pendingCommands.map(publicCommand),
    lastPollAt: now,
  });
}

async function handleAgentLongPoll(request: Request, env: WorkerEnv): Promise<Response> {
  // Long-polling: GET request for commands
  // For D1-based Workers, we use a simple approach:
  // - If commands exist, return immediately
  // - If no commands, return empty (agent will retry with exponential backoff)
  // This replaces POST polling to avoid Worker restarts
  const token = getBearerToken(request);
  if (!token) {
    return jsonResponse({ error: 'AGENT_AUTH_REQUIRED' }, { status: 401 });
  }
  const db = requireD1(env);
  if (db instanceof Response) return db;
  const devices = new D1DeviceStore(db);
  const device = await devices.findDeviceByAgentToken(token);
  if (!device) {
    return jsonResponse({ error: 'AGENT_AUTH_FAILED' }, { status: 401 });
  }
  const commands = new D1CommandStore(db);

  // Get current timestamp for this poll
  const now = new Date(nowMs(env)).toISOString();

  // Update device status
  await devices.updateDeviceStatus(device.id, 'connected', now);

  // Check for pending commands
  let pendingCommands = await commands.listCommands({
    deviceId: device.id,
    state: 'dispatched',
    limit: 10,
  });

  // If commands exist, return immediately
  if (pendingCommands.length > 0) {
    for (const cmd of pendingCommands) {
      await commands.markExecuting(cmd.commandId, now);
    }
    return jsonResponse({
      heartbeatAck: true,
      commands: pendingCommands.map(publicCommand),
      lastPollAt: now,
    });
  }

  // No commands available, return empty response
  // Agent will retry with exponential backoff
  return jsonResponse({
    heartbeatAck: true,
    commands: [],
    lastPollAt: now,
  });
}

async function handleAgentSSE(request: Request, env: WorkerEnv): Promise<Response> {
  // SSE (Server-Sent Events) for agent status updates
  // Agent uses long-polling for commands, SSE is for real-time status
  const token = getBearerToken(request);
  if (!token) {
    return jsonResponse({ error: 'AGENT_AUTH_REQUIRED' }, { status: 401 });
  }
  const db = requireD1(env);
  if (db instanceof Response) return db;
  const devices = new D1DeviceStore(db);
  const device = await devices.findDeviceByAgentToken(token);
  if (!device) {
    return jsonResponse({ error: 'AGENT_AUTH_FAILED' }, { status: 401 });
  }
  await devices.updateDeviceStatus(device.id, 'connected', new Date(nowMs(env)).toISOString());

  const encoder = new TextEncoder();
  let keepAlive: any;
  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection established event
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'connected', deviceId: device.id })}\n\n`));

      // Keep-alive ping every 15 seconds
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          if (keepAlive) clearInterval(keepAlive);
        }
      }, 15000);
    },
    cancel() {
      if (keepAlive) clearInterval(keepAlive);
    }
  });

  const headers = applySecurityHeaders(new Headers());
  headers.set('content-type', 'text/event-stream');
  headers.set('cache-control', 'no-cache');
  headers.set('connection', 'keep-alive');

  return new Response(stream, { headers }) as any;
}

async function handleAdminPtyWebSocket(request: Request, env: WorkerEnv): Promise<Response> {
  // For admin PTY WebSocket - this works in wrangler dev but not for agents
  const token = getBearerToken(request);
  if (!token) {
    return jsonResponse({ error: 'AGENT_AUTH_REQUIRED' }, { status: 401 });
  }
  const db = requireD1(env);
  if (db instanceof Response) return db;
  const devices = new D1DeviceStore(db);
  const device = await devices.findDeviceByAgentToken(token);
  if (!device) {
    return jsonResponse({ error: 'AGENT_AUTH_FAILED' }, { status: 401 });
  }
  try {
    const WebSocketPairCtor = (globalThis as any).WebSocketPair;
    if (typeof WebSocketPairCtor !== 'function') {
      return jsonResponse({ error: 'WEBSOCKET_PAIR_UNAVAILABLE' }, { status: 501 });
    }
    const pair = new WebSocketPairCtor();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    await devices.updateDeviceStatus(device.id, 'connected', new Date(nowMs(env)).toISOString());
    server.send(JSON.stringify({
      type: 'welcome',
      payload: { deviceId: device.id, protocol: 'scp.cc.v1' },
     }));
     const wsHeaders = applySecurityHeaders(new Headers());
     return new Response(null, { status: 101, headers: wsHeaders, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  } catch (err) {
    console.error('handleAgentWebSocket error:', err);
    return jsonResponse({ error: 'WEBSOCKET_SETUP_FAILED', details: String(err) }, { status: 500 });
  }
}



function adminActorType(principal: AdminPrincipal): 'admin_session' | 'admin_api_token' | 'admin_env_token' {
  if (principal.kind === 'db-token') return 'admin_api_token';
  if (principal.kind === 'env-token') return 'admin_env_token';
  return 'admin_session';
}

function adminActorId(principal: AdminPrincipal): string | null {
  if (principal.kind === 'db-token') return principal.tokenId;
  if (principal.kind === 'env-token') return 'CC_ADMIN_API_TOKEN';
  return null;
}

function websocketSend(socket: { send?: (message: string) => void }, type: string, payload: unknown): void {
  socket.send?.(JSON.stringify({ type, payload }));
}

const adminPtySubscribers = new Map<string, Set<{ send?: (message: string) => void }>>();

function addAdminPtySubscriber(sessionId: string, socket: { send?: (message: string) => void }): void {
  const subscribers = adminPtySubscribers.get(sessionId) ?? new Set();
  subscribers.add(socket);
  adminPtySubscribers.set(sessionId, subscribers);
}

function removeAdminPtySubscriber(sessionId: string, socket: { send?: (message: string) => void }): void {
  const subscribers = adminPtySubscribers.get(sessionId);
  if (!subscribers) return;
  subscribers.delete(socket);
  if (!subscribers.size) adminPtySubscribers.delete(sessionId);
}

function removeAdminPtySocket(socket: { send?: (message: string) => void }): void {
  for (const [sessionId, subscribers] of adminPtySubscribers.entries()) {
    subscribers.delete(socket);
    if (!subscribers.size) adminPtySubscribers.delete(sessionId);
  }
}

function fanoutAdminPtyOutput(sessionId: string, payload: { sessionId: string; deviceId: string; data: string }): void {
  fanoutAdminPtyEvent(sessionId, 'pty_output', payload);
}

function fanoutAdminPtyEvent(sessionId: string, type: string, payload: Record<string, unknown>): void {
  const subscribers = adminPtySubscribers.get(sessionId);
  if (!subscribers) return;
  for (const subscriber of subscribers) {
    websocketSend(subscriber, type, payload);
  }
}

async function handleInternalPtyFanout(request: Request, env: WorkerEnv): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(request);
  } catch {
    return jsonResponse({ ok: false, error: 'INVALID_JSON' }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const msgType = typeof body.type === 'string' ? body.type : 'pty_output';
  const payload = body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : {};
  const subscribers = adminPtySubscribers.get(sessionId);
  if (!subscribers?.size) {
    return jsonResponse({ ok: true, delivered: 0 });
  }
  for (const subscriber of subscribers) {
    websocketSend(subscriber, msgType, payload);
  }
  return jsonResponse({ ok: true, delivered: subscribers.size });
}

async function relayPtyToAdminSubscribers(
  env: WorkerEnv,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Try direct fanout (works in main worker isolate where subscribers map is populated)
  fanoutAdminPtyEvent(sessionId, type, payload);

  // Also relay via internal endpoint (reaches the main worker from DO isolate)
  try {
    await fetch('http://localhost/internal/pty-fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, type, payload }),
    });
  } catch {
    // Ignore relay errors ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â the HTTP path is a best-effort bridge from the DO isolate
  }
}

type AdminPtySocketState = { writeTimestamps: number[] };

async function handleAdminPtyMessage(input: {
  data: unknown;
  socket: { send?: (message: string) => void };
  db: any;
  env: WorkerEnv;
  principal: AdminPrincipal;
  state: AdminPtySocketState;
}): Promise<void> {
  let message: Record<string, any>;
  try {
    message = JSON.parse(String(input.data || '{}'));
  } catch {
    websocketSend(input.socket, 'pty_error', { code: 'INVALID_JSON', message: 'Invalid PTY message JSON' });
    return;
  }
  if (message.payload && typeof message.payload === 'object') {
    message = { ...message.payload, ...message };
  }

  if (message.type === 'pty_write' || message.type === 'pty_resize') {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
    if (!sessionId) {
      websocketSend(input.socket, 'pty_error', { code: 'SESSION_ID_REQUIRED', message: 'sessionId is required' });
      return;
    }
    const sessions = new D1PtySessionStore(input.db);
    const session = await sessions.get(sessionId);
    if (!session) {
      websocketSend(input.socket, 'pty_error', { code: 'PTY_SESSION_NOT_FOUND', message: 'PTY session not found' });
      return;
    }
    const actorType = adminActorType(input.principal);
    const actorId = adminActorId(input.principal);
    if (session.attachedActorType !== actorType || (session.attachedActorId ?? null) !== (actorId ?? null)) {
      websocketSend(input.socket, 'pty_error', { code: 'PTY_NOT_ATTACHED', message: 'PTY session is not attached to this admin client' });
      return;
    }
    if (!['opening', 'open'].includes(session.state)) {
      websocketSend(input.socket, 'pty_error', { code: 'PTY_SESSION_NOT_ACTIVE', message: 'PTY session is not active' });
      return;
    }
    const nowMsValue = nowMs(input.env);
    const now = new Date(nowMsValue).toISOString();
    if (message.type === 'pty_write') {
      input.state.writeTimestamps = input.state.writeTimestamps.filter((ts) => nowMsValue - ts < 1000);
      if (input.state.writeTimestamps.length >= 20) {
        websocketSend(input.socket, 'pty_error', { code: 'PTY_WRITE_RATE_LIMITED', message: 'PTY write rate limit exceeded' });
        return;
      }
      const data = typeof message.data === 'string' ? message.data : '';
      if (!data) {
        websocketSend(input.socket, 'pty_error', { code: 'PTY_WRITE_DATA_REQUIRED', message: 'data is required' });
        return;
      }
      if (data.length > 8192) {
        websocketSend(input.socket, 'pty_error', { code: 'PTY_WRITE_TOO_LARGE', message: 'PTY write payload is too large' });
        return;
      }
      input.state.writeTimestamps.push(nowMsValue);
      const commands = new D1CommandStore(input.db);
      let command = await commands.createQueuedCommand({
        id: makeUuid(input.env),
        commandId: makeUuid(input.env),
        deviceId: session.deviceId,
        commandType: 'write_pty',
        actorType,
        actorId,
        payload: { sessionId, data },
        payloadSummary: `Write PTY ${sessionId}`,
        submittedAt: now,
      });
      command = await commands.markDispatched(command.commandId, await commands.nextReqSeq(session.deviceId), now);
      await notifyAgentDurableObject(input.env, session.deviceId, publicCommand(command), now);
      await new D1PtyAuditStore(input.db).append({
        id: makeUuid(input.env),
        sessionId,
        deviceId: session.deviceId,
        ts: now,
        eventType: 'pty_write',
        actorType,
        actorId,
        summary: 'Admin wrote to PTY session',
        details: { byteLength: data.length },
      });
      websocketSend(input.socket, 'pty_write_accepted', { sessionId, acceptedBytes: data.length });
      return;
    }

    const cols = Math.min(Math.max(Number(message.cols) || 80, 20), 300);
    const rows = Math.min(Math.max(Number(message.rows) || 24, 5), 120);
    const resized = await sessions.updateSize(sessionId, cols, rows);
    const commands = new D1CommandStore(input.db);
    let command = await commands.createQueuedCommand({
      id: makeUuid(input.env),
      commandId: makeUuid(input.env),
      deviceId: resized.deviceId,
      commandType: 'resize_pty',
      actorType,
      actorId,
      payload: { sessionId, cols, rows },
      payloadSummary: `Resize PTY ${sessionId}`,
      submittedAt: now,
    });
    command = await commands.markDispatched(command.commandId, await commands.nextReqSeq(resized.deviceId), now);
    await notifyAgentDurableObject(input.env, resized.deviceId, publicCommand(command), now);
    await new D1PtyAuditStore(input.db).append({
      id: makeUuid(input.env),
      sessionId,
      deviceId: resized.deviceId,
      ts: now,
      eventType: 'pty_resize',
      actorType,
      actorId,
      summary: 'Admin resized PTY session',
      details: { cols, rows },
    });
    websocketSend(input.socket, 'pty_resize_accepted', { sessionId, cols, rows });
    return;
  }

  if (message.type === 'pty_attach' || message.type === 'pty_detach') {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
    if (!sessionId) {
      websocketSend(input.socket, 'pty_error', { code: 'SESSION_ID_REQUIRED', message: 'sessionId is required' });
      return;
    }
    const sessions = new D1PtySessionStore(input.db);
    const existing = await sessions.get(sessionId);
    if (!existing) {
      websocketSend(input.socket, 'pty_error', { code: 'PTY_SESSION_NOT_FOUND', message: 'PTY session not found' });
      return;
    }
    const now = new Date(nowMs(input.env)).toISOString();
    const actorType = adminActorType(input.principal);
    const actorId = adminActorId(input.principal);
    if (message.type === 'pty_attach') {
      const attached = await sessions.attach(sessionId, actorType, actorId, now);
      addAdminPtySubscriber(sessionId, input.socket);
      await new D1PtyAuditStore(input.db).append({
        id: makeUuid(input.env),
        sessionId,
        deviceId: attached.deviceId,
        ts: now,
        eventType: 'pty_attached',
        actorType,
        actorId,
        summary: 'Admin attached PTY session',
        details: {},
      });
      websocketSend(input.socket, 'pty_attached', { sessionId, deviceId: attached.deviceId });
      return;
    }
    const detached = await sessions.detach(sessionId, now);
    removeAdminPtySubscriber(sessionId, input.socket);
    await new D1PtyAuditStore(input.db).append({
      id: makeUuid(input.env),
      sessionId,
      deviceId: detached.deviceId,
      ts: now,
      eventType: 'pty_detached',
      actorType,
      actorId,
      summary: 'Admin detached PTY session',
      details: {},
    });
    websocketSend(input.socket, 'pty_detached', { sessionId, deviceId: detached.deviceId });
    return;
  }

  if (message.type === 'pty_close' || message.type === 'pty_delete') {
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
    if (!sessionId) {
      websocketSend(input.socket, 'pty_error', { code: 'SESSION_ID_REQUIRED', message: 'sessionId is required' });
      return;
    }
    const sessions = new D1PtySessionStore(input.db);
    const existing = await sessions.get(sessionId);
    if (!existing) {
      websocketSend(input.socket, 'pty_error', { code: 'PTY_SESSION_NOT_FOUND', message: 'PTY session not found' });
      return;
    }
    const now = new Date(nowMs(input.env)).toISOString();
    const actorType = adminActorType(input.principal);
    const actorId = adminActorId(input.principal);

    if (message.type === 'pty_delete') {
      if (!['closed', 'expired', 'failed'].includes(existing.state)) {
        websocketSend(input.socket, 'pty_error', { code: 'PTY_SESSION_NOT_TERMINAL', message: 'Only terminal PTY sessions can be deleted' });
        return;
      }
      await sessions.deleteTerminalSession(sessionId, now);
      removeAdminPtySubscriber(sessionId, input.socket);
      await new D1PtyAuditStore(input.db).append({
        id: makeUuid(input.env),
        sessionId,
        deviceId: existing.deviceId,
        ts: now,
        eventType: 'pty_deleted',
        actorType,
        actorId,
        summary: 'Admin deleted PTY session record',
        details: {},
      });
      websocketSend(input.socket, 'pty_deleted', { sessionId, deviceId: existing.deviceId });
      return;
    }

    if (!['opening', 'open'].includes(existing.state)) {
      websocketSend(input.socket, 'pty_error', { code: 'PTY_SESSION_NOT_ACTIVE', message: 'Only active PTY sessions can be closed' });
      return;
    }
    const closing = await sessions.markClosing(sessionId, now);
    removeAdminPtySubscriber(sessionId, input.socket);
    const commands = new D1CommandStore(input.db);
    let command = await commands.createQueuedCommand({
      id: makeUuid(input.env),
      commandId: makeUuid(input.env),
      deviceId: closing.deviceId,
      commandType: 'close_pty',
      actorType,
      actorId,
      payload: { sessionId },
      payloadSummary: `Close PTY ${sessionId}`,
      submittedAt: now,
    });
    const reqSeq = await commands.nextReqSeq(closing.deviceId);
    command = await commands.markDispatched(command.commandId, reqSeq, now);
    await notifyAgentDurableObject(input.env, closing.deviceId, publicCommand(command), now);
    await new D1PtyAuditStore(input.db).append({
      id: makeUuid(input.env),
      sessionId,
      deviceId: closing.deviceId,
      ts: now,
      eventType: 'pty_close_requested',
      actorType,
      actorId,
      summary: 'Admin requested PTY close',
      details: {},
    });
    websocketSend(input.socket, 'pty_close_requested', { sessionId, deviceId: closing.deviceId });
    return;
  }

  if (message.type !== 'pty_open') {
    websocketSend(input.socket, 'pty_error', { code: 'NOT_IMPLEMENTED', message: 'Admin PTY workflow message is not implemented yet in Worker mode.' });
    return;
  }

  const deviceId = typeof message.deviceId === 'string' ? message.deviceId.trim() : '';
  if (!deviceId) {
    websocketSend(input.socket, 'pty_error', { code: 'DEVICE_ID_REQUIRED', message: 'deviceId is required' });
    return;
  }
  const device = await new D1DeviceStore(input.db).getDevice(deviceId);
  if (!device) {
    websocketSend(input.socket, 'pty_error', { code: 'DEVICE_NOT_FOUND', message: 'Device not found' });
    return;
  }

  const sessionId = typeof message.sessionId === 'string' && message.sessionId.trim() ? message.sessionId.trim() : makeUuid(input.env);
  const cols = Math.min(Math.max(Number(message.cols) || 80, 20), 300);
  const rows = Math.min(Math.max(Number(message.rows) || 24, 5), 120);
  const now = new Date(nowMs(input.env)).toISOString();
  const actorType = adminActorType(input.principal);
  const actorId = adminActorId(input.principal);

  await new D1PtySessionStore(input.db).createOpening({
    id: makeUuid(input.env),
    sessionId,
    deviceId,
    cols,
    rows,
    openedAt: now,
    openedByActorType: actorType,
    openedByActorId: actorId,
    attachedActorType: actorType,
    attachedActorId: actorId,
  });
  await new D1PtyAuditStore(input.db).append({
    id: makeUuid(input.env),
    sessionId,
    deviceId,
    ts: now,
    eventType: 'pty_open_requested',
    actorType,
    actorId,
    summary: 'Admin requested PTY open',
    details: { cols, rows },
  });

  const commands = new D1CommandStore(input.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(input.env),
    commandId: sessionId,
    deviceId,
    commandType: 'open_pty',
    actorType,
    actorId,
    payload: { sessionId, cols, rows },
    payloadSummary: `Open PTY ${sessionId}`,
    submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(deviceId);
  command = await commands.markDispatched(sessionId, reqSeq, now);
  await commands.appendAudit({
    id: makeUuid(input.env),
    commandId: sessionId,
    ts: now,
    eventType: 'dispatched',
    actorType,
    actorId,
    source: 'worker',
    summary: `Dispatched open_pty to ${deviceId}`,
    details: { reqSeq, sessionId, cols, rows },
  });
  await notifyAgentDurableObject(input.env, deviceId, publicCommand(command), now);
  websocketSend(input.socket, 'pty_opening', { sessionId, deviceId, cols, rows });
}

async function handleAdminPtyUpgrade(request: Request, env: WorkerEnv): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:control']);
  if (auth instanceof Response) return auth;
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return jsonResponse({ error: 'WEBSOCKET_UPGRADE_REQUIRED' }, { status: 426 });
  }
  const WebSocketPairCtor = (globalThis as any).WebSocketPair;
  if (typeof WebSocketPairCtor !== 'function') {
    return jsonResponse({ error: 'WEBSOCKET_PAIR_UNAVAILABLE' }, { status: 501 });
  }
  const pair = new WebSocketPairCtor();
  const client = pair[0] as WebSocket;
  const server = pair[1] as WebSocket & { accept?: () => void; addEventListener?: (type: string, listener: (event: { data?: unknown }) => void) => void };
  server.accept?.();
  websocketSend(server, 'pty_state', { status: 'connected' });
  const ptyState: AdminPtySocketState = { writeTimestamps: [] };
  server.addEventListener?.('message', (event) => {
    return handleAdminPtyMessage({
      data: event.data,
      socket: server,
      db: auth.db,
      env,
      principal: auth.principal,
      state: ptyState,
    }).catch((err) => {
      websocketSend(server, 'pty_error', { code: 'INTERNAL_ERROR', message: String(err) });
    });
  });
  server.addEventListener?.('close', () => removeAdminPtySocket(server));
  server.addEventListener?.('error', () => removeAdminPtySocket(server));
  const wsHeaders = applySecurityHeaders(new Headers());
  return new Response(null, { status: 101, headers: wsHeaders, webSocket: client } as ResponseInit & { webSocket: WebSocket });
}

function sendAgentRequest(deviceId: string, message: Record<string, unknown>): { ok: true; seq: number; ts: string } | { ok: false; reason: string } {
  // In Cloudflare Workers D1 mode, we cannot use persistent WebSockets.
  // Commands are stored in D1 and agents poll for them.
  // This function is kept for potential future use with WebSocket-based transports.
  return { ok: false, reason: 'POLLED_REQUIRED' };
}

async function dispatchGenericAgentCommand(request: Request, env: WorkerEnv, deviceId: string, commandType: string): Promise<Response> {
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
    id: makeUuid(env),
    commandId,
    deviceId,
    commandType,
    actorType: getBearerToken(request) ? 'admin_env_token' : 'admin_session',
    actorId: getBearerToken(request) ? 'CC_ADMIN_API_TOKEN' : null,
    payload: Object.keys(payload).length ? payload : null,
    payloadSummary: `Request ${commandType}`,
    submittedAt: now,
  });
  await commands.appendAudit({
    id: makeUuid(env),
    commandId,
    ts: now,
    eventType: 'created',
    actorType: command.actorType,
    actorId: command.actorId,
    source: 'worker',
    summary: `Created ${commandType}`,
    details: { commandType },
  });

  const dispatchedAt = new Date(nowMs(env)).toISOString();
  const reqSeq = await commands.nextReqSeq(deviceId);
  command = await commands.markDispatched(commandId, reqSeq, dispatchedAt);
  await commands.appendAudit({
    id: makeUuid(env),
    commandId,
    ts: now,
    eventType: 'dispatched',
    actorType: command.actorType,
    actorId: command.actorId,
    source: 'worker',
    summary: `Dispatched ${commandType} to ${deviceId} (durable-object/websocket delivery with polling fallback)`,
    details: { reqSeq },
  });
  await notifyAgentDurableObject(env, deviceId, publicCommand(command), dispatchedAt);
  return jsonResponse({ ok: true, deviceId, reqSeq, requestedAt: dispatchedAt, command });
}

async function handleStartServerSshCommand(request: Request, env: WorkerEnv, deviceId: string): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:control']);
  if (auth instanceof Response) return auth;
  const body = await parseJsonBody(request);
  const csrfFailure = requireCsrfForCookieMutation(request, env, body);
  if (csrfFailure) return csrfFailure;
  const device = await new D1DeviceStore(auth.db).getDevice(deviceId);
  if (!device) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  const serverId = typeof body.serverId === 'string' ? body.serverId.trim() : '';
  if (!serverId) return jsonResponse({ error: 'serverId is required' }, { status: 400 });

  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
    ? body.sessionId.trim()
    : `server-ssh-${serverId}-${makeUuid(env)}`;
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
      ok: true,
      deviceId,
      serverId,
      sessionId: activeSession.sessionId,
      reqSeq: 1,
      requestedAt: now,
      agentAck: null,
      reused: true,
      command: await new D1CommandStore(auth.db).getCommand(activeSession.sessionId),
    });
  }

  await ptySessions.createOpening({
    id: makeUuid(env),
    sessionId,
    deviceId,
    kind: 'server_ssh',
    serverId,
    cols,
    rows,
    openedAt: now,
    openedByActorType: actorType,
    openedByActorId: actorId,
    attachedActorType: actorType,
    attachedActorId: actorId,
  });
  await new D1PtyAuditStore(auth.db).append({
    id: makeUuid(env),
    sessionId,
    deviceId,
    ts: now,
    eventType: 'pty_open_requested',
    actorType,
    actorId,
    summary: 'Admin requested server SSH PTY open',
    details: { serverId, cols, rows },
  });

  const commands = new D1CommandStore(auth.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(env),
    commandId: sessionId,
    deviceId,
    commandType: 'start_server_ssh',
    actorType,
    actorId,
    payload: { serverId, sessionId, cols, rows },
    payloadSummary: `Start server SSH ${serverId}`,
    submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(deviceId);
  command = await commands.markDispatched(sessionId, reqSeq, now);
  await commands.appendAudit({
    id: makeUuid(env),
    commandId: sessionId,
    ts: now,
    eventType: 'dispatched',
    actorType,
    actorId,
    source: 'worker',
    summary: `Dispatched start_server_ssh to ${deviceId}`,
    details: { reqSeq, serverId, sessionId, cols, rows },
  });
  await notifyAgentDurableObject(env, deviceId, publicCommand(command), now);

  return jsonResponse({
    ok: true,
    deviceId,
    serverId,
    sessionId,
    reqSeq,
    requestedAt: now,
    agentAck: null,
    command,
  });
}

async function handleAttachServerSshCommand(request: Request, env: WorkerEnv, deviceId: string): Promise<Response> {
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

  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
    ? body.sessionId.trim()
    : `server-ssh-${serverId}-${makeUuid(env)}`;
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
      ok: true,
      deviceId,
      serverId,
      sessionId: activeSession.sessionId,
      reqSeq: 1,
      requestedAt: now,
      agentAck: null,
      reused: true,
      command: await new D1CommandStore(auth.db).getCommand(activeSession.sessionId),
    });
  }

  await ptySessions.createOpening({
    id: makeUuid(env),
    sessionId,
    deviceId,
    kind: 'server_ssh',
    serverId,
    localSessionId,
    cols,
    rows,
    openedAt: now,
    openedByActorType: actorType,
    openedByActorId: actorId,
    attachedActorType: actorType,
    attachedActorId: actorId,
  });
  await new D1PtyAuditStore(auth.db).append({
    id: makeUuid(env),
    sessionId,
    deviceId,
    ts: now,
    eventType: 'pty_attach_requested',
    actorType,
    actorId,
    summary: 'Admin requested server SSH PTY attach',
    details: { serverId, sessionId, localSessionId, cols, rows },
  });

  const commands = new D1CommandStore(auth.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(env),
    commandId: sessionId,
    deviceId,
    commandType: 'request_attach_server_ssh',
    actorType,
    actorId,
    payload: { serverId, sessionId, localSessionId, cols, rows },
    payloadSummary: `Attach server SSH ${serverId}`,
    submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(deviceId);
  command = await commands.markDispatched(sessionId, reqSeq, now);
  await commands.appendAudit({
    id: makeUuid(env),
    commandId: sessionId,
    ts: now,
    eventType: 'dispatched',
    actorType,
    actorId,
    source: 'worker',
    summary: `Dispatched request_attach_server_ssh to ${deviceId}`,
    details: { reqSeq, serverId, sessionId, localSessionId, cols, rows },
  });
  await notifyAgentDurableObject(env, deviceId, publicCommand(command), now);

  return jsonResponse({
    ok: true,
    deviceId,
    serverId,
    sessionId,
    reqSeq,
    requestedAt: now,
    agentAck: null,
    command,
  });
}

async function handleListDevices(request: Request, env: WorkerEnv): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:read']);
  if (auth instanceof Response) return auth;
  const devices = await new D1DeviceStore(auth.db).getAllDevices();
  return jsonResponse(devices.map(publicDevice));
}

async function handleGetDevice(request: Request, env: WorkerEnv, deviceId: string): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:read']);
  if (auth instanceof Response) return auth;
  const device = await new D1DeviceStore(auth.db).getDevice(deviceId);
  if (!device) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  return jsonResponse(publicDevice(device));
}

async function handleDeleteDevice(request: Request, env: WorkerEnv, deviceId: string): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:control']);
  if (auth instanceof Response) return auth;
  const removed = await new D1DeviceStore(auth.db).removeDevice(deviceId);
  if (!removed) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  return jsonResponse({ removed: true });
}

async function handleRevokeDevice(request: Request, env: WorkerEnv): Promise<Response> {
  const token = getBearerToken(request);
  if (!token) return jsonResponse({ error: 'Missing agent authorization header' }, { status: 401 });
  const db = requireD1(env);
  if (db instanceof Response) return db;
  const devices = new D1DeviceStore(db);
  const device = await devices.findDeviceByAgentToken(token);
  if (!device) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  await devices.removeDevice(device.id);
  return jsonResponse({ removed: true });
}


function resolveLogFilter(url: URL): WorkerTelemetryFilter {
  return {
    type: url.searchParams.get('type')?.trim() || undefined,
    functionId: url.searchParams.get('functionId')?.trim() || undefined,
    q: url.searchParams.get('q')?.trim() || undefined,
  };
}

function clampNumber(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type SsePoller = () => Promise<string[]>;

function sseStreamResponse(frames: string[], poll?: { intervalMs: number; next: SsePoller }): Response {
  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const initial = frames.length ? frames.join('') : ': connected\n\n';
      controller.enqueue(encoder.encode(initial));
      if (poll) {
        pollInterval = setInterval(() => {
          if (polling) return;
          polling = true;
          poll.next()
            .then((nextFrames) => {
              if (nextFrames.length) controller.enqueue(encoder.encode(nextFrames.join('')));
            })
            .catch((err) => {
              controller.enqueue(encoder.encode(sseFrame('error', { message: String(err) })));
            })
            .finally(() => { polling = false; });
        }, poll.intervalMs);
      }
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          if (keepAlive) clearInterval(keepAlive);
          if (pollInterval) clearInterval(pollInterval);
        }
      }, 15000);
    },
    cancel() {
      if (keepAlive) clearInterval(keepAlive);
      if (pollInterval) clearInterval(pollInterval);
    },
  });
  const headers = applySecurityHeaders(new Headers());
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  headers.set('cache-control', 'no-cache');
  headers.set('connection', 'keep-alive');
  return new Response(stream, { headers });
}

function streamPollMs(env: WorkerEnv): number {
  return Math.min(Math.max(Number(env.streamPollMs) || 3000, 25), 60000);
}


async function requireAdminAndDevice(request: Request, env: WorkerEnv, deviceId: string | null, requiredScopes: WorkerAdminApiTokenScope[] = []): Promise<{ db: any; deviceId: string; devices: D1DeviceStore } | Response> {
  const auth = await requireAdminAuth(request, env, requiredScopes);
  if (auth instanceof Response) return auth;
  if (!deviceId) return jsonResponse({ error: 'deviceId is required' }, { status: 400 });
  const db = auth.db;
  const devices = new D1DeviceStore(db);
  const device = await devices.getDevice(deviceId);
  if (!device) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  return { db, deviceId, devices };
}


async function requireAdmin(request: Request, env: WorkerEnv, requiredScopes: WorkerAdminApiTokenScope[] = []): Promise<{ db: any } | Response> {
  const auth = await requireAdminAuth(request, env, requiredScopes);
  if (auth instanceof Response) return auth;
  return { db: auth.db };
}


async function requireAdminBody(request: Request, env: WorkerEnv, requiredScopes: WorkerAdminApiTokenScope[] = []): Promise<{ db: any; body: Record<string, unknown> } | Response> {
  const auth = await requireAdminAuth(request, env, requiredScopes);
  if (auth instanceof Response) return auth;
  const body = await parseRequestFields(request);
  const csrfFailure = requireCsrfForCookieMutation(request, env, body);
  if (csrfFailure) return csrfFailure;
  return { db: auth.db, body };
}

async function handleListCommands(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
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

async function handleListPtySessions(request: Request, env: WorkerEnv, deviceId: string, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, deviceId, ['device:read']);
  if (required instanceof Response) return required;
  const limit = clampNumber(url.searchParams.get('limit'), 50, 1, 500);
  const ptyStore = new D1PtySessionStore(required.db);
  const now = new Date(nowMs(env)).toISOString();
  await ptyStore.expireOpeningSessions(now, required.deviceId);
  const sessions = (await ptyStore.listByDevice(required.deviceId, limit))
    .filter((session) => !(session.state === 'failed' && ['PTY_NOT_FOUND', 'PTY_SESSION_NOT_FOUND'].includes(session.failureCode ?? '')))
    .filter((session) => !(session.state === 'expired' && session.failureCode === 'PTY_OPEN_TIMEOUT'));
  const commands = new D1CommandStore(required.db);
  const items = await Promise.all(sessions.map(async (session) => {
    const command = await commands.getCommand(session.sessionId);
    const payload = command?.payload && typeof command.payload === 'object' ? command.payload as Record<string, unknown> : {};
    const serverId = ['start_server_ssh', 'request_attach_server_ssh'].includes(command?.commandType ?? '') && typeof payload.serverId === 'string' && payload.serverId.trim()
      ? payload.serverId.trim()
      : null;
    return serverId ? { ...session, serverId } : session;
  }));
  return jsonResponse({ items });
}

async function handleTunnelLogs(request: Request, env: WorkerEnv, deviceId: string, serverId: string, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, deviceId, ['logs:read']);
  if (required instanceof Response) return required;
  const resolvedServerId = serverId.trim();
  if (!resolvedServerId) return jsonResponse({ error: 'serverId is required' }, { status: 400 });

  const store = new D1LogStore(required.db);
  const limit = clampNumber(url.searchParams.get('limit'), 200, 1, 5000);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const functionId = `server-tunnel-${resolvedServerId}`;
  const sessionId = await store.getLastSessionIdForFunction(required.deviceId, functionId);
  if (!sessionId) {
    return jsonResponse({ entries: [], total: 0 });
  }

  const logs = await store.listPtyOutputBySession(required.deviceId, sessionId, limit, offset);
  const total = await store.countPtyOutputBySession(required.deviceId, sessionId);
  return jsonResponse({
    entries: logs.map((entry) => {
      const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload as Record<string, unknown> : {};
      return {
        ts: entry.ts,
        sessionId: entry.sessionId ?? null,
        data: typeof payload.data === 'string' ? payload.data : '',
      };
    }),
    total,
  });
}

async function handleDevicesStream(request: Request, env: WorkerEnv): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:read']);
  if (auth instanceof Response) return auth;
  const store = new D1DeviceStore(auth.db);
  const devices = await store.getAllDevices();
  const lastStatus = new Map(devices.map((device) => [device.id, device.status]));
  const frameFor = (device: { id: string; name: string; lastSeenAt: string; status: string; os?: string | null }) => sseFrame(
    device.status === 'connected' ? 'device-connected' : 'device-disconnected',
    publicDevice(device),
  );
  return sseStreamResponse([], {
    intervalMs: streamPollMs(env),
    next: async () => {
      const current = await store.getAllDevices();
      const frames: string[] = [];
      for (const device of current) {
        const previous = lastStatus.get(device.id);
        if (previous !== device.status) {
          frames.push(frameFor(device));
          lastStatus.set(device.id, device.status);
        }
      }
      return frames;
    },
  });
}

async function handleTelemetryStream(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'), ['logs:read']);
  if (required instanceof Response) return required;
  const store = new D1LogStore(required.db);
  const limit = clampNumber(url.searchParams.get('limit'), 100, 1, 500);
  const filter = resolveLogFilter(url);
  const events = await store.listByDevice(required.deviceId, limit, filter);
  const seen = new BoundedSeenIds(limit);
  seen.rememberFresh(events.map((event) => event.id));
  return sseStreamResponse([], {
    intervalMs: streamPollMs(env),
    next: async () => {
      const current = await store.listByDevice(required.deviceId, limit, filter);
      const freshIds = new Set(seen.rememberFresh(current.map((event) => event.id)));
      const fresh = current.filter((event) => freshIds.has(event.id));
      return fresh.map((event) => sseFrame('telemetry', event));
    },
  });
}

async function handleCommandsStream(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
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

async function handleTransfersStream(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'), ['device:read']);
  if (required instanceof Response) return required;
  const store = new D1FileTransferStore(required.db);
  const limit = clampNumber(url.searchParams.get('limit'), 100, 1, 500);
  const transfers = await store.listByDevice(required.deviceId, limit);
  let seen = new Map(transfers.map((transfer) => [transfer.transferId, JSON.stringify(transfer)]));
  return sseStreamResponse([], {
    intervalMs: streamPollMs(env),
    next: async () => {
      const current = await store.listByDevice(required.deviceId, limit);
      const nextSeen = new Map<string, string>();
      const changed = current.filter((transfer) => {
        const serialized = JSON.stringify(transfer);
        nextSeen.set(transfer.transferId, serialized);
        if (seen.get(transfer.transferId) === serialized) return false;
        return true;
      });
      seen = nextSeen;
      return changed.reverse().map((transfer) => sseFrame('file_transfer', transfer));
    },
  });
}


async function handleGetCommand(request: Request, env: WorkerEnv, commandId: string): Promise<Response> {
  const required = await requireAdmin(request, env);
  if (required instanceof Response) return required;
  const command = await new D1CommandStore(required.db).getCommand(commandId);
  if (!command) return jsonResponse({ error: 'Command not found' }, { status: 404 });
  return jsonResponse(command);
}

async function handleListCommandAudit(request: Request, env: WorkerEnv, commandId: string): Promise<Response> {
  const required = await requireAdmin(request, env);
  if (required instanceof Response) return required;
  const store = new D1CommandStore(required.db);
  const command = await store.getCommand(commandId);
  if (!command) return jsonResponse({ error: 'Command not found' }, { status: 404 });
  return jsonResponse({ items: await store.listAudit(commandId) });
}


function isFinishedTransferState(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'canceled';
}

async function requireAdminDeviceFromBody(request: Request, env: WorkerEnv, requiredScopes: WorkerAdminApiTokenScope[] = []): Promise<{ db: any; deviceId: string; body: Record<string, unknown>; principal: AdminPrincipal } | Response> {
  const auth = await requireAdminAuth(request, env, requiredScopes);
  if (auth instanceof Response) return auth;
  const body = await parseJsonBody(request);
  const csrfFailure = requireCsrfForCookieMutation(request, env, body);
  if (csrfFailure) return csrfFailure;
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  if (!deviceId) return jsonResponse({ error: 'deviceId is required' }, { status: 400 });
  const db = auth.db;
  const device = await new D1DeviceStore(db).getDevice(deviceId);
  if (!device) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  return { db, deviceId, body, principal: auth.principal };
}

async function handleListFileTransfers(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'), ['device:read']);
  if (required instanceof Response) return required;
  const limit = clampNumber(url.searchParams.get('limit'), 100, 1, 1000);
  return jsonResponse({ items: await new D1FileTransferStore(required.db).listByDevice(required.deviceId, limit) });
}

async function requireTransferFromBody(request: Request, env: WorkerEnv): Promise<{ db: any; store: D1FileTransferStore; deviceId: string; transferId: string; transfer: Awaited<ReturnType<D1FileTransferStore['get']>>; principal: AdminPrincipal } | Response> {
  const required = await requireAdminDeviceFromBody(request, env);
  if (required instanceof Response) return required;
  const transferId = typeof required.body.transferId === 'string' ? required.body.transferId.trim() : '';
  if (!transferId) return jsonResponse({ error: 'transferId is required' }, { status: 400 });
  const store = new D1FileTransferStore(required.db);
  const transfer = await store.get(transferId);
  if (!transfer || transfer.deviceId !== required.deviceId) return jsonResponse({ error: 'Transfer not found' }, { status: 404 });
  return { db: required.db, store, deviceId: required.deviceId, transferId, transfer, principal: required.principal };
}

async function handleDismissFileTransfer(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireTransferFromBody(request, env);
  if (required instanceof Response) return required;
  if (!isFinishedTransferState(required.transfer!.state)) {
    return jsonResponse({ code: 'transfer_not_finished', message: 'Only finished transfers can be dismissed' }, { status: 409 });
  }
  await required.store.deleteAny(required.transferId);
  return jsonResponse({ ok: true, transferId: required.transferId });
}

async function handleForceRemoveFileTransfer(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireTransferFromBody(request, env);
  if (required instanceof Response) return required;
  await required.store.deleteAny(required.transferId);
  return jsonResponse({ ok: true, transferId: required.transferId, forced: !isFinishedTransferState(required.transfer!.state) });
}

async function handleStopFileTransfer(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireTransferFromBody(request, env);
  if (required instanceof Response) return required;
  if (isFinishedTransferState(required.transfer!.state)) {
    return jsonResponse({ code: 'transfer_already_finished', message: 'Transfer is already finished' }, { status: 409 });
  }
  const now = new Date(nowMs(env)).toISOString();
  const actorType = adminActorType(required.principal);
  const actorId = adminActorId(required.principal);
  const commands = new D1CommandStore(required.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(env),
    commandId: makeUuid(env),
    deviceId: required.deviceId,
    commandType: 'stop_file_transfer',
    actorType,
    actorId,
    payload: { transferId: required.transferId },
    payloadSummary: `Stop file transfer ${required.transferId}`,
    submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(required.deviceId);
  command = await commands.markDispatched(command.commandId, reqSeq, now);
  const transfer = await required.store.markState(required.transferId, 'canceled', now, { message: 'Stop requested by admin' });
  await notifyAgentDurableObject(env, required.deviceId, publicCommand(command), now);
  return jsonResponse({ ok: true, transferId: required.transferId, state: transfer.state, command });
}

async function handleDismissFinishedFileTransfers(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminDeviceFromBody(request, env);
  if (required instanceof Response) return required;
  const result = await new D1FileTransferStore(required.db).deleteFinishedByDevice(required.deviceId);
  return jsonResponse({ ok: true, deletedCount: result.deletedCount });
}

async function handleOpenRemoteBrowser(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminDeviceFromBody(request, env);
  if (required instanceof Response) return required;
  const serverId = typeof required.body.serverId === 'string' ? required.body.serverId.trim() : '';
  if (!serverId) return jsonResponse({ error: 'serverId is required' }, { status: 400 });
  const rootPath = typeof required.body.rootPath === 'string' && required.body.rootPath.trim() ? required.body.rootPath.trim() : null;
  const now = new Date(nowMs(env)).toISOString();
  const actorType = adminActorType(required.principal);
  const actorId = adminActorId(required.principal);
  const browserId = typeof required.body.browserId === 'string' && required.body.browserId.trim() ? required.body.browserId.trim() : makeUuid(env);
  const browser = await new D1RemoteBrowserSessionStore(required.db).createOpening({
    id: makeUuid(env),
    browserSessionId: browserId,
    deviceId: required.deviceId,
    serverId,
    actorType,
    actorId,
    openedAt: now,
    rootPath,
  });
  const commandId = makeUuid(env);
  const commands = new D1CommandStore(required.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(env),
    commandId,
    deviceId: required.deviceId,
    commandType: 'open_remote_browser',
    actorType,
    actorId,
    payload: { browserId, serverId, rootPath },
    payloadSummary: `Open remote browser ${browserId}`,
    submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(required.deviceId);
  command = await commands.markDispatched(commandId, reqSeq, now);
  await notifyAgentDurableObject(env, required.deviceId, publicCommand(command), now);
  return jsonResponse({
    browserId: browser.browserSessionId,
    deviceId: browser.deviceId,
    serverId: browser.serverId,
    state: browser.state,
    rootPath: browser.rootPath,
    command,
  });
}

const remoteBrowserCommandByPath: Record<string, { commandType: string; requiresPath: boolean; closes?: boolean; updatesCurrentPath?: boolean }> = {
  '/v1/file-ops/remote-browser/list': { commandType: 'list_remote_browser_children', requiresPath: true, updatesCurrentPath: true },
  '/v1/file-ops/remote-browser/stat': { commandType: 'stat_remote_browser_path', requiresPath: true },
  '/v1/file-ops/remote-browser/mkdir': { commandType: 'create_remote_browser_directory', requiresPath: true },
  '/v1/file-ops/remote-browser/delete': { commandType: 'delete_remote_browser_path', requiresPath: true },
  '/v1/file-ops/remote-browser/close': { commandType: 'close_remote_browser', requiresPath: false, closes: true },
};

async function handleRemoteBrowserCommand(request: Request, env: WorkerEnv, routePath: string): Promise<Response> {
  const config = remoteBrowserCommandByPath[routePath];
  const required = await requireAdminDeviceFromBody(request, env);
  if (required instanceof Response) return required;
  const browserId = typeof required.body.browserId === 'string' ? required.body.browserId.trim() : '';
  if (!browserId) return jsonResponse({ error: 'browserId is required' }, { status: 400 });
  const path = typeof required.body.path === 'string' && required.body.path.trim() ? required.body.path.trim() : '';
  if (config.requiresPath && !path) return jsonResponse({ error: 'path is required' }, { status: 400 });
  const store = new D1RemoteBrowserSessionStore(required.db);
  const existing = await store.get(browserId);
  if (!existing || existing.deviceId !== required.deviceId) return jsonResponse({ error: 'Remote browser session not found' }, { status: 404 });
  if (!['opening', 'open'].includes(existing.state)) return jsonResponse({ error: 'Remote browser session is not active' }, { status: 409 });
  const now = new Date(nowMs(env)).toISOString();
  const actorType = adminActorType(required.principal);
  const actorId = adminActorId(required.principal);
  const payload: Record<string, unknown> = { browserId };
  if (path) payload.path = path;
  if (routePath.endsWith('/delete')) payload.recursive = Boolean(required.body.recursive);
  const commands = new D1CommandStore(required.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(env),
    commandId: makeUuid(env),
    deviceId: required.deviceId,
    commandType: config.commandType,
    actorType,
    actorId,
    payload,
    payloadSummary: `${config.commandType} ${browserId}`,
    submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(required.deviceId);
  command = await commands.markDispatched(command.commandId, reqSeq, now);
  await notifyAgentDurableObject(env, required.deviceId, publicCommand(command), now);
  const browser = config.closes
    ? await store.markClosed(browserId, now, 'Admin closed remote browser session')
    : config.updatesCurrentPath
      ? await store.noteActivity(browserId, now, path)
      : await store.noteActivity(browserId, now);
  return jsonResponse({ ok: true, browserId, state: browser.state, command });
}

async function handleStartScpTransfer(request: Request, env: WorkerEnv, direction: 'upload' | 'download'): Promise<Response> {
  const required = await requireAdminDeviceFromBody(request, env);
  if (required instanceof Response) return required;
  const serverId = typeof required.body.serverId === 'string' ? required.body.serverId.trim() : '';
  const localPath = typeof required.body.localPath === 'string' ? required.body.localPath.trim() : '';
  const remotePath = typeof required.body.remotePath === 'string' ? required.body.remotePath.trim() : '';
  if (!serverId) return jsonResponse({ error: 'serverId is required' }, { status: 400 });
  if (!localPath) return jsonResponse({ error: 'localPath is required' }, { status: 400 });
  if (!remotePath) return jsonResponse({ error: 'remotePath is required' }, { status: 400 });
  const now = new Date(nowMs(env)).toISOString();
  const actorType = adminActorType(required.principal);
  const actorId = adminActorId(required.principal);
  const transferId = typeof required.body.transferId === 'string' && required.body.transferId.trim() ? required.body.transferId.trim() : makeUuid(env);
  const transfer = await new D1FileTransferStore(required.db).create({
    id: makeUuid(env),
    transferId,
    deviceId: required.deviceId,
    serverId,
    direction,
    actorType,
    actorId,
    localPath,
    remotePath,
    recursive: Boolean(required.body.recursive),
    ts: now,
  });
  const commandId = makeUuid(env);
  const commandType = direction === 'upload' ? 'start_scp_upload' : 'start_scp_download';
  const payload = { transferId, serverId, localPath, remotePath, recursive: Boolean(required.body.recursive) };
  const commands = new D1CommandStore(required.db);
  let command = await commands.createQueuedCommand({
    id: commandId,
    commandId,
    deviceId: required.deviceId,
    commandType,
    actorType,
    actorId,
    payload,
    payloadSummary: `${commandType} ${transferId}`,
    submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(required.deviceId);
  command = await commands.markDispatched(commandId, reqSeq, now);
  const updated = await new D1FileTransferStore(required.db).attachCommand(transferId, commandId, reqSeq, now);
  await notifyAgentDurableObject(env, required.deviceId, publicCommand(command), now);
  return jsonResponse(updated ?? transfer);
}

type LogIngestBody = {
  events?: Array<Partial<{ type: string; sessionId: string | null; functionId: string | null; seq: number; ts: string; payload: unknown }>>;
} & Partial<{ type: string; sessionId: string | null; functionId: string | null; seq: number; ts: string; payload: unknown }>;

function normalizeIngestEvents(body: LogIngestBody): Array<Partial<{ type: string; sessionId: string | null; functionId: string | null; seq: number; ts: string; payload: unknown }>> {
  if (Array.isArray(body.events)) return body.events;
  if (body.type) return [body];
  return [];
}

async function decompressGzipBody(request: Request): Promise<string> {
  const encoding = request.headers.get('content-encoding')?.toLowerCase();
  if (encoding !== 'gzip') {
    return request.text();
  }
  const raw = await request.arrayBuffer();
  if (typeof DecompressionStream === 'undefined') {
    // Fallback: try to parse as plain text (Cloudflare Workers auto-decompress in some cases)
    return new TextDecoder().decode(raw);
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(raw));
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(result);
}

async function handleIngestLogs(request: Request, env: WorkerEnv): Promise<Response> {
  // Authenticate as agent (bearer token)
  const auth = await authenticateAgentRequest(request, env);
  if (auth instanceof Response) return auth;

  // Rate limiting
  const now = typeof env.now === 'function' ? env.now : () => Date.now();
  const rateLimits = new D1RateLimitStore(auth.db, { now });
  await rateLimits.initialize();
  const clientId = getClientId(request);
  const limit = await rateLimits.checkDetailed(`ingest:${auth.device.id}:${clientId}`, 600, 60 * 1000);
  if (limit.ok === false) {
    const retryAfterMs = limit.retryAfterMs;
    return jsonResponse(
      { type: 'nack', payload: { code: 'rate_limited', rate_limited: true, retryAfterMs } },
      {
        status: 429,
        headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
      },
    );
  }

  // Parse body (with optional gzip decompression)
  let body: LogIngestBody;
  try {
    const text = await decompressGzipBody(request);
    const parsed = JSON.parse(text);
    body = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    body = {};
  }

  const incoming = normalizeIngestEvents(body);
  if (!incoming.length) {
    return jsonResponse({ error: 'events payload is required' }, { status: 400 });
  }

  const nowIso = new Date(now()).toISOString();
  const logStore = new D1LogStore(auth.db);
  let lastSeq: number | null = null;

  for (let i = 0; i < incoming.length; i++) {
    const event = incoming[i];
    const seq = typeof event.seq === 'number' ? event.seq : now() + i;
    await logStore.append({
      id: makeUuid(env),
      deviceId: auth.device.id,
      type: event.type ?? 'unknown',
      sessionId: event.sessionId ?? null,
      functionId: event.functionId ?? null,
      seq,
      ts: event.ts || nowIso,
      payload: event.payload ?? null,
    });
    lastSeq = seq;
  }

  return jsonResponse({
    accepted: incoming.length,
    deviceId: auth.device.id,
    lastSeq,
  });
}

async function handleListLogs(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'), ['logs:read']);
  if (required instanceof Response) return required;
  const limit = clampNumber(url.searchParams.get('limit'), 100, 1, 1000);
  const logs = await new D1LogStore(required.db).listByDevice(required.deviceId, limit, resolveLogFilter(url));
  return jsonResponse(logs);
}

async function handleExportLogs(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'), ['logs:export']);
  if (required instanceof Response) return required;
  const limit = clampNumber(url.searchParams.get('limit'), 5000, 1, 50000);
  const filter = resolveLogFilter(url);
  const logs = await new D1LogStore(required.db).listByDevice(required.deviceId, limit, filter);
  const safeDeviceId = required.deviceId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const exportedAt = new Date(typeof env.now === 'function' ? env.now() : Date.now()).toISOString();
  return jsonResponse({
    fileName: `cc-logs-${safeDeviceId}-${exportedAt.replace(/[:.]/g, '-')}.json`,
    exportedAt,
    deviceId: required.deviceId,
    filter,
    count: logs.length,
    logs,
  });
}

async function handleDeviceSummary(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'));
  if (required instanceof Response) return required;
  return jsonResponse(await new D1LogStore(required.db).getDeviceRuntimeSummary(required.deviceId));
}

async function handleLogSettings(request: Request, env: WorkerEnv): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['logs:read']);
  if (auth instanceof Response) return auth;
  return jsonResponse(new D1LogStore(auth.db).getRetentionSettings());
}

async function handleTelemetry(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['logs:read']);
  if (auth instanceof Response) return auth;
  const db = auth.db;
  const deviceId = url.searchParams.get('deviceId')?.trim() || undefined;
  if (deviceId && !(await new D1DeviceStore(db).getDevice(deviceId))) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  const filter = {
    ...resolveLogFilter(url),
    deviceId,
    fromTs: url.searchParams.get('fromTs')?.trim() || undefined,
    toTs: url.searchParams.get('toTs')?.trim() || undefined,
  };
  const limit = clampNumber(url.searchParams.get('limit'), 500, 1, 5000);
  const logStore = new D1LogStore(db);
  const events = await logStore.listAll(limit, filter);
  const stats = await logStore.getTelemetryTypeStats(filter);
  return jsonResponse({ events, stats, filter, count: events.length });
}

async function handleEnroll(request: Request, env: WorkerEnv): Promise<Response> {
  if (!env.CC_DB || typeof (env.CC_DB as any).prepare !== 'function') {
    return jsonResponse({ error: 'D1_NOT_CONFIGURED' }, { status: 500 });
  }

  const now = typeof env.now === 'function' ? env.now : () => Date.now();
  const rateLimits = new D1RateLimitStore(env.CC_DB as any, { now });
  await rateLimits.initialize();
  const limit = await rateLimits.checkDetailed(`enroll:${getClientId(request)}`, 20, 5 * 60 * 1000);
  if (limit.ok === false) {
    const retryAfterMs = limit.retryAfterMs;
    return jsonResponse(
      { error: 'RATE_LIMITED', rate_limited: true, retryAfterMs },
      {
        status: 429,
        headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
      },
    );
  }

  const body = await parseJsonBody(request);
  const bootstrapToken = typeof body.bootstrapToken === 'string' ? body.bootstrapToken : '';
  if (!bootstrapToken || bootstrapToken !== env.CC_BOOTSTRAP_TOKEN) {
    return jsonResponse({ error: 'BOOTSTRAP_TOKEN_INVALID' }, { status: 401 });
  }

  const deviceId = makeUuid(env);
  const agentToken = makeUuid(env);
  const requestedName = typeof body.deviceName === 'string' ? body.deviceName.trim() : '';
  const deviceName = requestedName || `device-${deviceId.substring(0, 8)}`;
  const nowIso = new Date(now()).toISOString();

  const devices = new D1DeviceStore(env.CC_DB as any);
  const device = await devices.addDevice({
    id: deviceId,
    name: deviceName,
    lastSeenAt: nowIso,
    status: 'disconnected',
    agentToken,
  });

  return jsonResponse({ deviceId: device.id, ccAgentToken: agentToken, deviceName: device.name }, { status: 201 });
}




function formatAdminApiToken(record: Awaited<ReturnType<D1AdminApiTokenStore['createToken']>> | Awaited<ReturnType<D1AdminApiTokenStore['listTokens']>>[number]) {
  return {
    ...record,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt).toISOString() : null,
    revokedAt: record.revokedAt ? new Date(record.revokedAt).toISOString() : null,
  };
}

async function handleListApiTokens(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdmin(request, env);
  if (required instanceof Response) return required;
  const tokens = await new D1AdminApiTokenStore(required.db, { now: () => nowMs(env) }).listTokens();
  return jsonResponse(tokens.map(formatAdminApiToken));
}

async function handleCreateApiToken(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminBody(request, env);
  if (required instanceof Response) return required;
  const label = typeof required.body.label === 'string' ? required.body.label.trim() : '';
  if (!label) return jsonResponse({ error: 'label is required' }, { status: 400 });
  const rawScopes = Array.isArray(required.body.scopes) ? required.body.scopes : typeof required.body.scopes === 'string' ? [required.body.scopes] : [];
  const token = await new D1AdminApiTokenStore(required.db, { now: () => nowMs(env) }).createToken({
    label,
    scopes: rawScopes as WorkerAdminApiTokenScope[],
    ttlDays: Number(required.body.ttlDays),
  });
  await new D1AdminAuditStore(required.db).log('TOKEN_CREATE', 'admin', { label: token.label, tokenId: token.tokenId }, nowMs(env));
  return jsonResponse(formatAdminApiToken(token));
}

async function handleRevokeApiToken(request: Request, env: WorkerEnv, tokenId: string): Promise<Response> {
  const required = await requireAdminBody(request, env);
  if (required instanceof Response) return required;
  const revoked = await new D1AdminApiTokenStore(required.db, { now: () => nowMs(env) }).revokeToken(tokenId);
  if (!revoked) return jsonResponse({ error: 'Token not found' }, { status: 404 });
  await new D1AdminAuditStore(required.db).log('TOKEN_REVOKE', 'admin', { label: revoked.label, tokenId: revoked.tokenId }, nowMs(env));
  return jsonResponse({ tokenId: revoked.tokenId, revokedAt: revoked.revokedAt ? new Date(revoked.revokedAt).toISOString() : null });
}

async function handleTotpStatus(request: Request, env: WorkerEnv): Promise<Response> {
  if (!(await isAdminAuthorized(request, env))) return jsonResponse({ error: 'ADMIN_API_AUTH_FAILED' }, { status: 401 });
  const db = requireD1(env);
  if (db instanceof Response) return db;
  return jsonResponse({ enabled: await totpStore(db, env).isEnabled() });
}

async function handleTotpSetup(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminBody(request, env);
  if (required instanceof Response) return required;
  return jsonResponse(await totpStore(required.db, env).generateSetup());
}

async function handleTotpVerifySetup(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminBody(request, env);
  if (required instanceof Response) return required;
  const totpCode = typeof required.body.totpCode === 'string' ? required.body.totpCode.trim() : '';
  if (!totpCode) return jsonResponse({ error: 'totpCode is required' }, { status: 400 });
  const ok = await totpStore(required.db, env).verifyAndEnable(totpCode);
  if (!ok) return jsonResponse({ error: 'Invalid TOTP code' }, { status: 400 });
  return jsonResponse({ enabled: true });
}

async function handleTotpDisable(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminBody(request, env);
  if (required instanceof Response) return required;
  const totpCode = typeof required.body.totpCode === 'string' ? required.body.totpCode.trim() : '';
  if (!totpCode) return jsonResponse({ error: 'totpCode is required' }, { status: 400 });
  const ok = await totpStore(required.db, env).disable(totpCode);
  if (!ok) return jsonResponse({ error: 'Invalid TOTP code' }, { status: 400 });
  return jsonResponse({ enabled: false });
}

async function handleTotpRecoveryCodes(request: Request, env: WorkerEnv): Promise<Response> {
  if (!(await isAdminAuthorized(request, env))) return jsonResponse({ error: 'ADMIN_API_AUTH_FAILED' }, { status: 401 });
  const db = requireD1(env);
  if (db instanceof Response) return db;
  return jsonResponse({ codes: totpStore(db, env).getRecoveryCodes() });
}

async function handleTotpRegenerateRecoveryCodes(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminBody(request, env);
  if (required instanceof Response) return required;
  return jsonResponse({ codes: await totpStore(required.db, env).regenerateRecoveryCodes() });
}

async function handleAdminLogin(request: Request, env: WorkerEnv): Promise<Response> {
  const db = requireD1(env);
  if (db instanceof Response) return db;
  const body = await parseRequestFields(request);
  const password = typeof body.password === 'string' ? body.password : '';
  const next = typeof body.next === 'string' ? body.next : new URL(request.url).searchParams.get('next') || '/';

  const isJson = (request.headers.get('accept') || '').includes('application/json') || (request.headers.get('content-type') || '').includes('application/json');

  const audit = new D1AdminAuditStore(db);
  const ip = getClientId(request);
  const userAgent = request.headers.get('user-agent') ?? undefined;

  if (!env.CC_ADMIN_PASSWORD || password !== env.CC_ADMIN_PASSWORD) {
    await audit.log('LOGIN_FAILED', 'admin', { ip, userAgent }, nowMs(env));
    if (isJson) {
      return jsonResponse({ error: 'Invalid password' }, { status: 401 });
    }
    const redirectUrl = new URL('/admin/login', request.url);
    redirectUrl.searchParams.set('error', '1');
    if (next && next !== '/') redirectUrl.searchParams.set('next', next);
    return redirectResponse(redirectUrl.toString());
  }

  await audit.log('LOGIN_SUCCESS', 'admin', { ip, userAgent }, nowMs(env));

  const session = await adminSessionStore(db, env).createSession({
    ip,
    userAgent,
  });
  const headers = new Headers();
  appendCookie(headers, ADMIN_SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: new URL(request.url).protocol === 'https:',
    maxAge: 12 * 60 * 60,
  });
  appendCookie(headers, ADMIN_CSRF_COOKIE, makeCsrfToken(env), {
    sameSite: 'Strict',
    secure: new URL(request.url).protocol === 'https:',
    maxAge: 12 * 60 * 60,
  });

  if (isJson) {
    return jsonResponse({ ok: true, next }, { headers });
  }

  return redirectResponse(next, { headers });
}

async function handleAdminLogout(request: Request, env: WorkerEnv): Promise<Response> {
  const db = requireD1(env);
  if (db instanceof Response) return db;
  const body = await parseRequestFields(request);
  const csrfFailure = requireCsrfForCookieMutation(request, env, body);
  if (csrfFailure) return csrfFailure;
  const sessionToken = parseCookies(request.headers.get('cookie'))[ADMIN_SESSION_COOKIE];
  
  await new D1AdminAuditStore(db).log('LOGOUT', 'admin', { ip: getClientId(request) }, nowMs(env));

  await adminSessionStore(db, env).clear(sessionToken);
  const headers = new Headers();
  appendCookie(headers, ADMIN_SESSION_COOKIE, '', { httpOnly: true, sameSite: 'Strict', maxAge: 0 });
  return redirectResponse('/admin/login', { headers });
}

async function handleListAdminSessions(request: Request, env: WorkerEnv): Promise<Response> {
  if (!(await isAdminAuthorized(request, env))) return jsonResponse({ error: 'ADMIN_API_AUTH_FAILED' }, { status: 401 });
  const db = requireD1(env);
  if (db instanceof Response) return db;
  const sessions = await adminSessionStore(db, env).listSessions();
  return jsonResponse(sessions.map((session) => ({
    tokenHash: session.tokenHash,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    ip: session.ip,
    userAgent: session.userAgent,
  })));
}

async function handleListAdminAudit(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['audit:read']);
  if (auth instanceof Response) return auth;
  const limit = clampNumber(url.searchParams.get('limit'), 100, 1, 1000);
  const event = url.searchParams.get('event')?.trim() || undefined;
  const actor = url.searchParams.get('actor')?.trim() || undefined;
  const logs = await new D1AdminAuditStore(auth.db).list({ limit, event, actor });
  return jsonResponse(logs);
}

async function fetch(request: Request, env: WorkerEnv = {}, _ctx?: WorkerExecutionContext): Promise<Response> {
  const url = new URL(request.url);


  if (request.method === 'POST' && url.pathname === '/internal/pty-fanout') {
    return handleInternalPtyFanout(request, env);
  }




  if (url.pathname === '/agent/protocol') {
    return handleAgentProtocolProbe(request, env);
  }

  if (url.pathname === '/agent') {
    // WebSocket upgrades must be handled before GET long-poll fallback.
    if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
      return handleAgentWebSocket(request, env);
    }
    if (request.headers.get('accept')?.includes('text/event-stream')) {
      return handleAgentWebSocket(request, env);
    }
    // Long-polling GET remains as a compatibility fallback for older agents.
    if (request.method === 'GET') {
      return handleAgentLongPoll(request, env);
    }
    // POST heartbeat/telemetry polling compatibility path.
    return handleAgentWebSocket(request, env);
  }

  if (url.pathname === '/admin/ws/pty') {
    return handleAdminPtyUpgrade(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/admin/api-tokens') {
    return handleListApiTokens(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/api-tokens') {
    return handleCreateApiToken(request, env);
  }
  const apiTokenRevokeMatch = url.pathname.match(/^\/admin\/api-tokens\/([^/]+)\/revoke$/);
  if (apiTokenRevokeMatch && request.method === 'POST') {
    return handleRevokeApiToken(request, env, decodeURIComponent(apiTokenRevokeMatch[1]));
  }

  if (request.method === 'GET' && url.pathname === '/admin/totp/status') {
    return handleTotpStatus(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/totp/setup') {
    return handleTotpSetup(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/totp/verify-setup') {
    return handleTotpVerifySetup(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/totp/disable') {
    return handleTotpDisable(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/admin/totp/recovery-codes') {
    return handleTotpRecoveryCodes(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/totp/regenerate-recovery-codes') {
    return handleTotpRegenerateRecoveryCodes(request, env);
  }

  if (request.method === 'POST' && url.pathname === '/admin/login') {
    return handleAdminLogin(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/logout') {
    return handleAdminLogout(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/admin/sessions') {
    return handleListAdminSessions(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/admin/audit-log') {
    return handleListAdminAudit(request, env, url);
  }

  if (request.method === 'GET' && url.pathname === '/v1/health') {
    return jsonResponse({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  }



  if (request.method === 'GET' && url.pathname === '/v1/file-transfers/stream') {
    return handleTransfersStream(request, env, url);
  }
  if (request.method === 'GET' && url.pathname === '/v1/file-transfers') {
    return handleListFileTransfers(request, env, url);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/dismiss') {
    return handleDismissFileTransfer(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/stop') {
    return handleStopFileTransfer(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/force-remove') {
    return handleForceRemoveFileTransfer(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/dismiss-finished') {
    return handleDismissFinishedFileTransfers(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-ops/remote-browser/open') {
    return handleOpenRemoteBrowser(request, env);
  }
  if (request.method === 'POST' && remoteBrowserCommandByPath[url.pathname]) {
    return handleRemoteBrowserCommand(request, env, url.pathname);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/upload') {
    return handleStartScpTransfer(request, env, 'upload');
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/download') {
    return handleStartScpTransfer(request, env, 'download');
  }

  if (request.method === 'GET' && url.pathname === '/v1/commands') {
    return handleListCommands(request, env, url);
  }
  if (request.method === 'GET' && url.pathname === '/v1/commands/stream') {
    return handleCommandsStream(request, env, url);
  }

  const commandAuditMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)\/audit$/);
  if (commandAuditMatch && request.method === 'GET') {
    return handleListCommandAudit(request, env, decodeURIComponent(commandAuditMatch[1]));
  }

  const commandMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)$/);
  if (commandMatch && request.method === 'GET') {
    return handleGetCommand(request, env, decodeURIComponent(commandMatch[1]));
  }

  if (request.method === 'GET' && url.pathname === '/v1/logs/stream') {
    return handleTelemetryStream(request, env, url);
  }
  if (request.method === 'POST' && url.pathname === '/v1/logs') {
    return handleIngestLogs(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/v1/logs') {
    return handleListLogs(request, env, url);
  }
  if (request.method === 'GET' && url.pathname === '/v1/logs/export') {
    return handleExportLogs(request, env, url);
  }
  if (request.method === 'GET' && url.pathname === '/v1/device-summary') {
    return handleDeviceSummary(request, env, url);
  }
  if (request.method === 'GET' && url.pathname === '/v1/log-settings') {
    return handleLogSettings(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/v1/telemetry') {
    return handleTelemetry(request, env, url);
  }

  const ptySessionsMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/pty-sessions$/);
  if (ptySessionsMatch && request.method === 'GET') {
    return handleListPtySessions(request, env, decodeURIComponent(ptySessionsMatch[1]), url);
  }
  const tunnelLogsMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/tunnels\/([^/]+)\/logs$/);
  if (tunnelLogsMatch && request.method === 'GET') {
    return handleTunnelLogs(
      request,
      env,
      decodeURIComponent(tunnelLogsMatch[1]),
      decodeURIComponent(tunnelLogsMatch[2]),
      url,
    );
  }


  const genericDeviceCommandMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/(request-status-snapshot|request-inventory|request-recent-logs|request-restart-boundary-auth|request-start-server-tunnel|request-restart-server-tunnel)$/);
  if (genericDeviceCommandMatch && request.method === 'POST') {
    const commandTypeByPath: Record<string, string> = {
      'request-status-snapshot': 'request_status_snapshot',
      'request-inventory': 'request_inventory',
      'request-recent-logs': 'request_recent_logs',
      'request-restart-boundary-auth': 'restart_boundary_auth',
      'request-start-server-tunnel': 'start_server_tunnel',
      'request-restart-server-tunnel': 'restart_server_tunnel',
    };
    return dispatchGenericAgentCommand(request, env, decodeURIComponent(genericDeviceCommandMatch[1]), commandTypeByPath[genericDeviceCommandMatch[2]]);
  }

  if (request.method === 'GET' && url.pathname === '/v1/devices/stream') {
    return handleDevicesStream(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/v1/devices') {
    return handleListDevices(request, env);
  }

  const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
  if (deviceMatch && request.method === 'GET') {
    return handleGetDevice(request, env, decodeURIComponent(deviceMatch[1]));
  }
  if (deviceMatch && request.method === 'DELETE') {
    return handleDeleteDevice(request, env, decodeURIComponent(deviceMatch[1]));
  }

  const startServerSshMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/request-start-server-ssh$/);
  if (startServerSshMatch && request.method === 'POST') {
    return handleStartServerSshCommand(request, env, decodeURIComponent(startServerSshMatch[1]));
  }
  const attachServerSshMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/request-attach-server-ssh$/);
  if (attachServerSshMatch && request.method === 'POST') {
    return handleAttachServerSshCommand(request, env, decodeURIComponent(attachServerSshMatch[1]));
  }

  if (request.method === 'POST' && url.pathname === '/v1/revoke') {
    return handleRevokeDevice(request, env);
  }

  if (request.method === 'POST' && url.pathname === '/v1/enroll') {
    return handleEnroll(request, env);
  }

  return jsonResponse({ error: 'not_found' }, { status: 404 });
}

async function safeFetch(request: Request, env: WorkerEnv = {}, ctx?: WorkerExecutionContext): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const requestId = request.headers.get('x-request-id')
    || request.headers.get('cf-ray')
    || `req-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const baseLog = {
    requestId,
    method: request.method,
    path: url.pathname,
  };
  const slowLogMs = Math.max(100, Number(env.requestSlowLogMs) || 5000);
  const slowTimer = setTimeout(() => {
    console.warn('Worker request still running', {
      ...baseLog,
      elapsedMs: Date.now() - startedAt,
      query: url.search || undefined,
    });
  }, slowLogMs);

  console.info('Worker request started', baseLog);
  try {
    const response = await fetch(request, env, ctx);
    try {
      response.headers.set('x-request-id', requestId);
    } catch {
      // Some runtime-created upgrade responses may have immutable headers.
    }
    console.info('Worker request completed', {
      ...baseLog,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
    });
    return response;
  } catch (err) {
    console.error('Worker request failed', {
      ...baseLog,
      elapsedMs: Date.now() - startedAt,
      error: String(err),
    });
    return jsonResponse(
      { error: 'INTERNAL_ERROR', details: String(err), requestId },
      { status: 500, headers: { 'x-request-id': requestId } },
    );
  } finally {
    clearTimeout(slowTimer);
  }
}


export class AgentConnectionDurableObject {
  constructor(private readonly state: DurableObjectStateLike, private readonly env: WorkerEnv) {}

  async fetch(request: Request): Promise<Response> {
    try {
      return await this._fetch(request);
    } catch (err) {
      console.error('Agent Durable Object fetch error:', err);
      return jsonResponse({ error: 'INTERNAL_ERROR', details: String(err) }, { status: 500 });
    }
  }

  private async _fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/dispatch') {
      const envelope = await parseJsonBody(request);
      const sockets = this.state.getWebSockets?.() ?? [];
      const message = JSON.stringify(envelope);
      let delivered = 0;
      for (const socket of sockets) {
        if (safeWebSocketSend(socket, message)) {
          delivered += 1;
        }
      }
      return jsonResponse({ delivered, sockets: sockets.length });
    }

    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
      return jsonResponse({ error: 'WEBSOCKET_UPGRADE_REQUIRED' }, { status: 426 });
    }

    const auth = await authenticateAgentRequest(request, this.env);
    if (auth instanceof Response) return auth;

    const WebSocketPairCtor = (globalThis as any).WebSocketPair;
    if (typeof WebSocketPairCtor !== 'function') {
      return jsonResponse({ error: 'WEBSOCKET_PAIR_UNAVAILABLE' }, { status: 501 });
    }

    const pair = new WebSocketPairCtor();
    const client = pair[0] as WebSocket;
    const server = pair[1] as WebSocket;
    if (typeof this.state.acceptWebSocket === 'function') {
      this.state.acceptWebSocket(server, [auth.device.id]);
      (server as any).serializeAttachment?.({ deviceId: auth.device.id });
    } else {
      (server as any).accept?.();
    }

    await new D1DeviceStore(auth.db).updateDeviceStatus(auth.device.id, 'connected', new Date(nowMs(this.env)).toISOString());
    safeWebSocketSend(server, JSON.stringify({ type: 'welcome', payload: { deviceId: auth.device.id, protocol: 'scp.cc.v1', transport: 'durable-object-websocket' } }));
    const wsHeaders = applySecurityHeaders(new Headers());
    return new Response(null, { status: 101, headers: wsHeaders, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      let envelope: Record<string, any> = {};
      try {
        envelope = JSON.parse(text || '{}');
      } catch {
        return;
      }
      const attachment = (socket as any).deserializeAttachment?.();
      const deviceId = typeof attachment?.deviceId === 'string'
        ? attachment.deviceId
        : (typeof envelope.deviceId === 'string' ? envelope.deviceId : '');
      if (!deviceId) return;
      const db = requireD1(this.env);
      if (db instanceof Response) return;
      await handleAgentSocketMessage(db, this.env, deviceId, socket, text);
    } catch (err) {
      console.error('Agent Durable Object webSocketMessage error:', err);
    }
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const attachment = (socket as any).deserializeAttachment?.();
    if (attachment?.deviceId) {
      try {
        const db = requireD1(this.env);
        if (!(db instanceof Response)) {
          await new D1DeviceStore(db).updateDeviceStatus(attachment.deviceId, 'disconnected', new Date(nowMs(this.env)).toISOString());
        }
      } catch (err) {
        console.error('Agent Durable Object webSocketClose status update failed:', err);
      }
    }
  }
  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    const attachment = (socket as any).deserializeAttachment?.();
    if (attachment?.deviceId) {
      try {
        const db = requireD1(this.env);
        if (!(db instanceof Response)) {
          await new D1DeviceStore(db).updateDeviceStatus(
            attachment.deviceId,
            'disconnected',
            new Date(nowMs(this.env)).toISOString(),
          );
        }
      } catch (err) {
        console.warn('Agent Durable Object webSocketError status update failed:', err);
      }
    }
    console.warn('Agent Durable Object WebSocket disconnected:', String(error));
  }
}

export default { fetch: safeFetch };
