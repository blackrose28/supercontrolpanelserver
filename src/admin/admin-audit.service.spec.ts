import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
import { AdminAuditService, AuditEvent } from './admin-audit.service';

function createDatabaseService(): DatabaseService {
  class MockDatabaseService extends DatabaseService {
    private readonly db: Database;
    constructor() {
      super();
      this.db = new Database(':memory:');
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS admin_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event TEXT NOT NULL,
          actor TEXT,
          details TEXT,
          createdAt INTEGER NOT NULL
        );
      `);
    }
    get connection(): Database {
      return this.db;
    }
  }
  return new MockDatabaseService();
}

describe('AdminAuditService', () => {
  let db: DatabaseService;
  let svc: AdminAuditService;

  beforeEach(() => {
    db = createDatabaseService();
    svc = new AdminAuditService(db);
  });

  afterEach(() => {
    (db.connection as Database).close();
  });

  it('logs an event with actor and details', () => {
    svc.log('LOGIN_SUCCESS', '10.0.0.1', { userAgent: 'Chrome' });

    const rows = svc.list({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('LOGIN_SUCCESS');
    expect(rows[0].actor).toBe('10.0.0.1');
    expect(rows[0].details).toEqual({ userAgent: 'Chrome' });
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('logs multiple events and orders them by newest first', () => {
    svc.log('LOGIN_FAILED', '10.0.0.1', { reason: 'wrong-password' });
    svc.log('LOGIN_SUCCESS', '10.0.0.2');
    svc.log('TOTP_ENABLED', '10.0.0.2');

    const rows = svc.list({ limit: 50 });
    expect(rows).toHaveLength(3);
    expect(rows[0].event).toBe('TOTP_ENABLED'); // newest first
    expect(rows[2].event).toBe('LOGIN_FAILED'); // oldest last
  });

  it('supports filtering by event type', () => {
    svc.log('LOGIN_SUCCESS', '10.0.0.1');
    svc.log('LOGIN_FAILED', '10.0.0.2');

    const filtered = svc.list({ limit: 10, event: 'LOGIN_FAILED' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].event).toBe('LOGIN_FAILED');
  });

  it('supports filtering by actor', () => {
    svc.log('LOGIN_SUCCESS', 'alice');
    svc.log('LOGIN_SUCCESS', 'bob');

    const filtered = svc.list({ limit: 10, actor: 'alice' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].actor).toBe('alice');
  });

  it('supports pagination with limit', () => {
    svc.log('A', 'x');
    svc.log('B', 'x');
    svc.log('C', 'x');

    const rows = svc.list({ limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].event).toBe('C');
    expect(rows[1].event).toBe('B');
  });

  it('handles empty details', () => {
    svc.log('LOGIN_SUCCESS', '10.0.0.1');

    const rows = svc.list({ limit: 1 });
    expect(rows[0].details).toBeNull();
  });
});
