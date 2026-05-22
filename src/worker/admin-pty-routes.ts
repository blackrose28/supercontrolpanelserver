import type { WorkerEnv } from './types';
import { jsonResponse, applySecurityHeaders, parseJsonBody } from './http';
import { requireAdminAuth } from './auth';
import { safeWebSocketSend } from './agent-transport';

export async function relayPtyToAdminSubscribers(
  env: WorkerEnv,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Forward to the AdminPtyHubDurableObject. The hub owns the admin browser WebSockets
  // via state.acceptWebSocket(), so its own request handler can call .send() on them
  // legally — Cloudflare's per-request I/O isolation rule is satisfied because we're
  // crossing into the hub DO's request boundary via fetch.
  if (!env.CC_ADMIN_PTY_HUB) {
    console.warn('[PTY-TRACE] relay aborted: CC_ADMIN_PTY_HUB DO binding is missing');
    return;
  }
  try {
    const id = env.CC_ADMIN_PTY_HUB.idFromName('admin-pty-hub-singleton');
    const stub = env.CC_ADMIN_PTY_HUB.get(id);
    await stub.fetch(new Request('https://admin-pty-hub.internal/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, type, payload }),
    }));
  } catch (err) {
    console.warn(`[PTY-TRACE] relay to admin-pty-hub failed: ${String(err)}`);
  }
}


export async function handleAdminPtyUpgrade(request: Request, env: WorkerEnv): Promise<Response> {
  const auth = await requireAdminAuth(request, env, ['device:control']);
  if (auth instanceof Response) return auth;
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return jsonResponse({ error: 'WEBSOCKET_UPGRADE_REQUIRED' }, { status: 426 });
  }
  if (!env.CC_ADMIN_PTY_HUB) {
    return jsonResponse({ error: 'ADMIN_PTY_HUB_UNAVAILABLE' }, { status: 503 });
  }
  // Forward the upgrade into the hub DO. The DO accepts the WS via acceptWebSocket so
  // its own webSocketMessage handler can call .send() on it later when fanout arrives.
  const id = env.CC_ADMIN_PTY_HUB.idFromName('admin-pty-hub-singleton');
  const stub = env.CC_ADMIN_PTY_HUB.get(id);
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.set('x-admin-principal', JSON.stringify(auth.principal));
  return stub.fetch(new Request('https://admin-pty-hub.internal/upgrade', {
    method: request.method,
    headers: forwardHeaders,
  }));
}
