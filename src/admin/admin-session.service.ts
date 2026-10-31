import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { hashSecret } from '../config/secrets';

export type SessionInfo = {
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
};

export type CreateSessionOptions = {
  ip?: string;
  userAgent?: string;
};

@Injectable()
export class AdminSessionService {
  private readonly ttlMs: number;

  constructor(private readonly databaseService: DatabaseService) {
    const parsed = Number(process.env.CC_ADMIN_SESSION_TTL_HOURS);
    const ttlHours = Number.isFinite(parsed) && parsed > 0 ? parsed : 12;
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.pruneExpired();
  }

  getTtlMs(): number {
    return this.ttlMs;
  }

  createSession(opts?: CreateSessionOptions): string {
    this.pruneExpired();
    const token = randomUUID();
    const now = Date.now();
    const tokenHash = hashSecret(token);
    this.databaseService.connection
      .prepare(
        `
          INSERT INTO admin_sessions (token, expiresAt, createdAt, ip, userAgent)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(tokenHash, now + this.ttlMs, now, opts?.ip ?? null, opts?.userAgent ?? null);
    return token;
  }

  isValid(token?: string | null): boolean {
    if (!token) {
      return false;
    }
    this.pruneExpired();
    const row = this.databaseService.connection
      .prepare(`SELECT expiresAt FROM admin_sessions WHERE token = ?`)
      .get(hashSecret(token)) as { expiresAt?: number } | undefined;
    const expiresAt = row?.expiresAt;
    if (!expiresAt) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      this.clear(token);
      return false;
    }
    return true;
  }

  clear(token?: string | null) {
    if (!token) {
      return;
    }
    this.databaseService.connection
      .prepare(`DELETE FROM admin_sessions WHERE token = ?`)
      .run(hashSecret(token));
  }

  listSessions(): SessionInfo[] {
    this.pruneExpired();
    const rows = this.databaseService.connection
      .prepare(
        `SELECT token, createdAt, expiresAt, ip, userAgent FROM admin_sessions WHERE expiresAt > ? ORDER BY createdAt DESC`,
      )
      .all(Date.now()) as Array<{
        token: string;
        createdAt: number;
        expiresAt: number;
        ip: string | null;
        userAgent: string | null;
      }>;

    return rows.map((row) => ({
      tokenHash: row.token,
      createdAt: new Date(row.createdAt),
      expiresAt: new Date(row.expiresAt),
      ip: row.ip ?? null,
      userAgent: row.userAgent ?? null,
    }));
  }

  revokeSession(tokenHash: string) {
    this.databaseService.connection
      .prepare('DELETE FROM admin_sessions WHERE token = ?')
      .run(tokenHash);
  }

  revokeAllExcept(currentToken?: string | null) {
    if (!currentToken) return;
    const currentHash = hashSecret(currentToken);
    this.databaseService.connection
      .prepare('DELETE FROM admin_sessions WHERE token != ?')
      .run(currentHash);
  }

  getTokenInfo(token: string): SessionInfo | null {
    const tokenHash = hashSecret(token);
    const row = this.databaseService.connection
      .prepare(
        'SELECT token, createdAt, expiresAt, ip, userAgent FROM admin_sessions WHERE token = ? AND expiresAt > ?',
      )
      .get(tokenHash, Date.now()) as
      | {
          token: string;
          createdAt: number;
          expiresAt: number;
          ip: string | null;
          userAgent: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      tokenHash: row.token,
      createdAt: new Date(row.createdAt),
      expiresAt: new Date(row.expiresAt),
      ip: row.ip ?? null,
      userAgent: row.userAgent ?? null,
    };
  }

  private pruneExpired() {
    this.databaseService.connection
      .prepare(`DELETE FROM admin_sessions WHERE expiresAt <= ?`)
      .run(Date.now());
  }
}
