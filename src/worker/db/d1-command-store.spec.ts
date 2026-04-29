import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { D1_SCHEMA_SQL } from './d1-schema';
import { D1CommandStore } from './d1-command-store';

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

describe('D1CommandStore', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createStore() {
    const db = new TestD1Database();
    databases.push(db);
    for (const deviceId of ['dev-1', 'dev-2']) {
      await db.prepare('INSERT INTO devices (id, name, lastSeenAt, status, agentToken, os) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(deviceId, deviceId, '2026-04-29T00:00:00.000Z', 'connected', `token-${deviceId}`, 'linux')
        .run();
    }
    return new D1CommandStore(db);
  }

  it('creates queued commands with redacted payloads and lists them by filters', async () => {
    const store = await createStore();

    const created = await store.createQueuedCommand({
      id: 'row-1',
      commandId: 'cmd-1',
      deviceId: 'dev-1',
      commandType: 'request_status_snapshot',
      actorType: 'admin_session',
      actorId: 'session-1',
      payload: { authorization: 'Bearer secret-token', safe: true },
      payloadSummary: 'snapshot',
      submittedAt: '2026-04-23T00:00:00.000Z',
    });

    expect(created).toMatchObject({ commandId: 'cmd-1', state: 'queued', actorId: 'session-1' });
    expect(JSON.stringify(created.payload)).toContain('[redacted]');
    await expect(store.getCommand('cmd-1')).resolves.toEqual(created);
    await expect(store.listCommands({ deviceId: 'dev-1', state: 'queued' })).resolves.toEqual([created]);
  });

  it('marks dispatch/executing/succeeded and ignores terminal state transitions', async () => {
    const store = await createStore();
    await store.createQueuedCommand({ id: 'row-2', commandId: 'cmd-2', deviceId: 'dev-1', commandType: 'restart_openvpn', actorType: 'admin_api_token', submittedAt: '2026-04-23T00:00:00.000Z' });

    const dispatched = await store.markDispatched('cmd-2', 42, '2026-04-23T00:00:01.000Z');
    expect(dispatched).toMatchObject({ state: 'dispatched', reqSeq: 42 });

    const executing = await store.markExecuting('cmd-2', '2026-04-23T00:00:02.000Z');
    expect(executing).toMatchObject({ state: 'executing', executingAt: '2026-04-23T00:00:02.000Z' });

    const succeeded = await store.markSucceeded('cmd-2', 'ok', '2026-04-23T00:00:03.000Z');
    expect(succeeded).toMatchObject({ state: 'succeeded', outcome: 'ok', reasonCode: null });

    const afterTerminal = await store.markFailed('cmd-2', 'late_error', 'ignored', '2026-04-23T00:00:04.000Z');
    expect(afterTerminal).toMatchObject({ state: 'succeeded', outcome: 'ok', reasonCode: null });
  });

  it('marks failed commands and finds by request sequence', async () => {
    const store = await createStore();
    await store.createQueuedCommand({ id: 'row-3', commandId: 'cmd-3', deviceId: 'dev-1', commandType: 'request_inventory', actorType: 'system', submittedAt: '2026-04-23T00:00:00.000Z' });
    await store.markDispatched('cmd-3', 7, '2026-04-23T00:00:01.000Z');

    const failed = await store.markFailed('cmd-3', 'timeout', 'agent timeout', '2026-04-23T00:00:05.000Z');

    expect(failed).toMatchObject({ state: 'failed', outcome: 'failed', reasonCode: 'timeout', reasonDetail: 'agent timeout' });
    await expect(store.findByReqSeq('dev-1', 7)).resolves.toMatchObject({ commandId: 'cmd-3' });
  });

  it('appends audit records, avoids duplicate audit entries, and checks audit existence', async () => {
    const store = await createStore();
    await store.createQueuedCommand({ id: 'row-4', commandId: 'cmd-4', deviceId: 'dev-1', commandType: 'request_recent_logs', actorType: 'admin_session', submittedAt: '2026-04-23T00:00:00.000Z' });

    const audit = await store.appendAudit({
      id: 'audit-1', commandId: 'cmd-4', ts: '2026-04-23T00:00:01.000Z', eventType: 'created',
      actorType: 'admin_session', actorId: 'session-1', source: 'admin', summary: 'Created command', details: { token: 'secret' },
    });

    expect(JSON.stringify(audit.details)).toContain('[redacted]');
    const duplicate = await store.appendAuditIfMissing({
      id: 'audit-dup', commandId: 'cmd-4', ts: '2026-04-23T00:00:02.000Z', eventType: 'created',
      source: 'admin', summary: 'Created command', details: { ignored: true },
    });
    expect(duplicate.id).toBe('audit-1');
    await expect(store.listAudit('cmd-4')).resolves.toHaveLength(1);
    await expect(store.hasAuditEvent('cmd-4', 'created', 'admin')).resolves.toBe(true);
    await expect(store.hasAuditEvent('cmd-4', ['failed', 'succeeded'])).resolves.toBe(false);
  });

  it('finds oldest pending command optionally matching payload', async () => {
    const store = await createStore();
    await store.createQueuedCommand({ id: 'row-5a', commandId: 'cmd-5a', deviceId: 'dev-1', commandType: 'restart_server_tunnel', actorType: 'admin_session', payload: { serverId: 'srv-a' }, submittedAt: '2026-04-23T00:00:02.000Z' });
    await store.createQueuedCommand({ id: 'row-5b', commandId: 'cmd-5b', deviceId: 'dev-1', commandType: 'restart_server_tunnel', actorType: 'admin_session', payload: { serverId: 'srv-b' }, submittedAt: '2026-04-23T00:00:01.000Z' });

    await expect(store.findPendingCommand('dev-1', 'restart_server_tunnel')).resolves.toMatchObject({ commandId: 'cmd-5b' });
    await expect(store.findPendingCommand('dev-1', 'restart_server_tunnel', (payload) => (payload as any).serverId === 'srv-a')).resolves.toMatchObject({ commandId: 'cmd-5a' });
  });
});
