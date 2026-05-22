import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
import { RateLimitService } from './rate-limit.service';

function createDatabaseService(): DatabaseService {
  class MockDatabaseService extends DatabaseService {
    private readonly db: Database;
    constructor() {
      super();
      this.db = new Database(':memory:');
      this.db.pragma('journal_mode = WAL');
      this.initTables();
    }
    get connection(): Database {
      return this.db;
    }
    private initTables() {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, lastSeenAt TEXT NOT NULL,
          status TEXT NOT NULL, agentToken TEXT NOT NULL, os TEXT
        );
        CREATE TABLE IF NOT EXISTS admin_sessions (
          token TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_api_tokens (
          tokenId TEXT PRIMARY KEY, tokenHash TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL, scopesJson TEXT NOT NULL,
          createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
          lastUsedAt INTEGER, revokedAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS rate_limit_buckets (
          key TEXT PRIMARY KEY, count INTEGER NOT NULL, resetAt INTEGER NOT NULL
        );
      `);
    }
  }
  return new MockDatabaseService();
}

describe('RateLimitService — persistent', () => {
  let db: DatabaseService;

  beforeEach(() => {
    db = createDatabaseService();
  });

  afterEach(() => {
    (db.connection as Database).close();
  });

  it('persists bucket state to SQLite', () => {
    const svc = new RateLimitService(db);
    const key = 'login:192.168.1.1';

    for (let i = 0; i < 5; i++) {
      svc.checkDetailed(key, 10, 60_000);
    }

    // Verify the bucket was persisted to SQLite
    const row = db.connection
      .prepare('SELECT count, resetAt FROM rate_limit_buckets WHERE key = ?')
      .get(key) as { count: number; resetAt: number } | undefined;

    expect(row).toBeTruthy();
    expect(row!.count).toBe(5);
    expect(row!.resetAt).toBeGreaterThan(Date.now());
  });

  it('restores bucket state from SQLite on construction', () => {
    // First instance: use and persist
    const svc1 = new RateLimitService(db);
    svc1.checkDetailed('login:alice', 10, 60_000);
    svc1.checkDetailed('login:alice', 10, 60_000);
    svc1.checkDetailed('login:alice', 10, 60_000);

    // Second instance: should restore state from SQLite
    const svc2 = new RateLimitService(db);
    const result = svc2.checkDetailed('login:alice', 10, 60_000);
    expect(result.ok).toBe(true); // count 3 → 4, still under limit

    // After hitting the limit across instances, should be denied
    for (let i = 0; i < 6; i++) {
      svc2.checkDetailed('login:alice', 10, 60_000);
    }
    const blocked = svc2.checkDetailed('login:alice', 10, 60_000);
    expect(blocked.ok).toBe(false);
  });

  it('resets bucket when window expires', () => {
    const svc = new RateLimitService(db);

    // Use a very short window
    svc.checkDetailed('login:bob', 5, 10);
    svc.checkDetailed('login:bob', 5, 10);
    svc.checkDetailed('login:bob', 5, 10);

    // Verify in DB
    let row = db.connection
      .prepare('SELECT count FROM rate_limit_buckets WHERE key = ?')
      .get('login:bob') as { count: number } | undefined;
    expect(row!.count).toBe(3);

    // Wait for window to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // After expiry, a new check should reset the bucket
        const result = svc.checkDetailed('login:bob', 5, 10);
        expect(result.ok).toBe(true);

        row = db.connection
          .prepare('SELECT count FROM rate_limit_buckets WHERE key = ?')
          .get('login:bob') as { count: number } | undefined;
        expect(row!.count).toBe(1); // reset to 1

        resolve();
      }, 20);
    });
  });

  it('check() throws HttpException when rate limited (backward compat)', () => {
    const svc = new RateLimitService(db);

    // Fill up the bucket
    for (let i = 0; i < 3; i++) {
      svc.check('login:charlie', 3, 60_000);
    }

    // Next call should throw
    expect(() => svc.check('login:charlie', 3, 60_000)).toThrow('RATE_LIMITED');
  });

  it('prunes expired rows from SQLite', () => {
    // Directly insert an expired row into SQLite
    const expiredKey = 'old:bucket';
    db.connection
      .prepare('INSERT INTO rate_limit_buckets (key, count, resetAt) VALUES (?, ?, ?)')
      .run(expiredKey, 10, Date.now() - 10_000); // expired 10 seconds ago

    // Also insert a valid row
    const validKey = 'valid:bucket';
    db.connection
      .prepare('INSERT INTO rate_limit_buckets (key, count, resetAt) VALUES (?, ?, ?)')
      .run(validKey, 1, Date.now() + 60_000);

    // Creating the service should prune the expired row
    const svc = new RateLimitService(db);

    // Expired row should be gone
    const expiredRow = db.connection
      .prepare('SELECT key FROM rate_limit_buckets WHERE key = ?')
      .get(expiredKey);
    expect(expiredRow).toBeUndefined();

    // Valid row should still exist
    const validRow = db.connection
      .prepare('SELECT key FROM rate_limit_buckets WHERE key = ?')
      .get(validKey);
    expect(validRow).toBeTruthy();

    // The expired key should be available for new requests
    const result = svc.checkDetailed(expiredKey, 3, 60_000);
    expect(result.ok).toBe(true);
  });

  it('retryAfterMs is calculated correctly', () => {
    const svc = new RateLimitService(db);

    // Fill the bucket exactly
    for (let i = 0; i < 5; i++) {
      svc.checkDetailed('login:dave', 5, 30_000);
    }

    // Next check should fail with retry info
    const blocked = svc.checkDetailed('login:dave', 5, 30_000);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(30_000);
    }
  });

  it('does not persist to DB when bucket is over limit (read-only)', () => {
    const svc = new RateLimitService(db);

    // Fill the bucket exactly
    for (let i = 0; i < 3; i++) {
      svc.checkDetailed('login:eve', 3, 60_000);
    }

    // This call is blocked — should NOT update DB
    svc.checkDetailed('login:eve', 3, 60_000);

    // DB should still show count=3, not 4
    const row = db.connection
      .prepare('SELECT count FROM rate_limit_buckets WHERE key = ?')
      .get('login:eve') as { count: number } | undefined;
    expect(row!.count).toBe(3);
  });
});
