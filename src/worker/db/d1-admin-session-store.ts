import { hashSecret } from './worker-secrets';
import { D1LikeDatabase } from './d1-device-store';

export type AdminSessionInfo = {
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
};

export type CreateAdminSessionOptions = {
  ip?: string;
  userAgent?: string;
};

type AdminSessionRow = {
  token: string;
  createdAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
};

type AdminSessionStoreOptions = {
  now?: () => number;
  ttlMs?: number;
  tokenFactory?: () => string;
};

function randomToken(): string {
  return globalThis.crypto.randomUUID();
}

function mapSessionRow(row: AdminSessionRow): AdminSessionInfo {
  return {
    tokenHash: row.token,
    createdAt: new Date(row.createdAt),
    expiresAt: new Date(row.expiresAt),
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
  };
}

export class D1AdminSessionStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly tokenFactory: () => string;

  constructor(private readonly db: D1LikeDatabase, opts: AdminSessionStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 12 * 60 * 60 * 1000;
    this.tokenFactory = opts.tokenFactory ?? randomToken;
  }

  async createSession(opts?: CreateAdminSessionOptions): Promise<string> {
    await this.pruneExpired();
    const token = this.tokenFactory();
    const now = this.now();
    await this.db
      .prepare('INSERT INTO admin_sessions (token, expiresAt, createdAt, ip, userAgent) VALUES (?, ?, ?, ?, ?)')
      .bind(await hashSecret(token), now + this.ttlMs, now, opts?.ip ?? null, opts?.userAgent ?? null)
      .run();
    return token;
  }

  async isValid(token?: string | null): Promise<boolean> {
    if (!token) {
      return false;
    }
    await this.pruneExpired();
    const row = await this.db
      .prepare('SELECT expiresAt FROM admin_sessions WHERE token = ?')
      .bind(await hashSecret(token))
      .first<{ expiresAt?: number }>();
    return typeof row?.expiresAt === 'number' && row.expiresAt > this.now();
  }

  async clear(token?: string | null): Promise<void> {
    if (!token) {
      return;
    }
    await this.db.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(await hashSecret(token)).run();
  }

  async listSessions(): Promise<AdminSessionInfo[]> {
    await this.pruneExpired();
    const { results = [] } = await this.db
      .prepare('SELECT token, createdAt, expiresAt, ip, userAgent FROM admin_sessions WHERE expiresAt > ? ORDER BY createdAt DESC')
      .bind(this.now())
      .all<AdminSessionRow>();
    return results.map(mapSessionRow);
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.db.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(tokenHash).run();
  }

  async revokeAllExcept(currentToken?: string | null): Promise<void> {
    if (!currentToken) {
      return;
    }
    await this.db.prepare('DELETE FROM admin_sessions WHERE token != ?').bind(await hashSecret(currentToken)).run();
  }

  async getTokenInfo(token: string): Promise<AdminSessionInfo | null> {
    const row = await this.db
      .prepare('SELECT token, createdAt, expiresAt, ip, userAgent FROM admin_sessions WHERE token = ? AND expiresAt > ?')
      .bind(await hashSecret(token), this.now())
      .first<AdminSessionRow>();
    return row ? mapSessionRow(row) : null;
  }

  private async pruneExpired(): Promise<void> {
    await this.db.prepare('DELETE FROM admin_sessions WHERE expiresAt <= ?').bind(this.now()).run();
  }
}
