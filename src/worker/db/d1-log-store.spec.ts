import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { D1_SCHEMA_SQL } from './d1-schema';
import { D1LogStore } from './d1-log-store';

class TestD1PreparedStatement {
  private params: unknown[] = [];
  constructor(private readonly statement: Database.Statement) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  async run() { this.statement.run(...this.params); return { success: true }; }
  async first<T = unknown>() { return (this.statement.get(...this.params) ?? null) as T | null; }
  async all<T = unknown>() { return { results: this.statement.all(...this.params) as T[] }; }
}

class TestD1Database {
  readonly sqlite = new Database(':memory:');
  constructor() { this.sqlite.exec(D1_SCHEMA_SQL); }
  prepare(sql: string) { return new TestD1PreparedStatement(this.sqlite.prepare(sql)); }
  close() { this.sqlite.close(); }
}

describe('D1LogStore', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function ensureDevice(storeDb: TestD1Database, deviceId: string) {
    await storeDb.prepare('INSERT OR IGNORE INTO devices (id, name, lastSeenAt, status, agentToken, os) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(deviceId, deviceId, '2026-04-29T00:00:00.000Z', 'connected', `token-${deviceId}`, 'linux')
      .run();
  }

  function createStore(options?: { maxEventsPerDevice?: number; maxAgeDays?: number }) {
    const db = new TestD1Database();
    databases.push(db);
    return { db, store: new D1LogStore(db, {
      maxEventsPerDevice: options?.maxEventsPerDevice ?? 5000,
      maxAgeDays: options?.maxAgeDays ?? 30,
      now: () => new Date('2026-04-29T00:00:00.000Z'),
    }) };
  }

  it('appends sanitized events and lists by device chronologically after newest-first limiting', async () => {
    const { db, store } = createStore();
    await ensureDevice(db, 'dev-1');

    await store.append({
      id: 'old-high-seq', deviceId: 'dev-1', type: 'recent_logs', seq: 900,
      ts: '2026-04-22T09:12:59.000Z', sessionId: null, functionId: null,
      payload: { message: 'Bearer at_secret123 should redact' },
    });
    await store.append({
      id: 'newer-low-seq', deviceId: 'dev-1', type: 'recent_logs', seq: 10,
      ts: '2026-04-23T03:33:36.000Z', sessionId: null, functionId: null,
      payload: { ok: true },
    });

    const logs = await store.listByDevice('dev-1', 10);

    expect(logs.map((entry) => entry.id)).toEqual(['old-high-seq', 'newer-low-seq']);
    expect(JSON.stringify(logs[0].payload)).toContain('[redacted]');
  });

  it('filters listAll and reports telemetry type stats', async () => {
    const { db, store } = createStore();
    await ensureDevice(db, 'dev-1');
    await ensureDevice(db, 'dev-2');
    await store.append({ id: 'a', deviceId: 'dev-1', type: 'inventory', seq: 1, ts: '2026-04-22T00:00:00.000Z', payload: { host: 'alpha' } });
    await store.append({ id: 'b', deviceId: 'dev-1', type: 'pty-output', sessionId: 's1', functionId: null, seq: 2, ts: '2026-04-22T00:01:00.000Z', payload: { data: 'needle line' } });
    await store.append({ id: 'c', deviceId: 'dev-2', type: 'inventory', seq: 1, ts: '2026-04-22T00:02:00.000Z', payload: { host: 'beta' } });

    const filtered = await store.listAll(10, { deviceId: 'dev-1', q: 'needle' });
    expect(filtered.map((entry) => entry.id)).toEqual(['b']);

    const stats = await store.getTelemetryTypeStats({ deviceId: 'dev-1' });
    expect(stats).toEqual(expect.arrayContaining([{ type: 'inventory', count: 1 }, { type: 'pty-output', count: 1 }]));
  });

  it('updates runtime summary from inventory, function-status, and status_snapshot', async () => {
    const { db, store } = createStore();
    await ensureDevice(db, 'dev-1');

    await store.append({ id: 'inv', deviceId: 'dev-1', type: 'inventory', seq: 1, ts: '2026-04-23T09:00:00.000Z', payload: { servers: [{ id: 'srv1' }] } });
    await store.append({
      id: 'fs', deviceId: 'dev-1', type: 'function-status', sessionId: 'pty-old', functionId: 'server-tunnel-srv1', seq: 2,
      ts: '2026-04-23T09:01:00.000Z',
      payload: { functionId: 'server-tunnel-srv1', state: 'running', message: 'Bearer at_secret token', sessionId: 'pty-old', updatedAtMs: 1000 },
    });

    let summary = await store.getDeviceRuntimeSummary('dev-1');
    expect(summary.inventory).toEqual({ servers: [{ id: 'srv1' }] });
    expect(summary.functions['server-tunnel-srv1']?.sessionId).toBe('pty-old');
    expect(summary.functions['server-tunnel-srv1']?.message).toContain('[redacted]');

    await store.append({
      id: 'snap', deviceId: 'dev-1', type: 'status_snapshot', seq: 3, ts: '2026-04-23T10:00:00.000Z',
      payload: { functionStates: [{ functionId: 'openvpn-connect', state: 'idle', sessionId: null, updatedAtMs: 2000 }] },
    });

    summary = await store.getDeviceRuntimeSummary('dev-1');
    expect(summary.functions['server-tunnel-srv1']).toBeUndefined();
    expect(summary.functions['openvpn-connect']?.state).toBe('idle');
    expect(summary.updatedAt).toBe('2026-04-23T10:00:00.000Z');
  });

  it('queries PTY output pagination and last known function session id', async () => {
    const { db, store } = createStore();
    await ensureDevice(db, 'dev-1');
    await store.append({ id: 'fs-run', deviceId: 'dev-1', type: 'function-status', sessionId: 'pty-1', functionId: 'server-tunnel-srv1', seq: 1, ts: '2026-04-23T09:00:00.000Z', payload: { functionId: 'server-tunnel-srv1', sessionId: 'pty-1' } });
    for (let i = 0; i < 12; i++) {
      await store.append({ id: `pty-${i}`, deviceId: 'dev-1', type: 'pty-output', sessionId: 'pty-1', seq: i + 2, ts: `2026-04-23T09:00:${String(i).padStart(2, '0')}.000Z`, payload: { data: `line ${i}` } });
    }
    await store.append({ id: 'fs-exit', deviceId: 'dev-1', type: 'function-status', sessionId: null, functionId: 'server-tunnel-srv1', seq: 99, ts: '2026-04-23T09:01:00.000Z', payload: { functionId: 'server-tunnel-srv1', sessionId: null } });

    await expect(store.getLastSessionIdForFunction('dev-1', 'server-tunnel-srv1')).resolves.toBe('pty-1');
    await expect(store.countPtyOutputBySession('dev-1', 'pty-1')).resolves.toBe(12);
    const page = await store.listPtyOutputBySession('dev-1', 'pty-1', 5, 5);
    expect(page.map((entry) => (entry.payload as any).data)).toEqual(['line 2', 'line 3', 'line 4', 'line 5', 'line 6']);
  });

  it('trims per-device history by newest timestamps', async () => {
    const { db, store } = createStore({ maxEventsPerDevice: 2 });
    await ensureDevice(db, 'dev-1');
    await store.append({ id: 'older-1', deviceId: 'dev-1', type: 'inventory', seq: 100, ts: '2026-04-22T09:12:59.000Z', payload: {} });
    await store.append({ id: 'older-2', deviceId: 'dev-1', type: 'recent_logs', seq: 99, ts: '2026-04-22T09:13:59.000Z', payload: {} });
    await store.append({ id: 'newer-1', deviceId: 'dev-1', type: 'recent_logs', seq: 10, ts: '2026-04-23T03:33:23.000Z', payload: {} });
    await store.append({ id: 'newer-2', deviceId: 'dev-1', type: 'status_snapshot', seq: 11, ts: '2026-04-23T03:33:36.000Z', payload: {} });

    const logs = await store.listByDevice('dev-1', 10);
    expect(logs.map((entry) => entry.id)).toEqual(['newer-1', 'newer-2']);
  });
});
