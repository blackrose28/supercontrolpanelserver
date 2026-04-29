import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import worker from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';

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
  CC_BOOTSTRAP_TOKEN: string;
  now?: () => number;
  uuid?: () => string;
};

describe('Worker enrollment route', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  function createEnv(): TestEnv {
    const db = new TestD1Database();
    databases.push(db);
    let uuidCounter = 0;
    return {
      CC_DB: db,
      CC_BOOTSTRAP_TOKEN: 'bootstrap-secret',
      now: () => Date.parse('2026-04-29T00:00:00.000Z'),
      uuid: () => ['device-uuid-1', 'agent-token-1'][uuidCounter++] ?? `uuid-${uuidCounter}`,
    };
  }

  async function postEnroll(env: TestEnv, body: unknown, headers?: HeadersInit) {
    return worker.fetch(new Request('https://cc.example.test/v1/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
    }), env as any);
  }

  it('enrolls a device with a valid bootstrap token and stores a hashed agent token', async () => {
    const env = createEnv();

    const response = await postEnroll(env, { bootstrapToken: 'bootstrap-secret', deviceName: 'Laptop' }, { 'x-real-ip': '10.0.0.2' });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      deviceId: 'device-uuid-1',
      ccAgentToken: 'agent-token-1',
      deviceName: 'Laptop',
    });
    const row = await env.CC_DB.prepare('SELECT id, name, status, agentToken FROM devices WHERE id = ?').bind('device-uuid-1').first<any>();
    expect(row).toMatchObject({ id: 'device-uuid-1', name: 'Laptop', status: 'disconnected' });
    expect(row.agentToken).toMatch(/^sha256:/);
    expect(row.agentToken).not.toBe('agent-token-1');
  });

  it('uses a default device name when deviceName is omitted', async () => {
    const env = createEnv();

    const response = await postEnroll(env, { bootstrapToken: 'bootstrap-secret' });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ deviceName: 'device-device-u' });
  });

  it('rejects missing or invalid bootstrap tokens', async () => {
    const env = createEnv();

    const response = await postEnroll(env, { bootstrapToken: 'wrong' });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'BOOTSTRAP_TOKEN_INVALID' });
  });

  it('rate-limits enrollment attempts by client id', async () => {
    const env = createEnv();

    for (let i = 0; i < 20; i++) {
      const response = await postEnroll(env, { bootstrapToken: 'wrong' }, { 'x-real-ip': '203.0.113.10' });
      expect(response.status).toBe(401);
    }

    const limited = await postEnroll(env, { bootstrapToken: 'wrong' }, { 'x-real-ip': '203.0.113.10' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    await expect(limited.json()).resolves.toMatchObject({ error: 'RATE_LIMITED', rate_limited: true });
  });
});
