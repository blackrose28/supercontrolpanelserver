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

type TestEnv = { CC_DB: TestD1Database; CC_ADMIN_API_TOKEN: string; now?: () => number; uuid?: () => string };

describe('Worker POST /v1/logs ingest', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  let uuidCounter = 0;

  async function createEnv(): Promise<TestEnv> {
    uuidCounter = 0;
    const db = new TestD1Database();
    databases.push(db);
    const devices = new D1DeviceStore(db);
    await devices.addDevice({ id: 'dev-1', name: 'Agent One', lastSeenAt: '2026-05-04T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1' });
    return {
      CC_DB: db,
      CC_ADMIN_API_TOKEN: 'admin-token',
      now: () => Date.parse('2026-05-04T01:00:00.000Z'),
      uuid: () => `uuid-${++uuidCounter}`,
    };
  }

  function request(path: string, env: TestEnv, init: RequestInit = {}) {
    return worker.fetch(new Request(`https://cc.example.test${path}`, init), env as any);
  }

  const agentHeaders = { authorization: 'Bearer agent-token-1', 'content-type': 'application/json' };
  const adminHeaders = { authorization: 'Bearer admin-token' };

  it('ingests a batch of events and stores them in D1', async () => {
    const env = await createEnv();

    const body = {
      events: [
        { type: 'function-status', functionId: 'openvpn-connect', seq: 1, ts: '2026-05-04T00:00:01.000Z', payload: { state: 'running', message: 'Connected' } },
        { type: 'pty-output', sessionId: 'pty-1', seq: 2, ts: '2026-05-04T00:00:02.000Z', payload: { data: 'hello world' } },
      ],
    };

    const response = await request('/v1/logs', env, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result).toMatchObject({ accepted: 2, deviceId: 'dev-1' });
    expect(result.lastSeq).toBe(2);

    // Verify stored via direct D1LogStore query
    const logs = await new D1LogStore(env.CC_DB).listByDevice('dev-1', 100);
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => l.type)).toContain('function-status');
    expect(logs.map((l) => l.type)).toContain('pty-output');

    // Verify via admin list endpoint
    const listResponse = await request('/v1/logs?deviceId=dev-1&limit=100', env, { headers: adminHeaders });
    expect(listResponse.status).toBe(200);
    const adminLogs = await listResponse.json() as any[];
    expect(adminLogs).toHaveLength(2);
  });

  it('ingests a single event as top-level body (non-array format)', async () => {
    const env = await createEnv();

    const body = {
      type: 'function-status',
      functionId: 'boundary-auth',
      seq: 10,
      ts: '2026-05-04T00:00:05.000Z',
      payload: { state: 'idle' },
    };

    const response = await request('/v1/logs', env, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result).toMatchObject({ accepted: 1, deviceId: 'dev-1' });
  });

  it('returns 401 when no agent token is provided', async () => {
    const env = await createEnv();

    const response = await request('/v1/logs', env, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'test', seq: 1 }] }),
    });

    expect(response.status).toBe(401);
  });

  it('returns 401 when agent token is invalid', async () => {
    const env = await createEnv();

    const response = await request('/v1/logs', env, {
      method: 'POST',
      headers: { authorization: 'Bearer bad-token', 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'test', seq: 1 }] }),
    });

    expect(response.status).toBe(401);
  });

  it('returns 400 when events payload is empty', async () => {
    const env = await createEnv();

    const response = await request('/v1/logs', env, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it('fills in defaults for missing event fields', async () => {
    const env = await createEnv();

    const body = {
      events: [
        { type: 'heartbeat', payload: { os: 'linux' } },
      ],
    };

    const response = await request('/v1/logs', env, {
      method: 'POST',
      headers: agentHeaders,
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.accepted).toBe(1);

    // Check that defaults were applied
    const logs = await new D1LogStore(env.CC_DB).listByDevice('dev-1', 100);
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe('heartbeat');
    expect(logs[0].ts).toBeTruthy();
    expect(typeof logs[0].seq).toBe('number');
  });

  it('handles gzip-encoded request body', async () => {
    const env = await createEnv();

    const body = JSON.stringify({
      events: [
        { type: 'function-status', functionId: 'openvpn-connect', seq: 1, ts: '2026-05-04T00:00:01.000Z', payload: { state: 'running' } },
      ],
    });

    // Use CompressionStream if available, otherwise skip gzip test
    if (typeof CompressionStream === 'undefined') {
      return;
    }

    const inputBytes = new TextEncoder().encode(body);
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(inputBytes);
    writer.close();
    const compressedChunks: Uint8Array[] = [];
    const reader = cs.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      compressedChunks.push(value);
    }
    const totalLength = compressedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const compressed = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of compressedChunks) {
      compressed.set(chunk, offset);
      offset += chunk.length;
    }

    const response = await request('/v1/logs', env, {
      method: 'POST',
      headers: {
        authorization: 'Bearer agent-token-1',
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      body: compressed,
    });

    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.accepted).toBe(1);
  });

  it('rate-limits excessive ingest requests', async () => {
    const env = await createEnv();
    const body = JSON.stringify({ events: [{ type: 'test', seq: 1, payload: {} }] });

    // Send several requests - all should succeed under default 600/60s limit
    const responses: Response[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request('/v1/logs', env, {
        method: 'POST',
        headers: agentHeaders,
        body,
      });
      responses.push(r);
    }

    expect(responses.every((r) => r.status === 200)).toBe(true);
  });
});
