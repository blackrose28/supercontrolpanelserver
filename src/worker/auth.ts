import type { WorkerEnv, AdminPrincipal } from './types';
import { D1AdminSessionStore } from './db/d1-admin-session-store';
import { D1AdminApiTokenStore, WorkerAdminApiTokenScope } from './db/d1-admin-api-token-store';
import { D1TotpStore } from './db/d1-rate-totp-store';
import { D1DeviceStore } from './db/d1-device-store';
import { nowMs, makeUuid, requireD1 } from './env-helpers';
import {
  jsonResponse,
  parseCookies,
  parseRequestFields,
  parseJsonBody,
  ADMIN_SESSION_COOKIE,
  ADMIN_CSRF_COOKIE,
} from './http';

export function getBearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

export function hasValidStaticAdminBearer(request: Request, env: WorkerEnv): boolean {
  const token = getBearerToken(request);
  return Boolean(token && env.CC_ADMIN_API_TOKEN && token === env.CC_ADMIN_API_TOKEN);
}

export function csrfTokenFromBody(body: Record<string, unknown>): string {
  return typeof body.csrfToken === 'string' ? body.csrfToken : '';
}

export function requireCsrfForCookieMutation(request: Request, env: WorkerEnv, body: Record<string, unknown>): Response | null {
  if (getBearerToken(request)) return null;
  const cookies = parseCookies(request.headers.get('cookie'));
  const expected = cookies[ADMIN_CSRF_COOKIE];
  const provided = csrfTokenFromBody(body);
  if (!expected || !provided || provided !== expected) {
    return jsonResponse({ error: 'CSRF_INVALID' }, { status: 403 });
  }
  return null;
}

export function hasScopes(principal: AdminPrincipal, requiredScopes: WorkerAdminApiTokenScope[]): boolean {
  if (!requiredScopes.length || principal.kind !== 'db-token') return true;
  return requiredScopes.every((scope) => principal.scopes.includes(scope));
}

export async function authenticateAdmin(request: Request, env: WorkerEnv): Promise<{ db: any; principal: AdminPrincipal } | null> {
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

export async function requireAdminAuth(request: Request, env: WorkerEnv, requiredScopes: WorkerAdminApiTokenScope[] = []): Promise<{ db: any; principal: AdminPrincipal } | Response> {
  const auth = await authenticateAdmin(request, env);
  if (!auth) return jsonResponse({ error: 'ADMIN_API_AUTH_FAILED' }, { status: 401 });
  if (!hasScopes(auth.principal, requiredScopes)) return jsonResponse({ error: 'ADMIN_API_SCOPE_FORBIDDEN' }, { status: 403 });
  return auth;
}

export async function isAdminAuthorized(request: Request, env: WorkerEnv): Promise<boolean> {
  return Boolean(await authenticateAdmin(request, env));
}

export async function requireAdmin(request: Request, env: WorkerEnv, requiredScopes: WorkerAdminApiTokenScope[] = []): Promise<{ db: any } | Response> {
  const auth = await requireAdminAuth(request, env, requiredScopes);
  if (auth instanceof Response) return auth;
  return { db: auth.db };
}

export async function requireAdminBody(request: Request, env: WorkerEnv, requiredScopes: WorkerAdminApiTokenScope[] = []): Promise<{ db: any; body: Record<string, unknown> } | Response> {
  const auth = await requireAdminAuth(request, env, requiredScopes);
  if (auth instanceof Response) return auth;
  const body = await parseRequestFields(request);
  const csrfFailure = requireCsrfForCookieMutation(request, env, body);
  if (csrfFailure) return csrfFailure;
  return { db: auth.db, body };
}

export async function requireAdminAndDevice(request: Request, env: WorkerEnv, deviceId: string | null, requiredScopes: WorkerAdminApiTokenScope[] = []): Promise<{ db: any; deviceId: string; devices: D1DeviceStore } | Response> {
  const auth = await requireAdminAuth(request, env, requiredScopes);
  if (auth instanceof Response) return auth;
  if (!deviceId) return jsonResponse({ error: 'deviceId is required' }, { status: 400 });
  const db = auth.db;
  const devices = new D1DeviceStore(db);
  const device = await devices.getDevice(deviceId);
  if (!device) return jsonResponse({ error: 'Device not found' }, { status: 404 });
  return { db, deviceId, devices };
}

export async function requireAdminDeviceFromBody(request: Request, env: WorkerEnv, requiredScopes: WorkerAdminApiTokenScope[] = []): Promise<{ db: any; deviceId: string; body: Record<string, unknown>; principal: AdminPrincipal } | Response> {
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

export async function authenticateAgentRequest(request: Request, env: WorkerEnv): Promise<{ db: any; device: any } | Response> {
  const token = getBearerToken(request);
  if (!token) return jsonResponse({ error: 'AGENT_AUTH_REQUIRED' }, { status: 401 });
  const db = requireD1(env);
  if (db instanceof Response) return db;
  const device = await new D1DeviceStore(db).findDeviceByAgentToken(token);
  if (!device) return jsonResponse({ error: 'AGENT_AUTH_FAILED' }, { status: 401 });
  return { db, device };
}

export function adminActorType(principal: AdminPrincipal): 'admin_session' | 'admin_api_token' | 'admin_env_token' {
  if (principal.kind === 'db-token') return 'admin_api_token';
  if (principal.kind === 'env-token') return 'admin_env_token';
  return 'admin_session';
}

export function adminActorId(principal: AdminPrincipal): string | null {
  if (principal.kind === 'db-token') return principal.tokenId;
  if (principal.kind === 'env-token') return 'CC_ADMIN_API_TOKEN';
  return null;
}

export function adminSessionStore(db: any, env: WorkerEnv): D1AdminSessionStore {
  return new D1AdminSessionStore(db, { now: () => nowMs(env), tokenFactory: env.sessionTokenFactory });
}

const totpStores = new WeakMap<object, D1TotpStore>();

export function totpStore(db: any, env: WorkerEnv): D1TotpStore {
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

export function makeCsrfToken(env: WorkerEnv): string {
  return typeof env.csrfTokenFactory === 'function' ? env.csrfTokenFactory() : makeUuid(env);
}
