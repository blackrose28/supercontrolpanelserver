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

type TestEnv = { CC_DB: TestD1Database; CC_ADMIN_API_TOKEN: string };

describe('Worker file transfer routes', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createEnv() {
    const db = new TestD1Database();
    databases.push(db);
    await new D1DeviceStore(db).addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1' });
    await new D1DeviceStore(db).addDevice({ id: 'dev-2', name: 'Two', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-2' });
    const transfers = new D1FileTransferStore(db);
    await transfers.create({ id: 'row-1', transferId: 'tr-running', deviceId: 'dev-1', serverId: 'srv-1', direction: 'upload', localPath: '/tmp/a', remotePath: '/srv/a', ts: '2026-04-29T00:00:00.000Z' });
    await transfers.updateProgress('tr-running', '2026-04-29T00:00:01.000Z', { bytesTransferred: 512, bytesTotal: 1024, percent: 50, message: 'copying' });
    await transfers.create({ id: 'row-2', transferId: 'tr-done', deviceId: 'dev-1', serverId: 'srv-1', direction: 'download', localPath: '/tmp/b', remotePath: '/srv/b', ts: '2026-04-29T00:01:00.000Z' });
    await transfers.markState('tr-done', 'succeeded', '2026-04-29T00:01:05.000Z', { message: 'done' });
    await transfers.create({ id: 'row-3', transferId: 'tr-other-device', deviceId: 'dev-2', serverId: 'srv-2', direction: 'upload', ts: '2026-04-29T00:02:00.000Z' });
    await transfers.markState('tr-other-device', 'failed', '2026-04-29T00:02:05.000Z');
    return { CC_DB: db, CC_ADMIN_API_TOKEN: 'admin-token' } satisfies TestEnv;
  }

  function request(path: string, env: TestEnv, init: RequestInit = {}) {
    return worker.fetch(new Request(`https://cc.example.test${path}`, init), env as any);
  }

  const headers = { authorization: 'Bearer admin-token' };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };

  it('lists file transfers for a device with limit validation', async () => {
    const env = await createEnv();

    const response = await request('/v1/file-transfers?deviceId=dev-1&limit=10', env, { headers });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.items.map((item: any) => item.transferId)).toEqual(['tr-done', 'tr-running']);
    expect(body.items[1]).toMatchObject({ state: 'running', bytesTransferred: 512, percent: 50 });
  });

  it('requires admin auth and validates the requested device', async () => {
    const env = await createEnv();

    expect((await request('/v1/file-transfers?deviceId=dev-1', env)).status).toBe(401);
    expect((await request('/v1/file-transfers', env, { headers })).status).toBe(400);
    expect((await request('/v1/file-transfers?deviceId=missing', env, { headers })).status).toBe(404);
  });

  it('dismisses finished transfers and rejects unfinished transfers', async () => {
    const env = await createEnv();

    const running = await request('/v1/file-transfers/dismiss', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-running' }) });
    expect(running.status).toBe(409);

    const done = await request('/v1/file-transfers/dismiss', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-done' }) });
    expect(done.status).toBe(200);
    await expect(done.json()).resolves.toMatchObject({ ok: true, transferId: 'tr-done' });

    const listed = await request('/v1/file-transfers?deviceId=dev-1', env, { headers });
    const body = await listed.json() as any;
    expect(body.items.map((item: any) => item.transferId)).toEqual(['tr-running']);
  });

  it('force-removes transfers and clears finished transfers by device', async () => {
    const env = await createEnv();

    const force = await request('/v1/file-transfers/force-remove', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-running' }) });
    expect(force.status).toBe(200);
    await expect(force.json()).resolves.toMatchObject({ ok: true, transferId: 'tr-running', forced: true });

    const clear = await request('/v1/file-transfers/dismiss-finished', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1' }) });
    expect(clear.status).toBe(200);
    await expect(clear.json()).resolves.toMatchObject({ ok: true, deletedCount: 1 });

    const otherDevice = await request('/v1/file-transfers?deviceId=dev-2', env, { headers });
    const body = await otherDevice.json() as any;
    expect(body.items.map((item: any) => item.transferId)).toEqual(['tr-other-device']);
  });
});
