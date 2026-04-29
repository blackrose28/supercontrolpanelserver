import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { D1_SCHEMA_SQL } from './d1-schema';
import { D1FileTransferStore, D1RemoteBrowserSessionStore } from './d1-file-op-store';

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

describe('D1FileTransferStore', () => {
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
    return new D1FileTransferStore(db);
  }

  it('creates transfers with normalized options and lists by device', async () => {
    const store = await createStore();

    const created = await store.create({
      id: 'row-1', transferId: 'tr-1', deviceId: 'dev-1', serverId: 'srv-1', direction: 'upload',
      actorType: 'admin_session', actorId: 'admin-1', localPath: '/tmp/a', remotePath: '/srv/a', recursive: true,
      verifyChecksum: true, attempt: 0, maxAttempts: 2, ts: '2026-04-29T00:00:00.000Z',
    });

    expect(created).toMatchObject({ transferId: 'tr-1', state: 'queued', recursive: true, verifyChecksum: true, attempt: 1, maxAttempts: 2 });
    await expect(store.get('tr-1')).resolves.toEqual(created);
    await expect(store.listByDevice('dev-1')).resolves.toEqual([created]);
  });

  it('updates progress, attaches session/command, and completes transfers', async () => {
    const store = await createStore();
    await store.create({ id: 'row-2', transferId: 'tr-2', deviceId: 'dev-1', serverId: 'srv-1', direction: 'download', ts: '2026-04-29T00:00:00.000Z' });

    await store.attachSession('tr-2', 'pty-1', '2026-04-29T00:00:01.000Z');
    await store.attachCommand('tr-2', 'cmd-1', 9, '2026-04-29T00:00:02.000Z');
    const progress = await store.updateProgress('tr-2', '2026-04-29T00:00:03.000Z', {
      bytesTransferred: 512,
      bytesTotal: 1024,
      percent: 50,
      phase: 'copy',
      message: 'token: secret progress',
    });

    expect(progress).toMatchObject({ state: 'running', sessionId: 'pty-1', commandId: 'cmd-1', reqSeq: 9, progressEventCount: 1, firstProgressAt: '2026-04-29T00:00:03.000Z' });
    expect(progress.message).toContain('[redacted]');

    const done = await store.markState('tr-2', 'succeeded', '2026-04-29T00:00:04.000Z', { phase: 'finalize', message: 'done' });
    expect(done).toMatchObject({ state: 'succeeded', finishedAt: '2026-04-29T00:00:04.000Z', finalizeSeen: true });
  });

  it('prepares resume and supports active/completed aggregate queries', async () => {
    const store = await createStore();
    await store.create({ id: 'row-3a', transferId: 'tr-3a', deviceId: 'dev-1', serverId: 'srv-1', direction: 'upload', ts: '2026-04-29T00:00:00.000Z' });
    await store.create({ id: 'row-3b', transferId: 'tr-3b', deviceId: 'dev-1', serverId: 'srv-1', direction: 'upload', ts: '2026-04-29T00:00:01.000Z' });
    await store.updateProgress('tr-3a', '2026-04-29T00:00:02.000Z', { bytesTransferred: 100 });
    await store.markState('tr-3a', 'failed', '2026-04-29T00:00:03.000Z', { reasonCode: 'network', resumeSupported: true, resumeOffsetBytes: 100 });

    const resumed = await store.prepareForResume('tr-3a', '2026-04-29T00:00:04.000Z', { attempt: 2, maxAttempts: 3, message: 'retry' });
    expect(resumed).toMatchObject({ state: 'queued', phase: 'precheck', attempt: 2, maxAttempts: 3, finishedAt: null });

    expect(await store.countActiveByDevice('dev-1')).toBe(2);
    expect(await store.countActive()).toBe(2);
    expect(await store.listActive()).toHaveLength(2);

    await store.markState('tr-3a', 'succeeded', '2026-04-29T00:00:05.000Z');
    expect(await store.listCompletedSince('2026-04-29T00:00:00.000Z', 'dev-1')).toHaveLength(1);
    expect(await store.sumTransferredBytesSince('2026-04-29T00:00:00.000Z')).toBe(100);
  });

  it('deletes finished transfers only unless forced', async () => {
    const store = await createStore();
    await store.create({ id: 'row-4a', transferId: 'tr-open', deviceId: 'dev-1', serverId: 'srv-1', direction: 'upload', ts: '2026-04-29T00:00:00.000Z' });
    await store.create({ id: 'row-4b', transferId: 'tr-done', deviceId: 'dev-1', serverId: 'srv-1', direction: 'upload', ts: '2026-04-29T00:00:01.000Z' });
    await store.markState('tr-done', 'canceled', '2026-04-29T00:00:02.000Z');

    await expect(store.deleteFinished('tr-open')).rejects.toThrow('not finished');
    expect((await store.deleteFinishedByDevice('dev-1')).deletedCount).toBe(1);
    await expect(store.get('tr-done')).resolves.toBeUndefined();
    expect((await store.deleteAny('tr-open'))?.transferId).toBe('tr-open');
  });
});

describe('D1RemoteBrowserSessionStore', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createStore() {
    const db = new TestD1Database();
    databases.push(db);
    await db.prepare('INSERT INTO devices (id, name, lastSeenAt, status, agentToken, os) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('dev-1', 'Device One', '2026-04-29T00:00:00.000Z', 'connected', 'token-dev-1', 'linux')
      .run();
    return new D1RemoteBrowserSessionStore(db);
  }

  it('creates, opens, records activity, and closes browser sessions', async () => {
    const store = await createStore();

    const opening = await store.createOpening({ id: 'rb-row-1', browserSessionId: 'browser-1', deviceId: 'dev-1', serverId: 'srv-1', actorType: 'admin_session', openedAt: '2026-04-29T00:00:00.000Z', rootPath: '/' });
    expect(opening).toMatchObject({ state: 'opening', currentPath: '/' });

    await store.markOpen('browser-1', '2026-04-29T00:00:01.000Z', '/home');
    const active = await store.noteActivity('browser-1', '2026-04-29T00:00:02.000Z', '/home/user');
    expect(active).toMatchObject({ state: 'open', rootPath: '/home', currentPath: '/home/user' });

    const closed = await store.markClosed('browser-1', '2026-04-29T00:00:03.000Z', 'done');
    expect(closed).toMatchObject({ state: 'closed', closedAt: '2026-04-29T00:00:03.000Z', failureDetail: 'done' });
  });

  it('counts active sessions and expires stale opening/open sessions', async () => {
    const store = await createStore();
    await store.createOpening({ id: 'rb-row-2', browserSessionId: 'browser-2', deviceId: 'dev-1', serverId: 'srv-1', openedAt: '2026-04-29T00:00:00.000Z' });
    await store.createOpening({ id: 'rb-row-3', browserSessionId: 'browser-3', deviceId: 'dev-1', serverId: 'srv-1', openedAt: '2026-04-29T00:00:10.000Z' });
    await store.markOpen('browser-3', '2026-04-29T00:00:11.000Z', '/');

    expect(await store.countActiveByDevice('dev-1')).toBe(2);
    expect(await store.countActive()).toBe(2);

    const expired = await store.expireStaleActive('2026-04-29T00:01:00.000Z', 30_000, 45_000);
    expect(expired).toBe(2);
    expect(await store.countActive()).toBe(0);
    const records = await store.listByDevice('dev-1');
    expect(records.every((record) => record.state === 'closed')).toBe(true);
  });

  it('marks failed sessions with redacted details', async () => {
    const store = await createStore();
    await store.createOpening({ id: 'rb-row-4', browserSessionId: 'browser-4', deviceId: 'dev-1', serverId: 'srv-1', openedAt: '2026-04-29T00:00:00.000Z' });

    const failed = await store.markFailed('browser-4', 'SFTP_FAILED', 'password: secret', '2026-04-29T00:00:01.000Z');

    expect(failed).toMatchObject({ state: 'failed', failureCode: 'SFTP_FAILED' });
    expect(failed.failureDetail).toContain('[redacted]');
  });
});
