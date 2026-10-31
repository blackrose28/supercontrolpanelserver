import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './security-headers';

const getDirective = (name: string) =>
  CONTENT_SECURITY_POLICY.split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith(`${name} `)) ?? '';

describe('Content Security Policy', () => {
  it('allows Cloudflare Web Analytics script and beacon domains', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com");
    expect(getDirective('connect-src').split(/\s+/)).toEqual(
      expect.arrayContaining(["'self'", 'https://cloudflareinsights.com']),
    );
  });

  it('allows same-origin admin PTY websocket connections', () => {
    expect(getDirective('connect-src').split(/\s+/)).toEqual(
      expect.arrayContaining(["'self'", 'ws:', 'wss:', 'https://cloudflareinsights.com']),
    );
  });
});
