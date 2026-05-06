import { describe, expect, it } from 'vitest';
import { BoundedSeenIds } from './stream-dedupe';

describe('BoundedSeenIds', () => {
  it('keeps only the latest ids to avoid unbounded growth', () => {
    const seen = new BoundedSeenIds(3);

    expect(seen.rememberFresh(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(seen.snapshot()).toEqual(['a', 'b', 'c']);

    expect(seen.rememberFresh(['d', 'b', 'c'])).toEqual(['d']);
    expect(seen.snapshot()).toEqual(['d', 'b', 'c']);
    expect(seen.has('a')).toBe(false);
  });

  it('treats reintroduced ids as fresh once evicted from bounded state', () => {
    const seen = new BoundedSeenIds(2);

    expect(seen.rememberFresh(['a', 'b'])).toEqual(['a', 'b']);
    expect(seen.rememberFresh(['c', 'b'])).toEqual(['c']);
    expect(seen.rememberFresh(['a', 'c'])).toEqual(['a']);
    expect(seen.snapshot()).toEqual(['a', 'c']);
  });
});
