import { describe, expect, it } from 'vitest';
import { formatTimestamp } from './formatTimestamp';

describe('formatTimestamp', () => {
  it('formats ISO timestamps in GMT+7', () => {
    expect(formatTimestamp('2026-04-20T00:00:00.000Z')).toBe('2026-04-20 07:00:00 GMT+7');
  });

  it('returns dash for empty values', () => {
    expect(formatTimestamp(null)).toBe('-');
    expect(formatTimestamp(undefined)).toBe('-');
    expect(formatTimestamp('')).toBe('-');
  });

  it('falls back to raw text for invalid timestamps', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});
