import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
import { AdminLockoutService } from './admin-lockout.service';

function createDatabaseService(): DatabaseService {
  class MockDatabaseService extends DatabaseService {
    private readonly db: Database;
    constructor() {
      super();
      this.db = new Database(':memory:');
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS admin_login_failures (
          clientId TEXT PRIMARY KEY,
          failureCount INTEGER NOT NULL DEFAULT 0,
          lastFailureAt INTEGER NOT NULL,
          lockedUntil INTEGER
        );
      `);
    }
    get connection(): Database {
      return this.db;
    }
  }
  return new MockDatabaseService();
}

function freezeTime(ms: number): () => void {
  const orig = Date.now;
  Date.now = () => ms;
  return () => { Date.now = orig; };
}

describe('AdminLockoutService', () => {
  let db: DatabaseService;
  let svc: AdminLockoutService;

  beforeEach(() => {
    db = createDatabaseService();
    svc = new AdminLockoutService(db);
  });

  afterEach(() => {
    (db.connection as Database).close();
  });

  describe('checkLockout', () => {
    it('allows login when there are no failures', () => {
      const status = svc.checkLockout('192.168.1.1');
      expect(status.allowed).toBe(true);
      expect(status.failureCount).toBe(0);
      expect(status.lockedOut).toBe(false);
    });

    it('allows login when failures are below threshold and delays have passed', () => {
      const now = Date.now();
      // Record 1 failure 2 seconds ago
      svc.recordFailure('192.168.1.1');
      const status = svc.checkLockout('192.168.1.1');
      expect(status.allowed).toBe(true); // 1st failure has no delay
    });
  });

  describe('recordFailure', () => {
    it('increments failure count on each call', () => {
      svc.recordFailure('192.168.1.1');
      let status = svc.checkLockout('192.168.1.1');
      expect(status.failureCount).toBe(1);

      svc.recordFailure('192.168.1.1');
      status = svc.checkLockout('192.168.1.1');
      expect(status.failureCount).toBe(2);

      svc.recordFailure('192.168.1.1');
      status = svc.checkLockout('192.168.1.1');
      expect(status.failureCount).toBe(3);
    });

    it('tracks failures independently per client', () => {
      svc.recordFailure('alice');
      svc.recordFailure('alice');

      svc.recordFailure('bob');

      expect(svc.checkLockout('alice').failureCount).toBe(2);
      expect(svc.checkLockout('bob').failureCount).toBe(1);
    });

    it('returns lockout status when over max failures', () => {
      for (let i = 0; i < 10; i++) {
        svc.recordFailure('hacker');
      }

      const status = svc.checkLockout('hacker');
      expect(status.lockedOut).toBe(true);
      expect(status.allowed).toBe(false);
    });
  });

  describe('resetLockout', () => {
    it('resets failure count and lockout after successful login', () => {
      for (let i = 0; i < 8; i++) {
        svc.recordFailure('ip-1');
      }

      expect(svc.checkLockout('ip-1').failureCount).toBe(8);

      svc.resetLockout('ip-1');
      expect(svc.checkLockout('ip-1').failureCount).toBe(0);
      expect(svc.checkLockout('ip-1').allowed).toBe(true);
      expect(svc.checkLockout('ip-1').lockedOut).toBe(false);
    });
  });

  describe('escalating delays', () => {
    it('the first failure allows immediate retry', () => {
      svc.recordFailure('client-1');
      const status = svc.checkLockout('client-1');
      expect(status.allowed).toBe(true);
      expect(status.retryAfterMs).toBe(0);
    });

    it('applies escalating delays for consecutive failures', () => {
      const now = Date.now();
      const restore = freezeTime(now);

      try {
        // Record 2 failures
        svc.recordFailure('client-2');
        svc.recordFailure('client-2');
        // 2nd failure: delay starts. Should not be allowed immediately
        let status = svc.checkLockout('client-2');
        expect(status.allowed).toBe(false);
        expect(status.retryAfterMs).toBeGreaterThan(0);

        // After the delay passes, should be allowed
        const delayDate = now + status.retryAfterMs + 1;
        Date.now = () => delayDate;
        status = svc.checkLockout('client-2');
        expect(status.allowed).toBe(true);
      } finally {
        restore();
      }
    });
  });

  describe('persistence', () => {
    it('survives service restarts', () => {
      const svc1 = new AdminLockoutService(db);
      svc1.recordFailure('ip-persist');
      svc1.recordFailure('ip-persist');

      // Create a new service instance (simulating restart)
      const svc2 = new AdminLockoutService(db);
      const status = svc2.checkLockout('ip-persist');
      expect(status.failureCount).toBe(2);
    });

    it('prunes expired lockouts', () => {
      // Insert an old lockout
      const oldTime = Date.now() - 60 * 60 * 1000; // 1 hour ago
      db.connection
        .prepare(
          'INSERT INTO admin_login_failures (clientId, failureCount, lastFailureAt, lockedUntil) VALUES (?, ?, ?, ?)',
        )
        .run('old-lockout', 15, oldTime, oldTime + 30 * 60 * 1000);

      // expired locks should be cleaned up, but the record should have been
      // pruned by the constructor, so failure count resets to 0
      const svc2 = new AdminLockoutService(db);
      const status = svc2.checkLockout('old-lockout');
      // The record may have been cleaned because lockedUntil expired
      // Either way: a new clean start
      expect(status.failureCount).toBe(0);
    });
  });
});
