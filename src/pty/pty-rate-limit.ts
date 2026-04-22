export type RateLimitBucket = {
  tokens: number;
  lastRefillAt: number;
};

export function consumeRateLimit(
  buckets: Map<string, RateLimitBucket>,
  key: string,
  burst: number,
  refillPerSecond: number,
  now: number,
): { allowed: boolean; retryAfterMs: number } {
  const bucket = buckets.get(key) ?? { tokens: burst, lastRefillAt: now };
  const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
  const refilledTokens = (elapsedMs / 1000) * refillPerSecond;
  bucket.tokens = Math.min(burst, bucket.tokens + refilledTokens);
  bucket.lastRefillAt = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return { allowed: true, retryAfterMs: 0 };
  }
  buckets.set(key, bucket);
  const missingTokens = 1 - bucket.tokens;
  return {
    allowed: false,
    retryAfterMs: Math.max(1, Math.ceil((missingTokens / refillPerSecond) * 1000)),
  };
}
