import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
import { AdminSessionService } from './admin-session.service';
import { hashSecret } from '../config/secrets';

function createDatabaseService(): DatabaseService {
  class MockDatabaseService extends DatabaseService {
    private readonly db: Database;
    constructor() {
      super();
      this.db = new Database(':memory:');
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS admin_sessions (
          token TEXT PRIMARY KEY,
          expiresAt INTEGER NOT NULL,
          createdAt INTEGER NOT NULL,
          ip TEXT,
          userAgent TEXT
        );
      `);
    }
    get connection(): Database {
      return this.db;
    }
  }
  return new MockDatabaseService();
}

describe('AdminSessionService — session management', () => {
  let db: DatabaseService;
  let svc: AdminSessionService;

  beforeEach(() => {
    db = createDatabaseService();
    svc = new AdminSessionService(db);
  });

  afterEach(() => {
    (db.connection as Database).close();
  });

  it('createSession records ip and userAgent', () => {
    const token = svc.createSession({ ip: '10.0.0.1', userAgent: 'Firefox/120' });

    expect(token).toBeTruthy();

    const row = db.connection
      .prepare('SELECT ip, userAgent FROM admin_sessions')
      .get() as { ip: string; userAgent: string } | undefined;

    expect(row).toBeTruthy();
    expect(row!.ip).toBe('10.0.0.1');
    expect(row!.userAgent).toBe('Firefox/120');
  });

  it('createSession still works without ip/userAgent (backward compat)', () => {
    const token = svc.createSession();

    expect(token).toBeTruthy();
    expect(svc.isValid(token)).toBe(true);
  });

  it('listSessions returns active sessions with metadata', () => {
    svc.createSession({ ip: '1.1.1.1', userAgent: 'Chrome/100' });
    svc.createSession({ ip: '2.2.2.2', userAgent: 'Safari/15' });

    const sessions = svc.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].ip).toBeTruthy();
    expect(sessions[1].ip).toBeTruthy();
    // Token hash is exposed as an opaque identifier for revocation
    expect(sessions[0].tokenHash).toBeTruthy();
  });

  it('listSessions does not return expired sessions', () => {
    // Insert an expired session directly
    const oldTime = Date.now() - 60 * 60 * 1000;
    db.connection
      .prepare('INSERT INTO admin_sessions (token, expiresAt, createdAt, ip) VALUES (?, ?, ?, ?)')
      .run(hashSecret('old-token'), oldTime - 1000, oldTime, '3.3.3.3');

    svc.createSession({ ip: '4.4.4.4' });

    const sessions = svc.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ip).toBe('4.4.4.4');
  });

  it('revokeSession deletes a session by tokenHash', () => {
    svc.createSession({ ip: '5.5.5.5' });
    const sessions = svc.listSessions();
    expect(sessions).toHaveLength(1);

    svc.revokeSession(sessions[0].tokenHash);
    expect(svc.listSessions()).toHaveLength(0);
  });

  it('revokeAllExcept clears all sessions except the current one', () => {
    const keepToken = svc.createSession({ ip: 'keep-me' });
    svc.createSession({ ip: 'delete-1' });
    svc.createSession({ ip: 'delete-2' });

    expect(svc.listSessions()).toHaveLength(3);

    svc.revokeAllExcept(keepToken);
    const remaining = svc.listSessions();

    expect(remaining).toHaveLength(1);
    expect(svc.isValid(keepToken)).toBe(true);
  });
});
