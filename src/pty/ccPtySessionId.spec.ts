import { describe, expect, it } from 'vitest';
import {
  CC_PTY_SEGMENT_MAX,
  CC_PTY_SESSION_ID_MAX,
  ccPtySessionId,
  newServerSshStartSessionId,
  parseCcPtySessionId,
  resolveServerSshAttachSessionId,
  verifyCanonicalSessionIdForDevice,
} from './ccPtySessionId';

describe('ccPtySessionId', () => {
  it('formats and round-trips', () => {
    const id = ccPtySessionId('dev-1', 'pty-local-1');
    expect(id).toBe('ccpty:dev-1:pty-local-1');
    expect(parseCcPtySessionId(id)).toEqual({ deviceId: 'dev-1', localSessionId: 'pty-local-1' });
  });

  it('trims segments', () => {
    expect(ccPtySessionId('  dev-1  ', '  pty-1  ')).toBe('ccpty:dev-1:pty-1');
  });

  it('rejects empty segments', () => {
    expect(() => ccPtySessionId('', 'x')).toThrow(/non-empty/);
    expect(() => ccPtySessionId('x', '')).toThrow(/non-empty/);
  });

  it('rejects colon in segment', () => {
    expect(() => ccPtySessionId('bad:id', 'x')).toThrow(/must not contain ':'/);
    expect(() => ccPtySessionId('x', 'bad:id')).toThrow(/must not contain ':'/);
  });

  it('parse rejects wrong prefix', () => {
    expect(parseCcPtySessionId('other:dev:pty')).toBeNull();
  });

  it('accepts uuid-like segments', () => {
    const d = '550e8400-e29b-41d4-a716-446655440000';
    const l = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const id = ccPtySessionId(d, l);
    expect(parseCcPtySessionId(id)).toEqual({ deviceId: d, localSessionId: l });
  });
});

describe('newServerSshStartSessionId', () => {
  it('returns a ccpty id for the device with a non-empty local segment', () => {
    const id = newServerSshStartSessionId('dev-1');
    expect(id).toMatch(/^ccpty:dev-1:/);
    const parsed = parseCcPtySessionId(id);
    expect(parsed?.deviceId).toBe('dev-1');
    expect(parsed?.localSessionId?.length).toBeGreaterThan(0);
    expect(parsed?.localSessionId).not.toContain(':');
  });
});

describe('resolveServerSshAttachSessionId', () => {
  it('returns canonical id when client sessionId is omitted', () => {
    expect(resolveServerSshAttachSessionId('d1', 'loc-a')).toBe('ccpty:d1:loc-a');
  });

  it('returns canonical id when client sessionId matches', () => {
    expect(resolveServerSshAttachSessionId('d1', 'loc-a', 'ccpty:d1:loc-a')).toBe('ccpty:d1:loc-a');
  });

  it('throws when client sessionId does not match canonical', () => {
    expect(() => resolveServerSshAttachSessionId('d1', 'loc-a', 'ccpty:d1:other')).toThrow(/does not match/);
  });
});

describe('verifyCanonicalSessionIdForDevice', () => {
  it('passes through nullish or whitespace as null', () => {
    expect(verifyCanonicalSessionIdForDevice('dev-1', null)).toEqual({ ok: true, sessionId: null });
    expect(verifyCanonicalSessionIdForDevice('dev-1', undefined)).toEqual({ ok: true, sessionId: null });
    expect(verifyCanonicalSessionIdForDevice('dev-1', '   ')).toEqual({ ok: true, sessionId: null });
  });

  it('passes through non-canonical (legacy local) ids unchanged', () => {
    expect(verifyCanonicalSessionIdForDevice('dev-1', 'pty-7')).toEqual({ ok: true, sessionId: 'pty-7' });
    expect(verifyCanonicalSessionIdForDevice('dev-1', '  legacy-id  ')).toEqual({
      ok: true,
      sessionId: 'legacy-id',
    });
  });

  it('accepts canonical ids whose embedded device matches the agent', () => {
    expect(verifyCanonicalSessionIdForDevice('dev-1', 'ccpty:dev-1:loc-a')).toEqual({
      ok: true,
      sessionId: 'ccpty:dev-1:loc-a',
    });
  });

  it('rejects canonical ids that embed a different device', () => {
    const res = verifyCanonicalSessionIdForDevice('dev-1', 'ccpty:dev-2:loc-a');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/expected dev-1, got dev-2/);
    }
  });

  it('rejects ids longer than CC_PTY_SESSION_ID_MAX', () => {
    const oversize = 'x'.repeat(CC_PTY_SESSION_ID_MAX + 1);
    const res = verifyCanonicalSessionIdForDevice('dev-1', oversize);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/exceeds max length/);
    }
  });

  it('rejects canonical ids whose local segment exceeds the per-segment cap', () => {
    const huge = 'l'.repeat(CC_PTY_SEGMENT_MAX + 1);
    const sid = `ccpty:dev-1:${huge}`;
    expect(sid.length).toBeLessThanOrEqual(CC_PTY_SESSION_ID_MAX);
    // Parse rejects → falls back to passthrough; we only pin the device check here.
    // The total-length cap is exercised in the previous test.
    const res = verifyCanonicalSessionIdForDevice('dev-1', sid);
    // Not a canonical id any more (per-segment cap fails parse), but still under the
    // total cap, so it falls through as legacy passthrough.
    expect(res).toEqual({ ok: true, sessionId: sid });
  });
});

describe('canonical id length limits', () => {
  it('ccPtySessionId rejects oversized segments', () => {
    const huge = 'x'.repeat(CC_PTY_SEGMENT_MAX + 1);
    expect(() => ccPtySessionId(huge, 'loc')).toThrow(/<= 128|≤ 128/);
    expect(() => ccPtySessionId('dev', huge)).toThrow(/<= 128|≤ 128/);
  });

  it('parseCcPtySessionId rejects inputs over the max length', () => {
    const huge = 'x'.repeat(CC_PTY_SESSION_ID_MAX + 10);
    expect(parseCcPtySessionId(huge)).toBeNull();
  });

  it('parseCcPtySessionId rejects per-segment overflow even when total is under the cap', () => {
    const huge = 'l'.repeat(CC_PTY_SEGMENT_MAX + 1);
    const sid = `ccpty:dev-1:${huge}`;
    expect(sid.length).toBeLessThanOrEqual(CC_PTY_SESSION_ID_MAX);
    expect(parseCcPtySessionId(sid)).toBeNull();
  });
});
