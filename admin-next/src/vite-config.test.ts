import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vite dev proxy', () => {
  it('proxies admin PTY websocket upgrades to cc-server', () => {
    const source = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');

    expect(source).toMatch(/['"]\/admin['"]:\s*{[\s\S]*?target:\s*['"]http:\/\/localhost:3000['"][\s\S]*?ws:\s*true/s);
  });
});
