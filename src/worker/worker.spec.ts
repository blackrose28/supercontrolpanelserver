import { describe, expect, it } from 'vitest';
import worker from './index';

describe('Cloudflare Worker health route', () => {
  it('returns ok JSON for GET /v1/health', async () => {
    const response = await worker.fetch(new Request('https://cc.example.test/v1/health'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
  });
});
