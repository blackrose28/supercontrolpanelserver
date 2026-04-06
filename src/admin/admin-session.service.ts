import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { hashSecret } from '../config/secrets';

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

  createSession(): string {
    this.pruneExpired();
    const token = randomUUID();
    const now = Date.now();
    this.databaseService.connection
      .prepare(
        `
          INSERT INTO admin_sessions (token, expiresAt, createdAt)
          VALUES (?, ?, ?)
        `,
      )
      .run(hashSecret(token), now + this.ttlMs, now);
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

  private pruneExpired() {
    this.databaseService.connection
      .prepare(`DELETE FROM admin_sessions WHERE expiresAt <= ?`)
      .run(Date.now());
  }
}
