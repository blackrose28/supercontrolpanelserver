import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

export type RateLimitCheckResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number };

@Injectable()
export class RateLimitService {
  private readonly buckets = new Map<string, RateLimitBucket>();

  check(key: string, limit: number, windowMs: number) {
    const result = this.checkDetailed(key, limit, windowMs);
    if (!result.ok) {
      throw new HttpException('RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  checkDetailed(key: string, limit: number, windowMs: number): RateLimitCheckResult {
    const now = Date.now();
    const current = this.buckets.get(key);

    if (!current || current.resetAt <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      return { ok: true };
    }

    if (current.count >= limit) {
      return {
        ok: false,
        retryAfterMs: Math.max(1, current.resetAt - now),
      };
    }

    current.count += 1;
    this.buckets.set(key, current);
    return { ok: true };
  }

  loginLimit() {
    return this.parsePositiveInt(process.env.CC_RATE_LIMIT_LOGIN_MAX, 10);
  }

  loginWindowMs() {
    return this.parsePositiveInt(process.env.CC_RATE_LIMIT_LOGIN_WINDOW_MS, 5 * 60 * 1000);
  }

  enrollLimit() {
    return this.parsePositiveInt(process.env.CC_RATE_LIMIT_ENROLL_MAX, 20);
  }

  enrollWindowMs() {
    return this.parsePositiveInt(process.env.CC_RATE_LIMIT_ENROLL_WINDOW_MS, 5 * 60 * 1000);
  }

  ingestLimit() {
    return this.parsePositiveInt(process.env.CC_RATE_LIMIT_INGEST_MAX, 600);
  }

  ingestWindowMs() {
    return this.parsePositiveInt(process.env.CC_RATE_LIMIT_INGEST_WINDOW_MS, 60 * 1000);
  }

  private parsePositiveInt(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1) {
      return fallback;
    }
    return Math.floor(value);
  }
}
