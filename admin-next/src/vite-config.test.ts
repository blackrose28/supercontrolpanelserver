import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vite dev proxy', () => {
  it('proxies admin PTY websocket upgrades to cc-server', () => {
    const source = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');

    expect(source).toMatch(/['"]\/admin['"]:\s*{[\s\S]*?target:\s*['"]http:\/\/localhost:4000['"][\s\S]*?ws:\s*true/s);
  });

  it('serves admin runtime SPA routes from vite instead of proxying', () => {
    const source = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');

    expect(source).toContain("req.url?.startsWith('/admin/devices/')");
  });
});

  it('documents the Cloudflare Pages build output directory', () => {
    const wrangler = readFileSync(resolve(__dirname, '../../wrangler.toml'), 'utf8');

    expect(wrangler).toMatch(/pages_build_output_dir\s*=\s*['"]public\/admin-next['"]/);
  });

