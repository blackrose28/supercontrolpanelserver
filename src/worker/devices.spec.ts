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

type TestEnv = { CC_DB: TestD1Database; CC_ADMIN_API_TOKEN: string };

describe('Worker device routes', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createEnv() {
    const db = new TestD1Database();
    databases.push(db);
    const store = new D1DeviceStore(db);
    await store.addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1', os: 'linux' });
    await store.addDevice({ id: 'dev-2', name: 'Two', lastSeenAt: '2026-04-29T00:01:00.000Z', status: 'disconnected', agentToken: 'agent-token-2', os: 'windows' });
    return { CC_DB: db, CC_ADMIN_API_TOKEN: 'admin-token' } satisfies TestEnv;
  }

  function request(path: string, env: TestEnv, init: RequestInit = {}) {
    return worker.fetch(new Request(`https://cc.example.test${path}`, init), env as any);
  }

  function adminHeaders() {
    return { authorization: 'Bearer admin-token' };
  }

  it('lists devices for an authorized admin without exposing agent tokens', async () => {
    const env = await createEnv();

    const response = await request('/v1/devices', env, { headers: adminHeaders() });

    expect(response.status).toBe(200);
    const body = await response.json() as any[];
    expect(body).toEqual([
      { id: 'dev-2', name: 'Two', lastSeenAt: '2026-04-29T00:01:00.000Z', status: 'disconnected', os: 'windows' },
      { id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', os: 'linux' },
    ]);
    expect(JSON.stringify(body)).not.toContain('agentToken');
  });

  it('returns a single device or 404 when missing', async () => {
    const env = await createEnv();

    const found = await request('/v1/devices/dev-1', env, { headers: adminHeaders() });
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toEqual({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', os: 'linux' });

    const missing = await request('/v1/devices/missing', env, { headers: adminHeaders() });
    expect(missing.status).toBe(404);
  });

  it('rejects unauthorized device reads and deletes', async () => {
    const env = await createEnv();

    expect((await request('/v1/devices', env)).status).toBe(401);
    expect((await request('/v1/devices/dev-1', env, { method: 'DELETE' })).status).toBe(401);
  });

  it('deletes devices for an authorized admin', async () => {
    const env = await createEnv();

    const deleted = await request('/v1/devices/dev-1', env, { method: 'DELETE', headers: adminHeaders() });

    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ removed: true });
    expect((await request('/v1/devices/dev-1', env, { headers: adminHeaders() })).status).toBe(404);
  });

  it('revokes a device using its raw agent token', async () => {
    const env = await createEnv();

    const revoked = await request('/v1/revoke', env, { method: 'POST', headers: { authorization: 'Bearer agent-token-2' } });

    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ removed: true });
    expect((await request('/v1/devices/dev-2', env, { headers: adminHeaders() })).status).toBe(404);
  });
});
