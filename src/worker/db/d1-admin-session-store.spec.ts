import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { D1_SCHEMA_SQL } from './d1-schema';
import { D1AdminSessionStore } from './d1-admin-session-store';

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

describe('D1AdminSessionStore', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  function createStore(now = 1_000_000) {
    const db = new TestD1Database();
    databases.push(db);
    return new D1AdminSessionStore(db, { now: () => now, ttlMs: 60_000, tokenFactory: () => 'session-token' });
  }

  it('creates hashed sessions with metadata and validates raw token', async () => {
    const store = createStore();

    const token = await store.createSession({ ip: '10.0.0.1', userAgent: 'Firefox/120' });

    expect(token).toBe('session-token');
    await expect(store.isValid(token)).resolves.toBe(true);
    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ ip: '10.0.0.1', userAgent: 'Firefox/120' });
    expect(sessions[0].tokenHash).toMatch(/^sha256:/);
  });

  it('revokes individual sessions by token hash and all except current raw token', async () => {
    let nextToken = 'keep-token';
    const db = new TestD1Database();
    databases.push(db);
    const store = new D1AdminSessionStore(db, { now: () => 1_000_000, ttlMs: 60_000, tokenFactory: () => nextToken });

    const keep = await store.createSession({ ip: 'keep' });
    nextToken = 'delete-token';
    await store.createSession({ ip: 'delete' });

    expect(await store.listSessions()).toHaveLength(2);
    await store.revokeAllExcept(keep);
    const remaining = await store.listSessions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].ip).toBe('keep');

    await store.revokeSession(remaining[0].tokenHash);
    await expect(store.listSessions()).resolves.toHaveLength(0);
  });

  it('prunes expired sessions before reads', async () => {
    const db = new TestD1Database();
    databases.push(db);
    await db.prepare('INSERT INTO admin_sessions (token, expiresAt, createdAt, ip, userAgent) VALUES (?, ?, ?, ?, ?)')
      .bind('expired-hash', 999, 1, 'old', null)
      .run();
    const store = new D1AdminSessionStore(db, { now: () => 1_000, ttlMs: 60_000, tokenFactory: () => 'new-token' });

    await store.createSession({ ip: 'new' });

    const sessions = await store.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ip).toBe('new');
  });
});
