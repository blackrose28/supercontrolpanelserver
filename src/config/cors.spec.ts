import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildCorsOptions } from './cors';

describe('cors - buildCorsOptions', () => {
  beforeEach(() => {
    delete process.env.CC_CORS_ORIGIN;
  });

  afterEach(() => {
    delete process.env.CC_CORS_ORIGIN;
  });

  it('defaults to http://localhost:3000 when CC_CORS_ORIGIN is not set', () => {
    const options = buildCorsOptions();
    expect(options.origin).toBeTypeOf('function');
    // Origin function should match localhost:3000
    const originFn = options.origin as (origin: string, cb: (err: Error | null, ok?: boolean) => void) => void;

    originFn('http://localhost:3000', (err, ok) => {
      expect(err).toBeNull();
      expect(ok).toBe(true);
    });

    originFn('https://evil.com', (err, ok) => {
      expect(err).toBeNull();
      expect(ok).toBe(false);
    });
  });

  it('allows explicitly configured origins', () => {
    process.env.CC_CORS_ORIGIN = 'https://myadmin.example.com,https://admin.local:8443';
    const options = buildCorsOptions();
    const originFn = options.origin as (origin: string, cb: (err: Error | null, ok?: boolean) => void) => void;

    originFn('https://myadmin.example.com', (err, ok) => {
      expect(err).toBeNull();
      expect(ok).toBe(true);
    });

    originFn('https://admin.local:8443', (err, ok) => {
      expect(err).toBeNull();
      expect(ok).toBe(true);
    });

    originFn('https://evil.com', (err, ok) => {
      expect(err).toBeNull();
      expect(ok).toBe(false);
    });
  });

  it('allows any origin when CC_CORS_ORIGIN is *', () => {
    process.env.CC_CORS_ORIGIN = '*';
    const options = buildCorsOptions();

    // When wildcard, origin is set to true (allow all)
    expect(options.origin).toBe(true);
  });

  it('enables credentials', () => {
    const options = buildCorsOptions();
    expect(options.credentials).toBe(true);
  });

  it('allows standard methods', () => {
    const options = buildCorsOptions();
    expect(options.methods).toContain('GET');
    expect(options.methods).toContain('POST');
    expect(options.methods).toContain('PUT');
    expect(options.methods).toContain('DELETE');
  });

  it('trims whitespace from configured origins', () => {
    process.env.CC_CORS_ORIGIN = '  https://a.example.com , https://b.example.com  ';
    const options = buildCorsOptions();
    const originFn = options.origin as (origin: string, cb: (err: Error | null, ok?: boolean) => void) => void;

    originFn('https://a.example.com', (err, ok) => {
      expect(err).toBeNull();
      expect(ok).toBe(true);
    });

    originFn('https://b.example.com', (err, ok) => {
      expect(err).toBeNull();
      expect(ok).toBe(true);
    });
  });
});
