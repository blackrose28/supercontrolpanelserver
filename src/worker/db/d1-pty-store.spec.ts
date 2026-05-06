import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { D1_SCHEMA_SQL } from './d1-schema';
import { D1PtyAuditStore, D1PtySessionStore } from './d1-pty-store';

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

class LegacyPtySessionTestD1Database extends TestD1Database {
  constructor() {
    super();
    this.sqlite.exec(`
      DROP TABLE pty_audit;
      DROP TABLE pty_sessions;
      CREATE TABLE pty_sessions (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL UNIQUE,
        deviceId TEXT NOT NULL,
        state TEXT NOT NULL,
        openedByActorType TEXT,
        openedByActorId TEXT,
        attachedActorType TEXT,
        attachedActorId TEXT,
        recordingEnabled INTEGER NOT NULL DEFAULT 0,
        recordingConsentAt TEXT,
        cols INTEGER,
        rows INTEGER,
        openedAt TEXT NOT NULL,
        lastAttachedAt TEXT,
        lastDetachedAt TEXT,
        lastOutputAt TEXT,
        closeRequestedAt TEXT,
        closedAt TEXT,
        expiredAt TEXT,
        failureCode TEXT,
        failureDetail TEXT,
        deletedAt TEXT,
        kind TEXT NOT NULL DEFAULT 'generic',
        serverId TEXT,
        localSessionId TEXT,
        scrollback TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE pty_audit (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        deviceId TEXT NOT NULL,
        ts TEXT NOT NULL,
        eventType TEXT NOT NULL,
        actorType TEXT,
        actorId TEXT,
        summary TEXT NOT NULL,
        detailsJson TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }
}

describe('D1PtySessionStore', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createStore() {
    const db = new TestD1Database();
    databases.push(db);
    await db.prepare('INSERT INTO devices (id, name, lastSeenAt, status, agentToken, os) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('dev-1', 'Device One', '2026-04-29T00:00:00.000Z', 'connected', 'token-dev-1', 'linux')
      .run();
    return { db, store: new D1PtySessionStore(db) };
  }

  async function createOpenSession(store: D1PtySessionStore, sessionId = 'pty-1') {
    await store.createOpening({
      id: `row-${sessionId}`,
      sessionId,
      deviceId: 'dev-1',
      cols: 120,
      rows: 32,
      openedAt: '2026-04-29T00:00:00.000Z',
      recordingEnabled: true,
      openedByActorType: 'admin_session',
      openedByActorId: 'admin-1',
      attachedActorType: 'admin_session',
      attachedActorId: 'admin-1',
    });
    return store.markOpen(sessionId, '2026-04-29T00:00:01.000Z');
  }

  it('creates opening sessions and tracks open/output/size/recording state', async () => {
    const { store } = await createStore();

    const opening = await store.createOpening({
      id: 'row-1', sessionId: 'pty-1', deviceId: 'dev-1', cols: 80, rows: 24,
      openedAt: '2026-04-29T00:00:00.000Z', recordingEnabled: true,
      openedByActorType: 'admin_session', openedByActorId: 'admin-1', attachedActorType: 'admin_session', attachedActorId: 'admin-1',
    });
    expect(opening).toMatchObject({ state: 'opening', recordingEnabled: true, lastAttachedAt: '2026-04-29T00:00:00.000Z' });

    await store.markOpen('pty-1', '2026-04-29T00:00:01.000Z');
    await store.noteOutput('pty-1', '2026-04-29T00:00:02.000Z');
    await store.updateSize('pty-1', 100, 40);
    const consented = await store.markRecordingConsent('pty-1', '2026-04-29T00:00:03.000Z');

    expect(consented).toMatchObject({ state: 'open', cols: 100, rows: 40, lastOutputAt: '2026-04-29T00:00:02.000Z', recordingConsentAt: '2026-04-29T00:00:03.000Z' });
  });

  it('attaches, detaches, and expires detached sessions after the grace window', async () => {
    const { store } = await createStore();
    await createOpenSession(store, 'pty-detach');

    const detached = await store.detach('pty-detach', '2026-04-29T00:00:10.000Z');
    expect(detached.attachedActorType).toBeNull();

    await expect(store.expireDetachedSessions('2026-04-29T00:00:20.000Z')).resolves.toHaveLength(0);
    const expired = await store.expireDetachedSessions('2026-04-29T00:00:41.000Z');
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ state: 'expired', failureCode: 'DETACH_TIMEOUT' });
  });

  it('expires all active device sessions on disconnect', async () => {
    const { store } = await createStore();
    await createOpenSession(store, 'pty-a');
    await createOpenSession(store, 'pty-b');
    await store.markClosed('pty-b', '2026-04-29T00:00:05.000Z', 'closed before disconnect');

    const expired = await store.expireDeviceSessions('dev-1', '2026-04-29T00:01:00.000Z', 'AGENT_DISCONNECTED', 'Agent disconnected');

    expect(expired.map((record) => record.sessionId)).toEqual(['pty-a']);
    expect(expired[0]).toMatchObject({ state: 'expired', failureCode: 'AGENT_DISCONNECTED', failureDetail: 'Agent disconnected' });
  });

  it('tracks pending requests in memory and consumes once', async () => {
    const { store } = await createStore();

    store.trackPendingReq('dev-1', 7, 'pty-pending', 'open');

    expect(store.consumePendingReq('dev-1', 7)).toEqual({ sessionId: 'pty-pending', type: 'open' });
    expect(store.consumePendingReq('dev-1', 7)).toBeUndefined();
  });

  it('lists, deletes, and prunes terminal sessions', async () => {
    const { store } = await createStore();
    await createOpenSession(store, 'pty-terminal');
    await store.markClosed('pty-terminal', '2026-04-01T00:00:00.000Z', 'done');

    expect(await store.listByDevice('dev-1')).toHaveLength(1);
    const deleted = await store.deleteTerminalSession('pty-terminal', '2026-04-29T00:00:00.000Z');
    expect(deleted?.state).toBe('closed');
    expect(await store.listByDevice('dev-1')).toHaveLength(0);

    await createOpenSession(store, 'pty-old');
    await store.markClosed('pty-old', '2026-04-01T00:00:00.000Z', 'old');
    const pruned = await store.pruneTerminalSessions('2026-04-29T00:00:00.000Z');
    expect(pruned.map((record) => record.sessionId)).toEqual(['pty-old']);
  });

  it('rejects deleting non-terminal sessions', async () => {
    const { store } = await createStore();
    await createOpenSession(store, 'pty-open');

    await expect(store.deleteTerminalSession('pty-open', '2026-04-29T00:00:00.000Z')).rejects.toThrow('not deletable');
  });

  it('self-migrates legacy pty_sessions before creating and finding server SSH sessions', async () => {
    const db = new LegacyPtySessionTestD1Database();
    databases.push(db);
    await db.prepare('INSERT INTO devices (id, name, lastSeenAt, status, agentToken, os) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('dev-1', 'Device One', '2026-04-29T00:00:00.000Z', 'connected', 'token-dev-1', 'linux')
      .run();
    const store = new D1PtySessionStore(db);

    await expect(store.createOpening({
      id: 'row-server-ssh',
      sessionId: 'server-ssh-srv-1-pty-1',
      deviceId: 'dev-1',
      kind: 'server_ssh',
      serverId: 'srv-1',
      localSessionId: 'local-pty-1',
      openedAt: '2026-04-29T00:00:00.000Z',
    })).resolves.toMatchObject({
      kind: 'server_ssh',
      serverId: 'srv-1',
      localSessionId: 'local-pty-1',
    });

    await store.markOpen('server-ssh-srv-1-pty-1', '2026-04-29T00:00:01.000Z');
    await expect(store.findActiveServerSshSession('dev-1', 'srv-1')).resolves.toMatchObject({
      sessionId: 'server-ssh-srv-1-pty-1',
      kind: 'server_ssh',
    });
  });
});

describe('D1PtyAuditStore', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  it('appends and lists audit records for a session', async () => {
    const db = new TestD1Database();
    databases.push(db);
    await db.prepare('INSERT INTO devices (id, name, lastSeenAt, status, agentToken, os) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('dev-1', 'Device One', '2026-04-29T00:00:00.000Z', 'connected', 'token-dev-1', 'linux')
      .run();
    const sessions = new D1PtySessionStore(db);
    await sessions.createOpening({ id: 'row-audit', sessionId: 'pty-audit', deviceId: 'dev-1', openedAt: '2026-04-29T00:00:00.000Z' });
    const audit = new D1PtyAuditStore(db);

    await audit.append({
      id: 'audit-1', sessionId: 'pty-audit', deviceId: 'dev-1', ts: '2026-04-29T00:00:01.000Z',
      eventType: 'pty_opened', actorType: 'admin_session', actorId: 'admin-1', summary: 'PTY opened', details: { cols: 80 },
    });

    const records = await audit.listBySession('pty-audit');
    expect(records).toEqual([expect.objectContaining({ id: 'audit-1', eventType: 'pty_opened', details: { cols: 80 } })]);
  });
});
