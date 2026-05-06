import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import worker from './index';

describe('Worker SSE keep-alive leak', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handleAgentSSE should clear interval when stream is cancelled', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ id: 'dev-1', status: 'connected' }),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    };

    const env = {
      CC_DB: db,
      CC_BOOTSTRAP_TOKEN: 'bootstrap',
      now: () => 1000,
    };

    const request = new Request('https://cc.example.com/agent', {
      headers: {
        'authorization': 'Bearer agent-token-1',
        'accept': 'text/event-stream'
      }
    });

    // Mock authenticateAgentRequest to succeed
    db.prepare.mockImplementation((sql: string) => {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();
      if (normalizedSql.includes('FROM devices WHERE agentToken = ?')) {
        return {
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({ id: 'dev-1', name: 'Device 1', status: 'connected' }),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ success: true }),
        };
      }
      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
    });

    const response = await worker.fetch(request, env as any);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    // The interval should be set now (15000ms)
    // We can't directly check the interval ID, but we can see if it's cleared when we cancel
    
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    
    await reader?.cancel();
    
    // In current implementation, this should FAIL because there is no cancel() logic in handleAgentSSE
    // Or rather, the interval is never cleared.
    
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
