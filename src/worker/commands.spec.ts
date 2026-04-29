import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import worker from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';
import { D1DeviceStore } from './db/d1-device-store';
import { D1CommandStore } from './db/d1-command-store';

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

describe('Worker command query routes', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createEnv() {
    const db = new TestD1Database();
    databases.push(db);
    await new D1DeviceStore(db).addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1' });
    const commands = new D1CommandStore(db);
    await commands.createQueuedCommand({ id: 'row-1', commandId: 'cmd-1', deviceId: 'dev-1', commandType: 'request_status_snapshot', actorType: 'admin_session', actorId: 'admin-1', payload: { token: 'secret', ok: true }, submittedAt: '2026-04-29T00:00:00.000Z' });
    await commands.markDispatched('cmd-1', 7, '2026-04-29T00:00:01.000Z');
    await commands.appendAudit({ id: 'audit-1', commandId: 'cmd-1', ts: '2026-04-29T00:00:01.000Z', eventType: 'dispatched', source: 'worker-test', summary: 'Dispatched', details: { authorization: 'Bearer secret' } });
    await commands.createQueuedCommand({ id: 'row-2', commandId: 'cmd-2', deviceId: 'dev-1', commandType: 'request_inventory', actorType: 'admin_api_token', submittedAt: '2026-04-29T00:01:00.000Z' });
    return { CC_DB: db, CC_ADMIN_API_TOKEN: 'admin-token' } satisfies TestEnv;
  }

  function request(path: string, env: TestEnv, init: RequestInit = {}) {
    return worker.fetch(new Request(`https://cc.example.test${path}`, init), env as any);
  }

  const headers = { authorization: 'Bearer admin-token' };

  it('lists commands with filters', async () => {
    const env = await createEnv();

    const response = await request('/v1/commands?deviceId=dev-1&state=queued&limit=10', env, { headers });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.items.map((cmd: any) => cmd.commandId)).toEqual(['cmd-2']);
  });

  it('returns command detail by commandId', async () => {
    const env = await createEnv();

    const response = await request('/v1/commands/cmd-1', env, { headers });

    expect(response.status).toBe(200);
    const command = await response.json() as any;
    expect(command).toMatchObject({ commandId: 'cmd-1', state: 'dispatched', reqSeq: 7 });
    expect(JSON.stringify(command.payload)).toContain('[redacted]');
  });

  it('returns command audit rows', async () => {
    const env = await createEnv();

    const response = await request('/v1/commands/cmd-1/audit', env, { headers });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: 'audit-1', eventType: 'dispatched', source: 'worker-test' });
    expect(JSON.stringify(body.items[0].details)).toContain('[redacted]');
  });

  it('requires admin auth and returns 404 for missing command detail', async () => {
    const env = await createEnv();

    expect((await request('/v1/commands?deviceId=dev-1', env)).status).toBe(401);
    expect((await request('/v1/commands/missing', env, { headers })).status).toBe(404);
  });
});
