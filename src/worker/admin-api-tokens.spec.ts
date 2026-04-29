import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import worker from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';
import { D1DeviceStore } from './db/d1-device-store';
import { D1LogStore } from './db/d1-log-store';

class TestD1PreparedStatement {
  private params: unknown[] = [];
  constructor(private readonly statement: Database.Statement) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  async run() { const result = this.statement.run(...this.params); return { success: true, changes: result.changes }; }
  async first<T = unknown>() { return (this.statement.get(...this.params) ?? null) as T | null; }
  async all<T = unknown>() { return { results: this.statement.all(...this.params) as T[] }; }
}

class TestD1Database {
  readonly sqlite = new Database(':memory:');
  constructor() { this.sqlite.exec(D1_SCHEMA_SQL); }
  prepare(sql: string) { return new TestD1PreparedStatement(this.sqlite.prepare(sql)); }
  close() { this.sqlite.close(); }
}

type TestEnv = {
  CC_DB: TestD1Database;
  CC_ADMIN_PASSWORD: string;
  now: () => number;
  sessionTokenFactory: () => string;
  csrfTokenFactory: () => string;
};

function extractCookies(response: Response): Record<string, string> {
  const setCookie = response.headers.get('set-cookie') || '';
  return Object.fromEntries(setCookie
    .split(/,(?=\s*cc_admin_)/)
    .map((cookie) => cookie.trim().split(';')[0].split('=').map(decodeURIComponent) as [string, string]));
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; ');
}

describe('Worker admin API token routes and scopes', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createEnv() {
    const db = new TestD1Database();
    let sessionCounter = 0;
    databases.push(db);
    await new D1DeviceStore(db).addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1' });
    await new D1LogStore(db).append({ id: 'log-1', deviceId: 'dev-1', ts: '2026-04-29T00:00:00.000Z', type: 'runtime', functionId: 'openvpn-connect', seq: 1, payload: { ok: true } });
    return {
      CC_DB: db,
      CC_ADMIN_PASSWORD: 'correct-password',
      now: () => Date.parse('2026-04-29T00:00:00.000Z'),
      sessionTokenFactory: () => `session-token-${++sessionCounter}`,
      csrfTokenFactory: () => 'csrf-token-1',
    } satisfies TestEnv;
  }

  function request(path: string, env: TestEnv, init: RequestInit = {}) {
    return worker.fetch(new Request(`https://cc.example.test${path}`, init), env as any);
  }

  async function login(env: TestEnv) {
    const response = await request('/admin/login', env, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct-password' }) });
    const cookies = extractCookies(response);
    return { cookie: cookieHeader(cookies), csrfToken: cookies.cc_admin_csrf };
  }

  async function createToken(env: TestEnv, scopes: string[]) {
    const { cookie, csrfToken } = await login(env);
    const response = await request('/admin/api-tokens', env, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ csrfToken, label: 'Ops', scopes, ttlDays: 30 }),
    });
    expect(response.status).toBe(200);
    return { ...(await response.json() as any), cookie, csrfToken };
  }

  it('creates, lists, and revokes admin API tokens with session csrf', async () => {
    const env = await createEnv();
    const created = await createToken(env, ['device:read', 'logs:read']);

    expect(created.token).toMatch(/^ccadm_/);
    expect(created).toMatchObject({ label: 'Ops', scopes: ['device:read', 'logs:read'] });

    const list = await request('/admin/api-tokens', env, { headers: { cookie: created.cookie } });
    expect(list.status).toBe(200);
    const tokens = await list.json() as any[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ tokenId: created.tokenId, label: 'Ops', scopes: ['device:read', 'logs:read'] });
    expect(tokens[0].token).toBeUndefined();

    const revoke = await request(`/admin/api-tokens/${created.tokenId}/revoke`, env, { method: 'POST', headers: { cookie: created.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ csrfToken: created.csrfToken }) });
    expect(revoke.status).toBe(200);
    await expect(revoke.json()).resolves.toMatchObject({ tokenId: created.tokenId });

    const afterRevoke = await request('/v1/devices', env, { headers: { authorization: `Bearer ${created.token}` } });
    expect(afterRevoke.status).toBe(401);
  });

  it('enforces db token scopes on read/control/export routes', async () => {
    const env = await createEnv();
    const readOnly = await createToken(env, ['device:read', 'logs:read']);
    const readHeaders = { authorization: `Bearer ${readOnly.token}` };

    expect((await request('/v1/devices', env, { headers: readHeaders })).status).toBe(200);
    expect((await request('/v1/logs?deviceId=dev-1', env, { headers: readHeaders })).status).toBe(200);
    expect((await request('/v1/logs/export?deviceId=dev-1', env, { headers: readHeaders })).status).toBe(403);
    expect((await request('/v1/devices/dev-1', env, { method: 'DELETE', headers: readHeaders })).status).toBe(403);

    const exportToken = await createToken(env, ['logs:export']);
    expect((await request('/v1/logs/export?deviceId=dev-1', env, { headers: { authorization: `Bearer ${exportToken.token}` } })).status).toBe(200);
  });

  it('requires csrf for token mutations', async () => {
    const env = await createEnv();
    const { cookie } = await login(env);

    const missingCsrf = await request('/admin/api-tokens', env, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Nope', scopes: ['device:read'] }) });
    expect(missingCsrf.status).toBe(403);
  });
});
