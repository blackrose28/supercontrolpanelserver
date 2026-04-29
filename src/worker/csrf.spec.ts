import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import worker from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';
import { D1DeviceStore } from './db/d1-device-store';
import { D1FileTransferStore } from './db/d1-file-op-store';

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
  CC_ADMIN_API_TOKEN: string;
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

describe('Worker CSRF enforcement', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createEnv() {
    const db = new TestD1Database();
    databases.push(db);
    await new D1DeviceStore(db).addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1' });
    const transfers = new D1FileTransferStore(db);
    await transfers.create({ id: 'row-1', transferId: 'tr-done', deviceId: 'dev-1', serverId: 'srv-1', direction: 'upload', ts: '2026-04-29T00:00:00.000Z' });
    await transfers.markState('tr-done', 'succeeded', '2026-04-29T00:00:01.000Z');
    return {
      CC_DB: db,
      CC_ADMIN_PASSWORD: 'correct-password',
      CC_ADMIN_API_TOKEN: 'admin-token',
      now: () => Date.parse('2026-04-29T00:00:00.000Z'),
      sessionTokenFactory: () => 'session-token-1',
      csrfTokenFactory: () => 'csrf-token-1',
    } satisfies TestEnv;
  }

  async function login(env: TestEnv) {
    const response = await request('/admin/login', env, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    const cookies = extractCookies(response);
    return { cookies, cookie: cookieHeader(cookies), csrfToken: cookies.cc_admin_csrf };
  }

  function request(path: string, env: TestEnv, init: RequestInit = {}) {
    return worker.fetch(new Request(`https://cc.example.test${path}`, init), env as any);
  }

  it('rejects cookie-authenticated mutations without a matching csrfToken', async () => {
    const env = await createEnv();
    const { cookie } = await login(env);

    const missing = await request('/v1/file-transfers/dismiss', env, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-done' }),
    });
    expect(missing.status).toBe(403);

    const mismatch = await request('/v1/file-transfers/dismiss', env, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-done', csrfToken: 'wrong-token' }),
    });
    expect(mismatch.status).toBe(403);
  });

  it('allows cookie-authenticated mutations with a matching csrfToken', async () => {
    const env = await createEnv();
    const { cookie, csrfToken } = await login(env);

    const response = await request('/v1/file-transfers/dismiss', env, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-done', csrfToken }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, transferId: 'tr-done' });
  });

  it('does not require csrfToken for bearer-token mutations', async () => {
    const env = await createEnv();

    const response = await request('/v1/file-transfers/dismiss', env, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-done' }),
    });

    expect(response.status).toBe(200);
  });

  it('requires csrfToken on logout for session cookies', async () => {
    const env = await createEnv();
    const { cookie, csrfToken } = await login(env);

    const missing = await request('/admin/logout', env, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({}) });
    expect(missing.status).toBe(403);

    const ok = await request('/admin/logout', env, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ csrfToken }) });
    expect(ok.status).toBe(302);
  });
});
