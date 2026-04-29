import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import worker from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';
import { D1DeviceStore } from './db/d1-device-store';

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

type TestEnv = { CC_DB: TestD1Database; CC_ADMIN_PASSWORD: string; now: () => number; sessionTokenFactory: () => string };

function cookieHeader(response: Response): string {
  const setCookie = response.headers.get('set-cookie') || '';
  return setCookie
    .split(/,(?=\s*cc_admin_)/)
    .map((cookie) => cookie.trim().split(';')[0])
    .join('; ');
}

function cookieValue(cookie: string, name: string): string {
  const found = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}

describe('Worker admin login sessions', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createEnv() {
    const db = new TestD1Database();
    databases.push(db);
    await new D1DeviceStore(db).addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1' });
    return {
      CC_DB: db,
      CC_ADMIN_PASSWORD: 'correct-password',
      now: () => Date.parse('2026-04-29T00:00:00.000Z'),
      sessionTokenFactory: () => 'session-token-1',
    } satisfies TestEnv;
  }

  function request(path: string, env: TestEnv, init: RequestInit = {}) {
    return worker.fetch(new Request(`https://cc.example.test${path}`, init), env as any);
  }

  it('creates session and csrf cookies after successful form login', async () => {
    const env = await createEnv();

    const response = await request('/admin/login', env, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'vitest' },
      body: new URLSearchParams({ password: 'correct-password' }).toString(),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    const setCookie = response.headers.get('set-cookie') || '';
    expect(setCookie).toContain('cc_admin_session=');
    expect(setCookie).toContain('cc_admin_csrf=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
  });

  it('allows a session cookie to authenticate Worker API routes and list sessions', async () => {
    const env = await createEnv();
    const login = await request('/admin/login', env, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    const cookie = cookieHeader(login);

    const devices = await request('/v1/devices', env, { headers: { cookie } });
    expect(devices.status).toBe(200);
    await expect(devices.json()).resolves.toEqual([{ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected' }]);

    const sessions = await request('/admin/sessions', env, { headers: { cookie } });
    expect(sessions.status).toBe(200);
    const body = await sessions.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ ip: 'unknown', userAgent: null });
    expect(body[0].tokenHash).not.toContain('session-token-1');
  });

  it('rejects invalid login and clears session on logout', async () => {
    const env = await createEnv();

    const badLogin = await request('/admin/login', env, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(badLogin.status).toBe(401);

    const login = await request('/admin/login', env, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    const cookie = cookieHeader(login);

    const logout = await request('/admin/logout', env, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ csrfToken: cookieValue(cookie, 'cc_admin_csrf') }),
    });
    expect(logout.status).toBe(302);
    expect(logout.headers.get('location')).toBe('/admin/login');

    const devices = await request('/v1/devices', env, { headers: { cookie } });
    expect(devices.status).toBe(401);
  });
});
