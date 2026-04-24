import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('admin-next index.html', () => {
  it('links to the legacy favicon asset', () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');

    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
  });
});
