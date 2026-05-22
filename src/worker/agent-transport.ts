import type { WorkerEnv } from './types';
import { D1DeviceStore } from './db/d1-device-store';
import { D1CommandStore } from './db/d1-command-store';
import { nowMs } from './env-helpers';
import { jsonResponse, applySecurityHeaders, parseJsonBody } from './http';
import { authenticateAgentRequest, getBearerToken, requireAdminAuth } from './auth';

export function publicCommand(cmd: { commandId: string; commandType: string; state: string; payloadJson?: string | null; payload?: unknown; submittedAt: string; deviceId: string; actorType: string; reqSeq?: number | null }) {
  return {
    commandId: cmd.commandId,
    commandType: cmd.commandType,
    state: cmd.state,
    payload: cmd.payload !== undefined ? cmd.payload : (cmd.payloadJson ? JSON.parse(cmd.payloadJson) : null),
    reqSeq: cmd.reqSeq ?? null,
    submittedAt: cmd.submittedAt,
    deviceId: cmd.deviceId,
    actorType: cmd.actorType,
  };
}

// D1/Cloudflare Workers mode: agents prefer Durable Object WebSockets with
// hibernation. POST/GET polling remains as a compatibility fallback.

// Legacy command waiters - retained for compatibility with older polling code paths.
type CommandWaiter = {
  controller: ReadableStreamDefaultController;
  deviceId: string;
  resolve: (commands: any[]) => void;
  timeout: NodeJS.Timeout;
};
const commandWaiters = new Map<string, CommandWaiter>();


export function agentDurableObjectStub(env: WorkerEnv, deviceId: string): { fetch: (request: Request) => Promise<Response> } | null {
  if (!env.CC_AGENT_DO) return null;
  return env.CC_AGENT_DO.get(env.CC_AGENT_DO.idFromName(deviceId));
}

export function agentEnvelopeTypeForCommand(commandType: string): string {
  switch (commandType) {
    case 'request_pty_scrollback':
      return 'request_pty_scrollback';
    case 'restart_openvpn':
      return 'request_restart_openvpn';
    case 'restart_boundary_auth':
      return 'request_restart_boundary_auth';
    case 'restart_server_tunnel':
      return 'request_restart_server_tunnel';
    case 'restart_server_ssh':
      return 'request_restart_server_ssh';
    case 'start_server_ssh':
      return 'request_start_server_ssh';
    case 'start_server_tunnel':
      return 'request_start_server_tunnel';
    case 'stop_server_tunnel':
      return 'request_stop_server_tunnel';
    default:
      return commandType;
  }
}

export function makeCommandEnvelope(deviceId: string, command: ReturnType<typeof publicCommand>, now: string) {
  const seq = typeof command.reqSeq === 'number' && Number.isFinite(command.reqSeq) && command.reqSeq > 0
    ? command.reqSeq
    : 1;
  return {
    type: agentEnvelopeTypeForCommand(command.commandType),
    commandType: command.commandType,
    deviceId,
    seq,
    ts: now,
    commandId: command.commandId,
    payload: command.payload,
  };
}

export function safeWebSocketSend(socket: WebSocket, message: string): boolean {
  try {
    socket.send(message);
    return true;
  } catch (err) {
    const reason = String(err).includes('Network connection lost')
      ? 'network_connection_lost'
      : 'send_failed';
    if (reason === 'send_failed') {
      console.warn('WebSocket send failed:', err);
    }
    try {
      socket.close(1011, reason);
    } catch {
      // Ignore close failures for already-lost sockets.
    }
    return false;
  }
}

export function websocketSend(socket: { send?: (message: string) => void }, type: string, payload: unknown): void {
  if (!socket || typeof socket.send !== 'function') {
    console.warn(`[PTY-TRACE] websocketSend: skipped — socket has no send fn type=${type}`);
    return;
  }
  try {
    socket.send(JSON.stringify({ type, payload }));
  } catch (err) {
    console.warn(`[PTY-TRACE] websocketSend: throw type=${type} err=${String(err)}`);
  }
}

export async function notifyAgentDurableObject(env: WorkerEnv, deviceId: string, command: ReturnType<typeof publicCommand>, now: string): Promise<void> {
  const stub = agentDurableObjectStub(env, deviceId);
  if (!stub) return;
  try {
    await stub.fetch(new Request('https://cc.internal/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeCommandEnvelope(deviceId, command, now)),
    }));
  } catch (err) {
    console.error('Durable Object dispatch notification failed; polling fallback remains available:', err);
  }
}

export async function handleAgentWebSocket(request: Request, env: WorkerEnv): Promise<Response> {
  // Check for agent heartbeat polling (POST)
  if (request.method === 'POST') {
    return handleAgentPolling(request, env);
  }

  // Agent WebSocket upgrade. In Workers, route live agent sockets to a per-device
  // Durable Object so hibernated sockets can be woken instantly for command dispatch.
  if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
    const auth = await authenticateAgentRequest(request, env);
    if (auth instanceof Response) return auth;
    const stub = agentDurableObjectStub(env, auth.device.id);
    if (stub) return stub.fetch(request);
    return handleAdminPtyWebSocket(request, env);
  }

  // SSE endpoint for agent command delivery
  if (request.headers.get('accept')?.includes('text/event-stream')) {
    return handleAgentSSE(request, env);
  }

  return jsonResponse({ error: 'WEBSOCKET_UPGRADE_REQUIRED' }, { status: 426 });
}

export async function handleAgentProtocolProbe(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
  const auth = await authenticateAgentRequest(request, env);
  if (auth instanceof Response) return auth;
  return jsonResponse({
    protocol: 'scp.cc.v1',
    transports: ['websocket', 'sse', 'long-poll'],
  });
}

export async function handleAgentPolling(request: Request, env: WorkerEnv): Promise<Response> {
  const token = getBearerToken(request);
  if (!token) {
    return jsonResponse({ error: 'AGENT_AUTH_REQUIRED' }, { status: 401 });
  }
  const db = (await import('./env-helpers')).requireD1(env);
  if (db instanceof Response) return db;
  const devices = new D1DeviceStore(db);
  const device = await devices.findDeviceByAgentToken(token);
  if (!device) {
    return jsonResponse({ error: 'AGENT_AUTH_FAILED' }, { status: 401 });
  }

  const body = await parseJsonBody(request);
  const now = new Date(nowMs(env)).toISOString();

  // Update device status on heartbeat
  await devices.updateDeviceStatus(device.id, 'connected', now);

  // Check for pending commands from other requests
  const commands = new D1CommandStore(db);
  const pendingCommands = await commands.listCommands({
    deviceId: device.id,
    state: 'dispatched',
    limit: 10,
  });

  // Mark commands as delivered to prevent duplicate delivery
  for (const cmd of pendingCommands) {
    await commands.markExecuting(cmd.commandId, now);
  }

  return jsonResponse({
    heartbeatAck: true,
    commands: pendingCommands.map(publicCommand),
    lastPollAt: now,
  });
}

export async function handleAgentLongPoll(request: Request, env: WorkerEnv): Promise<Response> {
  // Long-polling: GET request for commands
  // For D1-based Workers, we use a simple approach:
  // - If commands exist, return immediately
  // - If no commands, return empty (agent will retry with exponential backoff)
  // This replaces POST polling to avoid Worker restarts
  const token = getBearerToken(request);
  if (!token) {
    return jsonResponse({ error: 'AGENT_AUTH_REQUIRED' }, { status: 401 });
  }
  const db = (await import('./env-helpers')).requireD1(env);
  if (db instanceof Response) return db;
  const devices = new D1DeviceStore(db);
  const device = await devices.findDeviceByAgentToken(token);
  if (!device) {
    return jsonResponse({ error: 'AGENT_AUTH_FAILED' }, { status: 401 });
  }
  const commands = new D1CommandStore(db);

  // Get current timestamp for this poll
  const now = new Date(nowMs(env)).toISOString();

  // Update device status
  await devices.updateDeviceStatus(device.id, 'connected', now);

  // Check for pending commands
  let pendingCommands = await commands.listCommands({
    deviceId: device.id,
    state: 'dispatched',
    limit: 10,
  });

  // If commands exist, return immediately
  if (pendingCommands.length > 0) {
    for (const cmd of pendingCommands) {
      await commands.markExecuting(cmd.commandId, now);
    }
    return jsonResponse({
      heartbeatAck: true,
      commands: pendingCommands.map(publicCommand),
      lastPollAt: now,
    });
  }

  // No commands available, return empty response
  // Agent will retry with exponential backoff
  return jsonResponse({
    heartbeatAck: true,
    commands: [],
    lastPollAt: now,
  });
}

export async function handleAgentSSE(request: Request, env: WorkerEnv): Promise<Response> {
  // SSE (Server-Sent Events) for agent status updates
  // Agent uses long-polling for commands, SSE is for real-time status
  const token = getBearerToken(request);
  if (!token) {
    return jsonResponse({ error: 'AGENT_AUTH_REQUIRED' }, { status: 401 });
  }
  const db = (await import('./env-helpers')).requireD1(env);
  if (db instanceof Response) return db;
  const devices = new D1DeviceStore(db);
  const device = await devices.findDeviceByAgentToken(token);
  if (!device) {
    return jsonResponse({ error: 'AGENT_AUTH_FAILED' }, { status: 401 });
  }
  await devices.updateDeviceStatus(device.id, 'connected', new Date(nowMs(env)).toISOString());

  const encoder = new TextEncoder();
  let keepAlive: any;
  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection established event
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'connected', deviceId: device.id })}\n\n`));

      // Keep-alive ping every 15 seconds
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {
          if (keepAlive) clearInterval(keepAlive);
        }
      }, 15000);
    },
    cancel() {
      if (keepAlive) clearInterval(keepAlive);
    }
  });

  const headers = applySecurityHeaders(new Headers());
  headers.set('content-type', 'text/event-stream');
  headers.set('cache-control', 'no-cache');
  headers.set('connection', 'keep-alive');

  return new Response(stream, { headers }) as any;
}

export async function handleAdminPtyWebSocket(request: Request, env: WorkerEnv): Promise<Response> {
  // For admin PTY WebSocket - this works in wrangler dev but not for agents
  const token = getBearerToken(request);
  if (!token) {
    return jsonResponse({ error: 'AGENT_AUTH_REQUIRED' }, { status: 401 });
  }
  const db = (await import('./env-helpers')).requireD1(env);
  if (db instanceof Response) return db;
  const devices = new D1DeviceStore(db);
  const device = await devices.findDeviceByAgentToken(token);
  if (!device) {
    return jsonResponse({ error: 'AGENT_AUTH_FAILED' }, { status: 401 });
  }
  try {
    const WebSocketPairCtor = (globalThis as any).WebSocketPair;
    if (typeof WebSocketPairCtor !== 'function') {
      return jsonResponse({ error: 'WEBSOCKET_PAIR_UNAVAILABLE' }, { status: 501 });
    }
    const pair = new WebSocketPairCtor();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    await devices.updateDeviceStatus(device.id, 'connected', new Date(nowMs(env)).toISOString());
    server.send(JSON.stringify({
      type: 'welcome',
      payload: { deviceId: device.id, protocol: 'scp.cc.v1' },
    }));
    const wsHeaders = applySecurityHeaders(new Headers());
    return new Response(null, { status: 101, headers: wsHeaders, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  } catch (err) {
    console.error('handleAgentWebSocket error:', err);
    return jsonResponse({ error: 'WEBSOCKET_SETUP_FAILED', details: String(err) }, { status: 500 });
  }
}

export function sendAgentRequest(deviceId: string, message: Record<string, unknown>): { ok: true; seq: number; ts: string } | { ok: false; reason: string } {
  // In Cloudflare Workers D1 mode, we cannot use persistent WebSockets.
  // Commands are stored in D1 and agents poll for them.
  // This function is kept for potential future use with WebSocket-based transports.
  return { ok: false, reason: 'POLLED_REQUIRED' };
}
