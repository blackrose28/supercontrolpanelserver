import type { WorkerEnv } from './types';

export function nowMs(env: WorkerEnv): number {
  return typeof env.now === 'function' ? env.now() : Date.now();
}

export function makeUuid(env: WorkerEnv): string {
  return typeof env.uuid === 'function' ? env.uuid() : crypto.randomUUID();
}

export function requireD1(env: WorkerEnv): any | Response {
  if (!env.CC_DB || typeof (env.CC_DB as any).prepare !== 'function') {
    // Inline a minimal JSON error response to avoid circular dependency on http.ts.
    return new Response(JSON.stringify({ error: 'D1_NOT_CONFIGURED' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return env.CC_DB as any;
}
