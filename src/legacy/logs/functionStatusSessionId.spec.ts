import { describe, expect, it } from 'vitest';
import { coalesceFunctionStatusSessionId } from './functionStatusSessionId';

describe('coalesceFunctionStatusSessionId', () => {
  it('prefers non-empty top-level sessionId over payload', () => {
    expect(
      coalesceFunctionStatusSessionId('ccpty:dev-1:local-1', { sessionId: 'legacy-local-only' }),
    ).toBe('ccpty:dev-1:local-1');
  });

  it('trims top-level id', () => {
    expect(coalesceFunctionStatusSessionId('  ccpty:d:l  ', { sessionId: 'x' })).toBe('ccpty:d:l');
  });

  it('falls back to payload when top-level is empty', () => {
    expect(coalesceFunctionStatusSessionId('', { sessionId: 'pty-1' })).toBe('pty-1');
    expect(coalesceFunctionStatusSessionId(undefined, { sessionId: 'pty-2' })).toBe('pty-2');
  });

  it('returns null when neither side has a string session id', () => {
    expect(coalesceFunctionStatusSessionId(null, {})).toBeNull();
    expect(coalesceFunctionStatusSessionId(undefined, { sessionId: null })).toBeNull();
  });
});
