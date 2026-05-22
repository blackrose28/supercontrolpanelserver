import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type AdminLockoutStatus = {
  allowed: boolean;
  retryAfterMs: number;
  failureCount: number;
  lockedOut: boolean;
};

const MAX_FAILURES = (() => {
  const value = Number(process.env.CC_LOGIN_MAX_FAILURES);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 10;
})();

const LOCKOUT_MS = (() => {
  const value = Number(process.env.CC_LOGIN_LOCKOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 30 * 60 * 1000;
})();

function delayMs(failureCount: number): number {
  if (failureCount <= 1) return 0;
  const exponent = Math.min(failureCount - 2, 5);
  return Math.min(1000 * Math.pow(2, exponent), 32000);
}

@Injectable()
export class AdminLockoutService {
  constructor(private readonly databaseService: DatabaseService) {
    this.pruneExpired();
  }

  recordFailure(clientId: string): AdminLockoutStatus {
    const now = Date.now();
    const existing = this.find(clientId);
    const newCount = (existing?.failureCount ?? 0) + 1;

    const lockedUntil =
      newCount >= MAX_FAILURES ? now + LOCKOUT_MS : null;

    this.databaseService.connection
      .prepare(
        `INSERT INTO admin_login_failures (clientId, failureCount, lastFailureAt, lockedUntil)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(clientId) DO UPDATE
         SET failureCount = excluded.failureCount,
             lastFailureAt = excluded.lastFailureAt,
             lockedUntil = excluded.lockedUntil`,
      )
      .run(clientId, newCount, now, lockedUntil);

    return this.status(newCount, now, lockedUntil);
  }

  checkLockout(clientId: string): AdminLockoutStatus {
    const existing = this.find(clientId);
    if (!existing) {
      return { allowed: true, retryAfterMs: 0, failureCount: 0, lockedOut: false };
    }
    return this.status(existing.failureCount, existing.lastFailureAt, existing.lockedUntil);
  }

  resetLockout(clientId: string): void {
    this.databaseService.connection
      .prepare('DELETE FROM admin_login_failures WHERE clientId = ?')
      .run(clientId);
  }

  private find(clientId: string): {
    failureCount: number;
    lastFailureAt: number;
    lockedUntil: number | null;
  } | null {
    const row = this.databaseService.connection
      .prepare(
        'SELECT failureCount, lastFailureAt, lockedUntil FROM admin_login_failures WHERE clientId = ?',
      )
      .get(clientId) as
      | {
          failureCount: number;
          lastFailureAt: number;
          lockedUntil: number | null;
        }
      | undefined;

    return row ?? null;
  }

  private status(
    failureCount: number,
    lastFailureAt: number,
    lockedUntil: number | null,
  ): AdminLockoutStatus {
    const now = Date.now();

    if (lockedUntil && now < lockedUntil) {
      return {
        allowed: false,
        retryAfterMs: lockedUntil - now,
        failureCount,
        lockedOut: true,
      };
    }

    if (lockedUntil && now >= lockedUntil) {
      // Lockout expired — treat as fresh start
      return { allowed: true, retryAfterMs: 0, failureCount: 0, lockedOut: false };
    }

    const delay = delayMs(failureCount);
    const allowedAt = lastFailureAt + delay;

    if (now >= allowedAt) {
      return { allowed: true, retryAfterMs: 0, failureCount, lockedOut: false };
    }

    return {
      allowed: false,
      retryAfterMs: allowedAt - now,
      failureCount,
      lockedOut: false,
    };
  }

  private pruneExpired() {
    const now = Date.now();
    this.databaseService.connection
      .prepare(
        'DELETE FROM admin_login_failures WHERE lockedUntil IS NOT NULL AND lockedUntil <= ?',
      )
      .run(now);
  }
}
