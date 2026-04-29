import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { D1_SCHEMA_SQL } from './d1-schema';
import { D1DeviceStore } from './d1-device-store';

class TestD1PreparedStatement {
  private params: unknown[] = [];

  constructor(private readonly statement: Database.Statement) {}

  bind(...params: unknown[]) {
    this.params = params;
    return this;
  }

  async run() {
    this.statement.run(...this.params);
    return { success: true };
  }

  async first<T = unknown>() {
    return (this.statement.get(...this.params) ?? null) as T | null;
  }

  async all<T = unknown>() {
    return { results: this.statement.all(...this.params) as T[] };
  }
}

class TestD1Database {
  readonly sqlite = new Database(':memory:');

  constructor() {
    this.sqlite.exec(D1_SCHEMA_SQL);
  }

  prepare(sql: string) {
    return new TestD1PreparedStatement(this.sqlite.prepare(sql));
  }

  close() {
    this.sqlite.close();
  }
}

describe('D1DeviceStore', () => {
  const databases: TestD1Database[] = [];

  afterEach(() => {
    while (databases.length) {
      databases.pop()?.close();
    }
  });

  function createStore() {
    const db = new TestD1Database();
    databases.push(db);
    return new D1DeviceStore(db);
  }

  it('adds, reads, and lists devices with hashed agent tokens', async () => {
    const store = createStore();

    const saved = await store.addDevice({
      id: 'dev-1',
      name: 'Device One',
      lastSeenAt: '2026-04-29T00:00:00.000Z',
      status: 'disconnected',
      agentToken: 'plain-agent-token',
      os: 'linux',
    });

    expect(saved.agentToken).toMatch(/^sha256:/);
    await expect(store.getDevice('dev-1')).resolves.toEqual(saved);
    await expect(store.getAllDevices()).resolves.toEqual([saved]);
  });

  it('finds devices by raw or already-hashed agent token', async () => {
    const store = createStore();
    const saved = await store.addDevice({
      id: 'dev-2',
      name: 'Device Two',
      lastSeenAt: '2026-04-29T00:00:00.000Z',
      status: 'disconnected',
      agentToken: 'lookup-token',
    });

    await expect(store.findDeviceByAgentToken('lookup-token')).resolves.toEqual(saved);
    await expect(store.findDeviceByAgentToken(saved.agentToken ?? '')).resolves.toEqual(saved);
    await expect(store.findDeviceByAgentToken('missing-token')).resolves.toBeUndefined();
  });

  it('updates status and OS fields independently', async () => {
    const store = createStore();
    await store.addDevice({
      id: 'dev-3',
      name: 'Device Three',
      lastSeenAt: '2026-04-29T00:00:00.000Z',
      status: 'disconnected',
      agentToken: 'status-token',
    });

    const connected = await store.updateDeviceStatus('dev-3', 'connected', '2026-04-29T00:01:00.000Z');
    expect(connected?.status).toBe('connected');
    expect(connected?.lastSeenAt).toBe('2026-04-29T00:01:00.000Z');

    const withOs = await store.updateDeviceOs('dev-3', 'windows');
    expect(withOs?.os).toBe('windows');
    expect(withOs?.status).toBe('connected');
  });

  it('removes a device and its dependent rows', async () => {
    const store = createStore();
    await store.addDevice({
      id: 'dev-4',
      name: 'Device Four',
      lastSeenAt: '2026-04-29T00:00:00.000Z',
      status: 'disconnected',
      agentToken: 'delete-token',
    });

    await expect(store.removeDevice('dev-4')).resolves.toBe(true);
    await expect(store.removeDevice('dev-4')).resolves.toBe(false);
    await expect(store.getDevice('dev-4')).resolves.toBeUndefined();
  });
});
