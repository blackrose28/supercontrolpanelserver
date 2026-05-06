import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';

describe('Cloudflare Worker health route', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok JSON for GET /v1/health', async () => {
    const response = await worker.fetch(new Request('https://cc.example.test/v1/health'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });
  });

  it('logs request context and returns an x-request-id for diagnostics', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const response = await worker.fetch(new Request('https://cc.example.test/v1/health', {
      headers: { 'x-request-id': 'req-test-1' },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req-test-1');
    expect(infoSpy).toHaveBeenCalledWith('Worker request started', expect.objectContaining({
      requestId: 'req-test-1',
      method: 'GET',
      path: '/v1/health',
    }));
    expect(infoSpy).toHaveBeenCalledWith('Worker request completed', expect.objectContaining({
      requestId: 'req-test-1',
      method: 'GET',
      path: '/v1/health',
      status: 200,
    }));
  });
});
