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

type TestEnv = { CC_DB: TestD1Database; CC_ADMIN_API_TOKEN: string; now?: () => number };

describe('Worker logs routes', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createEnv() {
    const db = new TestD1Database();
    databases.push(db);
    const devices = new D1DeviceStore(db);
    await devices.addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1', os: 'linux' });
    const logs = new D1LogStore(db, { now: () => new Date('2026-04-29T00:00:00.000Z') });
    await logs.append({ id: 'evt-1', deviceId: 'dev-1', type: 'inventory', seq: 1, ts: '2026-04-29T00:00:01.000Z', payload: { servers: [] } });
    await logs.append({ id: 'evt-2', deviceId: 'dev-1', type: 'function-status', functionId: 'openvpn-connect', sessionId: null, seq: 2, ts: '2026-04-29T00:00:02.000Z', payload: { functionId: 'openvpn-connect', state: 'running', message: 'ok' } });
    await logs.append({ id: 'evt-3', deviceId: 'dev-1', type: 'pty-output', sessionId: 'pty-1', seq: 3, ts: '2026-04-29T00:00:03.000Z', payload: { data: 'needle output' } });
    return { CC_DB: db, CC_ADMIN_API_TOKEN: 'admin-token', now: () => Date.parse('2026-04-29T01:00:00.000Z') } satisfies TestEnv;
  }

  function request(path: string, env: TestEnv, init: RequestInit = {}) {
    return worker.fetch(new Request(`https://cc.example.test${path}`, init), env as any);
  }

  const headers = { authorization: 'Bearer admin-token' };

  it('lists logs by device with filters', async () => {
    const env = await createEnv();

    const response = await request('/v1/logs?deviceId=dev-1&type=pty-output&q=needle&limit=10', env, { headers });

    expect(response.status).toBe(200);
    const body = await response.json() as any[];
    expect(body.map((event) => event.id)).toEqual(['evt-3']);
    expect(body[0].payload.data).toBe('needle output');
  });

  it('exports logs with metadata and JSON content type', async () => {
    const env = await createEnv();

    const response = await request('/v1/logs/export?deviceId=dev-1&limit=2', env, { headers });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await response.json() as any;
    expect(body).toMatchObject({ deviceId: 'dev-1', count: 2 });
    expect(body.fileName).toContain('cc-logs-dev-1-');
    expect(body.logs).toHaveLength(2);
  });

  it('returns runtime summary and log retention settings', async () => {
    const env = await createEnv();

    const summary = await request('/v1/device-summary?deviceId=dev-1', env, { headers });
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toMatchObject({ deviceId: 'dev-1', functions: { 'openvpn-connect': { state: 'running' } } });

    const settings = await request('/v1/log-settings', env, { headers });
    expect(settings.status).toBe(200);
    await expect(settings.json()).resolves.toMatchObject({ maxEventsPerDevice: 5000, maxAgeDays: 30 });
  });

  it('queries telemetry with stats and date filters', async () => {
    const env = await createEnv();

    const response = await request('/v1/telemetry?deviceId=dev-1&fromTs=2026-04-29T00:00:02.000Z&limit=10', env, { headers });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.count).toBe(2);
    expect(body.events.map((event: any) => event.id)).toEqual(['evt-2', 'evt-3']);
    expect(body.stats).toEqual(expect.arrayContaining([{ type: 'function-status', count: 1 }, { type: 'pty-output', count: 1 }]));
  });

  it('requires admin auth and validates device existence', async () => {
    const env = await createEnv();

    expect((await request('/v1/logs?deviceId=dev-1', env)).status).toBe(401);
    expect((await request('/v1/logs', env, { headers })).status).toBe(400);
    expect((await request('/v1/logs?deviceId=missing', env, { headers })).status).toBe(404);
  });
});
