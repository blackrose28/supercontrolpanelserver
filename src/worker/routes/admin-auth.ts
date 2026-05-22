import type { WorkerEnv } from '../types';
import { D1AdminApiTokenStore, WorkerAdminApiTokenScope } from '../db/d1-admin-api-token-store';
import { D1AdminAuditStore } from '../db/d1-admin-audit-store';
import { D1RateLimitStore } from '../db/d1-rate-totp-store';
import { D1DeviceStore } from '../db/d1-device-store';
import { nowMs, makeUuid, requireD1 } from '../env-helpers';
import {
  jsonResponse,
  redirectResponse,
  parseCookies,
  appendCookie,
  parseRequestFields,
  parseJsonBody,
  getClientId,
  clampNumber,
  ADMIN_SESSION_COOKIE,
  ADMIN_CSRF_COOKIE,
} from '../http';
import {
  requireAdmin,
  requireAdminBody,
  requireAdminAuth,
  isAdminAuthorized,
  adminSessionStore,
  totpStore,
  makeCsrfToken,
  requireCsrfForCookieMutation,
} from '../auth';

function formatAdminApiToken(record: Awaited<ReturnType<D1AdminApiTokenStore['createToken']>> | Awaited<ReturnType<D1AdminApiTokenStore['listTokens']>>[number]) {
  return {
    ...record,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt).toISOString() : null,
    revokedAt: record.revokedAt ? new Date(record.revokedAt).toISOString() : null,
  };
}

export async function handleListApiTokens(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdmin(request, env);
  if (required instanceof Response) return required;
  const tokens = await new D1AdminApiTokenStore(required.db, { now: () => nowMs(env) }).listTokens();
  return jsonResponse(tokens.map(formatAdminApiToken));
}

export async function handleCreateApiToken(request: Request, env: WorkerEnv): Promise<Response> {
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

export async function handleRevokeApiToken(request: Request, env: WorkerEnv, tokenId: string): Promise<Response> {
  const required = await requireAdminBody(request, env);
  if (required instanceof Response) return required;
  const revoked = await new D1AdminApiTokenStore(required.db, { now: () => nowMs(env) }).revokeToken(tokenId);
  if (!revoked) return jsonResponse({ error: 'Token not found' }, { status: 404 });
  await new D1AdminAuditStore(required.db).log('TOKEN_REVOKE', 'admin', { label: revoked.label, tokenId: revoked.tokenId }, nowMs(env));
  return jsonResponse({ tokenId: revoked.tokenId, revokedAt: revoked.revokedAt ? new Date(revoked.revokedAt).toISOString() : null });
}

export async function handleTotpStatus(request: Request, env: WorkerEnv): Promise<Response> {
  if (!(await isAdminAuthorized(request, env))) return jsonResponse({ error: 'ADMIN_API_AUTH_FAILED' }, { status: 401 });
  const db = requireD1(env);
  if (db instanceof Response) return db;
  return jsonResponse({ enabled: await totpStore(db, env).isEnabled() });
}

export async function handleTotpSetup(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminBody(request, env);
  if (required instanceof Response) return required;
  return jsonResponse(await totpStore(required.db, env).generateSetup());
}

export async function handleTotpVerifySetup(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminBody(request, env);
  if (required instanceof Response) return required;
  const totpCode = typeof required.body.totpCode === 'string' ? required.body.totpCode.trim() : '';
  if (!totpCode) return jsonResponse({ error: 'totpCode is required' }, { status: 400 });
  const ok = await totpStore(required.db, env).verifyAndEnable(totpCode);
  if (!ok) return jsonResponse({ error: 'Invalid TOTP code' }, { status: 400 });
  return jsonResponse({ enabled: true });
}

export async function handleTotpDisable(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminBody(request, env);
  if (required instanceof Response) return required;
  const totpCode = typeof required.body.totpCode === 'string' ? required.body.totpCode.trim() : '';
  if (!totpCode) return jsonResponse({ error: 'totpCode is required' }, { status: 400 });
  const ok = await totpStore(required.db, env).disable(totpCode);
  if (!ok) return jsonResponse({ error: 'Invalid TOTP code' }, { status: 400 });
  return jsonResponse({ enabled: false });
}

export async function handleTotpRecoveryCodes(request: Request, env: WorkerEnv): Promise<Response> {
  if (!(await isAdminAuthorized(request, env))) return jsonResponse({ error: 'ADMIN_API_AUTH_FAILED' }, { status: 401 });
  const db = requireD1(env);
  if (db instanceof Response) return db;
  return jsonResponse({ codes: totpStore(db, env).getRecoveryCodes() });
}

export async function handleTotpRegenerateRecoveryCodes(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminBody(request, env);
  if (required instanceof Response) return required;
  return jsonResponse({ codes: await totpStore(required.db, env).regenerateRecoveryCodes() });
}

export async function handleAdminLogin(request: Request, env: WorkerEnv): Promise<Response> {
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
    if (isJson) return jsonResponse({ error: 'Invalid password' }, { status: 401 });
    const redirectUrl = new URL('/admin/login', request.url);
    redirectUrl.searchParams.set('error', '1');
    if (next && next !== '/') redirectUrl.searchParams.set('next', next);
    return redirectResponse(redirectUrl.toString());
  }
  await audit.log('LOGIN_SUCCESS', 'admin', { ip, userAgent }, nowMs(env));
  const session = await adminSessionStore(db, env).createSession({ ip, userAgent });
  const headers = new Headers();
  appendCookie(headers, ADMIN_SESSION_COOKIE, session, {
    httpOnly: true, sameSite: 'Strict',
    secure: new URL(request.url).protocol === 'https:', maxAge: 12 * 60 * 60,
  });
  appendCookie(headers, ADMIN_CSRF_COOKIE, makeCsrfToken(env), {
    sameSite: 'Strict',
    secure: new URL(request.url).protocol === 'https:', maxAge: 12 * 60 * 60,
  });
  if (isJson) return jsonResponse({ ok: true, next }, { headers });
  return redirectResponse(next, { headers });
}

export async function handleAdminLogout(request: Request, env: WorkerEnv): Promise<Response> {
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

export async function handleListAdminSessions(request: Request, env: WorkerEnv): Promise<Response> {
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

export async function handleListAdminAudit(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['audit:read']);
  if (auth instanceof Response) return auth;
  const limit = clampNumber(url.searchParams.get('limit'), 100, 1, 1000);
  const event = url.searchParams.get('event')?.trim() || undefined;
  const actor = url.searchParams.get('actor')?.trim() || undefined;
  const logs = await new D1AdminAuditStore(auth.db).list({ limit, event, actor });
  return jsonResponse(logs);
}

export async function handleEnroll(request: Request, env: WorkerEnv): Promise<Response> {
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
      { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } },
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
    id: deviceId, name: deviceName, lastSeenAt: nowIso,
    status: 'disconnected', agentToken,
  });
  return jsonResponse({ deviceId: device.id, ccAgentToken: agentToken, deviceName: device.name }, { status: 201 });
}
