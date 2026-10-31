import { describe, expect, it } from 'vitest';
import { authFailureDelay } from './admin-auth';

describe('authFailureDelay', () => {
  it('resolves after a delay between 50-200ms', async () => {
    const start = Date.now();
    await authFailureDelay();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(30); // Allow some clock skew
    expect(elapsed).toBeLessThan(250); // Upper bound with overhead
  });

  it('produces varying delays across calls', async () => {
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      await authFailureDelay();
      delays.push(Date.now() - start);
    }

    // At least some variation — not all identical
    const unique = new Set(delays);
    expect(unique.size).toBeGreaterThan(1);
  });

  it('does not throw', async () => {
    await expect(authFailureDelay()).resolves.toBeUndefined();
  });
});
