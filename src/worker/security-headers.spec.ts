import { describe, expect, it } from 'vitest';
import worker from './index';

describe('Worker security headers', () => {
  it('adds baseline security headers to JSON responses', async () => {
    const response = await worker.fetch(new Request('https://cc.example.test/v1/health'), {} as any);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
    expect(response.headers.get('permissions-policy')).toContain('microphone=()');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});
