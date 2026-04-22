import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './security-headers';

describe('Content Security Policy', () => {
  it('allows Cloudflare Web Analytics script and beacon domains', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self' https://cloudflareinsights.com");
  });
});
