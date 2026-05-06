import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import worker from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';
import { D1AdminAuditStore } from './db/d1-admin-audit-store';

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

describe('Worker admin audit log', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createEnv() {
    const db = new TestD1Database();
    databases.push(db);
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

  it('lists audit logs when authenticated', async () => {
    const env = await createEnv();
    
    // Seed some data using the store
    const auditStore = new D1AdminAuditStore(env.CC_DB as any);
    await auditStore.log('LOGIN_SUCCESS', 'admin', { ip: '1.2.3.4' }, Date.parse('2026-04-29T00:00:00.000Z'));

    const login = await request('/admin/login', env, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    const cookie = cookieHeader(login);

    const response = await request('/admin/audit-log', env, { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as any[];
    expect(body).toHaveLength(2);
    // body[0] is from the test login
    // body[1] is the seeded one
    expect(body[1]).toMatchObject({
      event: 'LOGIN_SUCCESS',
      actor: 'admin',
      details: { ip: '1.2.3.4' },
      createdAt: Date.parse('2026-04-29T00:00:00.000Z'),
    });
  });

  it('supports limit parameter', async () => {
    const env = await createEnv();
    const db = env.CC_DB.sqlite;
    const stmt = db.prepare('INSERT INTO admin_audit_log (event, actor, details, createdAt) VALUES (?, ?, ?, ?)');
    for (let i = 1; i <= 10; i++) {
      stmt.run(`EVENT_${i}`, 'admin', null, Date.parse('2026-04-29T00:00:00.000Z') + i);
    }

    const login = await request('/admin/login', env, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    const cookie = cookieHeader(login);

    const response = await request('/admin/audit-log?limit=5', env, { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as any[];
    expect(body).toHaveLength(5);
    // body[0] is LOGIN_SUCCESS from the login request in the test
    expect(body[0].event).toBe('LOGIN_SUCCESS');
    expect(body[1].event).toBe('EVENT_10'); 
  });

  it('rejects unauthenticated requests', async () => {
    const env = await createEnv();
    const response = await request('/admin/audit-log', env);
    expect(response.status).toBe(401);
  });
});
