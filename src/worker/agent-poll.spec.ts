import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { AgentConnectionDurableObject } from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';
import { D1DeviceStore } from './db/d1-device-store';
import { D1LogStore } from './db/d1-log-store';
import { D1CommandStore } from './db/d1-command-store';
import { D1PtySessionStore } from './db/d1-pty-store';

class TestD1PreparedStatement {
  private params: unknown[] = [];
  constructor(private readonly statement: Database.Statement) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  async run() { const result = this.statement.run(...this.params); return { success: true, changes: result.changes }; }
  async first<T = unknown>() { return (this.statement.get(...this.params) ?? null) as T | null; }
  async all<T = unknown>() { return { results: this.statement.all(...this.params) as T[] }; }
}

class TestD1Database {
  readonly sqlite = new Database(':memory:');
  constructor() { this.sqlite.exec(D1_SCHEMA_SQL); }
  prepare(sql: string) { return new TestD1PreparedStatement(this.sqlite.prepare(sql)); }
  close() { this.sqlite.close(); }
}

class FakeDurableObjectNamespace {
  readonly requests: Array<{ name: string; request: Request }> = [];
  idFromName(name: string) { return { name }; }
  get(id: { name: string }) {
    return {
      fetch: async (request: Request) => {
        this.requests.push({ name: id.name, request });
        return new Response(JSON.stringify({ durableObject: id.name, path: new URL(request.url).pathname }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    };
  }
}

type TestEnv = { CC_DB: TestD1Database; CC_ADMIN_API_TOKEN?: string; CC_AGENT_DO?: FakeDurableObjectNamespace; uuid?: () => string; now?: () => number };

describe('Worker agent polling (D1 mode)', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => {
    while (databases.length) databases.pop()?.close();
    vi.unstubAllGlobals();
  });

  async function createEnv() {
    const db = new TestD1Database();
    databases.push(db);
    await new D1DeviceStore(db).addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'disconnected', agentToken: 'agent-token-1' });
    return { CC_DB: db } satisfies TestEnv;
  }

  async function agentPoll(env: TestEnv, body: Record<string, unknown> = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (body.agentToken) headers.authorization = `Bearer ${body.agentToken}`;
    delete body.agentToken;
    return worker.fetch(new Request('https://cc.example.test/agent', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }), env as any);
  }

  async function seedFreshServerSshStatus(env: TestEnv, serverId = 'srv-1', localSessionId = 'local-ssh-session-1') {
    await new D1LogStore(env.CC_DB).append({
      id: `fresh-ssh-${serverId}`,
      deviceId: 'dev-1',
      type: 'function-status',
      functionId: `server-ssh-${serverId}`,
      sessionId: localSessionId,
      seq: 1,
      ts: new Date().toISOString(),
      payload: { functionId: `server-ssh-${serverId}`, state: 'running', sessionId: localSessionId },
    });
  }

  it('answers agent protocol probes without opening a Durable Object WebSocket', async () => {
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const response = await worker.fetch(new Request('https://cc.example.test/agent/protocol', {
      method: 'GET',
      headers: { authorization: 'Bearer agent-token-1' },
    }), env as any);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      protocol: 'scp.cc.v1',
      transports: ['websocket', 'sse', 'long-poll'],
    });
    expect(env.CC_AGENT_DO.requests).toHaveLength(0);
  });


  it('routes agent WebSocket upgrades through the per-device Durable Object', async () => {
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const response = await worker.fetch(new Request('https://cc.example.test/agent', {
      method: 'GET',
      headers: {
        authorization: 'Bearer agent-token-1',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'test-key',
        'sec-websocket-version': '13',
      },
    }), env as any);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ durableObject: 'dev-1', path: '/agent' });
    expect(env.CC_AGENT_DO.requests).toHaveLength(1);
  });

  it('notifies the device Durable Object immediately when admin dispatches a command', async () => {
    const env = await createEnv();
    env.CC_ADMIN_API_TOKEN = 'admin-token';
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-status-snapshot', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'cmd-do-1' }),
    }), env as any);

    expect(response.status).toBe(200);
    expect(env.CC_AGENT_DO.requests).toHaveLength(1);
    expect(env.CC_AGENT_DO.requests[0].name).toBe('dev-1');
    expect(new URL(env.CC_AGENT_DO.requests[0].request.url).pathname).toBe('/dispatch');
    await expect(env.CC_AGENT_DO.requests[0].request.json()).resolves.toMatchObject({
      commandId: 'cmd-do-1',
      commandType: 'request_status_snapshot',
    });
  });

  it('dispatches restart boundary auth commands through the Worker device action route', async () => {
    const env = await createEnv();
    env.CC_ADMIN_API_TOKEN = 'admin-token';
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-restart-boundary-auth', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'cmd-boundary-1' }),
    }), env as any);

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      ok: true,
      deviceId: 'dev-1',
      reqSeq: 1,
      command: {
        commandId: 'cmd-boundary-1',
        commandType: 'restart_boundary_auth',
        state: 'dispatched',
      },
    });
    expect(env.CC_AGENT_DO.requests).toHaveLength(1);
    await expect(env.CC_AGENT_DO.requests[0].request.json()).resolves.toMatchObject({
      type: 'request_restart_boundary_auth',
      commandId: 'cmd-boundary-1',
      commandType: 'restart_boundary_auth',
    });
  });

  it('dispatches start server tunnel commands with serverId payload', async () => {
    const env = await createEnv();
    env.CC_ADMIN_API_TOKEN = 'admin-token';
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-start-server-tunnel', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'cmd-start-tunnel-1', serverId: 'srv-1' }),
    }), env as any);

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      ok: true,
      deviceId: 'dev-1',
      reqSeq: 1,
      command: {
        commandId: 'cmd-start-tunnel-1',
        commandType: 'start_server_tunnel',
        state: 'dispatched',
        payload: { serverId: 'srv-1' },
      },
    });
    expect(env.CC_AGENT_DO.requests).toHaveLength(1);
    await expect(env.CC_AGENT_DO.requests[0].request.json()).resolves.toMatchObject({
      type: 'request_start_server_tunnel',
      commandId: 'cmd-start-tunnel-1',
      commandType: 'start_server_tunnel',
      payload: { serverId: 'srv-1' },
    });
  });

  it('dispatches start server SSH commands with a durable PTY session', async () => {
    const env = await createEnv();
    env.CC_ADMIN_API_TOKEN = 'admin-token';
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-start-server-ssh', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv-1', cols: 100, rows: 30 }),
    }), env as any);

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      ok: true,
      deviceId: 'dev-1',
      serverId: 'srv-1',
      reqSeq: 1,
      agentAck: null,
    });
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId).toMatch(/^server-ssh-srv-1-[0-9a-f-]+$/);
    await expect(new D1PtySessionStore(env.CC_DB).get(body.sessionId)).resolves.toMatchObject({
      deviceId: 'dev-1',
      sessionId: body.sessionId,
      state: 'opening',
      cols: 100,
      rows: 30,
    });
    await expect(new D1CommandStore(env.CC_DB).getCommand(body.sessionId)).resolves.toMatchObject({
      commandId: body.sessionId,
      commandType: 'start_server_ssh',
      state: 'dispatched',
      payload: { serverId: 'srv-1', sessionId: body.sessionId, cols: 100, rows: 30 },
    });
    expect(env.CC_AGENT_DO.requests).toHaveLength(1);
    await expect(env.CC_AGENT_DO.requests[0].request.json()).resolves.toMatchObject({
      type: 'request_start_server_ssh',
      commandId: body.sessionId,
      commandType: 'start_server_ssh',
      payload: { serverId: 'srv-1', sessionId: body.sessionId, cols: 100, rows: 30 },
    });
  });

  it('dispatches attach server SSH commands with an existing local session id', async () => {
    const env = await createEnv();
    env.CC_ADMIN_API_TOKEN = 'admin-token';
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();
    await seedFreshServerSshStatus(env);

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-attach-server-ssh', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv-1', localSessionId: 'local-ssh-session-1', cols: 120, rows: 32 }),
    }), env as any);

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      ok: true,
      deviceId: 'dev-1',
      serverId: 'srv-1',
      reqSeq: 1,
      agentAck: null,
    });
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId).toMatch(/^server-ssh-srv-1-[0-9a-f-]+$/);
    await expect(new D1PtySessionStore(env.CC_DB).get(body.sessionId)).resolves.toMatchObject({
      deviceId: 'dev-1',
      sessionId: body.sessionId,
      state: 'opening',
      cols: 120,
      rows: 32,
    });
    await expect(new D1CommandStore(env.CC_DB).getCommand(body.sessionId)).resolves.toMatchObject({
      commandId: body.sessionId,
      commandType: 'request_attach_server_ssh',
      state: 'dispatched',
      payload: {
        serverId: 'srv-1',
        sessionId: body.sessionId,
        localSessionId: 'local-ssh-session-1',
        cols: 120,
        rows: 32,
      },
    });
    expect(env.CC_AGENT_DO.requests).toHaveLength(1);
    await expect(env.CC_AGENT_DO.requests[0].request.json()).resolves.toMatchObject({
      type: 'request_attach_server_ssh',
      commandId: body.sessionId,
      commandType: 'request_attach_server_ssh',
      payload: {
        serverId: 'srv-1',
        sessionId: body.sessionId,
        localSessionId: 'local-ssh-session-1',
        cols: 120,
        rows: 32,
      },
    });
  });

  it('reuses the active server SSH PTY when attaching the same server again', async () => {
    const env = await createEnv();
    env.CC_ADMIN_API_TOKEN = 'admin-token';
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();
    await seedFreshServerSshStatus(env);

    const firstResponse = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-attach-server-ssh', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv-1', localSessionId: 'local-ssh-session-1', cols: 120, rows: 32 }),
    }), env as any);
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json() as any;

    const secondResponse = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-attach-server-ssh', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv-1', localSessionId: 'local-ssh-session-1', cols: 100, rows: 30 }),
    }), env as any);

    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json() as any;
    expect(secondBody.sessionId).toBe(firstBody.sessionId);
    expect(secondBody.reused).toBe(true);
    expect(env.CC_AGENT_DO.requests).toHaveLength(1);
  });

  it('reuses the active server SSH PTY when starting the same server again', async () => {
    const env = await createEnv();
    env.CC_ADMIN_API_TOKEN = 'admin-token';
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const firstResponse = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-start-server-ssh', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv-1', cols: 120, rows: 32 }),
    }), env as any);
    expect(firstResponse.status).toBe(200);
    const firstBody = await firstResponse.json() as any;

    const secondResponse = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-start-server-ssh', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv-1', cols: 100, rows: 30 }),
    }), env as any);

    expect(secondResponse.status).toBe(200);
    const secondBody = await secondResponse.json() as any;
    expect(secondBody.sessionId).toBe(firstBody.sessionId);
    expect(secondBody.reused).toBe(true);
    expect(env.CC_AGENT_DO.requests).toHaveLength(1);
  });

  it('marks restart boundary auth command succeeded from Durable Object command_status', async () => {
    const env = await createEnv();
    env.CC_ADMIN_API_TOKEN = 'admin-token';
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-restart-boundary-auth', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'cmd-boundary-status-1' }),
    }), env as any);

    const durableObject = new AgentConnectionDurableObject({} as any, env as any);
    await durableObject.webSocketMessage({
      deserializeAttachment: () => ({ deviceId: 'dev-1' }),
      send: vi.fn(),
    } as any, JSON.stringify({
      type: 'command_status',
      deviceId: 'dev-1',
      commandId: 'cmd-boundary-status-1',
      ts: '2026-04-29T00:00:05.000Z',
      payload: {
        state: 'succeeded',
        outcome: 'restart_boundary_auth',
      },
    }));

    await expect(new D1CommandStore(env.CC_DB).getCommand('cmd-boundary-status-1')).resolves.toMatchObject({
      state: 'succeeded',
      outcome: 'restart_boundary_auth',
      finishedAt: '2026-04-29T00:00:05.000Z',
    });
  });

  it('marks PTY sessions closed when the agent reports pty-exit', async () => {
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({
      id: 'row-pty-exit',
      sessionId: 'server-ssh-srv-1-11111111-1111-4111-8111-111111111111',
      deviceId: 'dev-1',
      cols: 120,
      rows: 32,
      openedAt: '2026-05-05T04:47:29.071Z',
    });
    await sessions.markOpen('server-ssh-srv-1-11111111-1111-4111-8111-111111111111', '2026-05-05T04:47:30.000Z');

    const durableObject = new AgentConnectionDurableObject({} as any, env as any);
    await durableObject.webSocketMessage({
      deserializeAttachment: () => ({ deviceId: 'dev-1' }),
      send: vi.fn(),
    } as any, JSON.stringify({
      type: 'pty-exit',
      deviceId: 'dev-1',
      seq: 7,
      ts: '2026-05-05T05:36:34.572Z',
      payload: {
        sessionId: 'server-ssh-srv-1-11111111-1111-4111-8111-111111111111',
        exitCode: 0,
        reason: 'process exited',
      },
    }));

    await expect(sessions.get('server-ssh-srv-1-11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({
      state: 'closed',
      closedAt: '2026-05-05T05:36:34.572Z',
      failureDetail: 'process exited',
    });
  });

  it('marks PTY sessions failed when the agent rejects a PTY command as not found', async () => {
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({
      id: 'row-stale-pty',
      sessionId: 'stale-session-1',
      deviceId: 'dev-1',
      cols: 120,
      rows: 32,
      openedAt: '2026-05-05T04:47:29.071Z',
    });
    const commands = new D1CommandStore(env.CC_DB);
    await commands.createQueuedCommand({
      id: 'cmd-row-stale-pty',
      commandId: 'cmd-write-stale-pty',
      deviceId: 'dev-1',
      commandType: 'write_pty',
      actorType: 'admin_session',
      payload: { sessionId: 'stale-session-1', data: 'uptime\r' },
      submittedAt: '2026-05-05T05:36:34.000Z',
    });
    await commands.markDispatched('cmd-write-stale-pty', 9, '2026-05-05T05:36:34.000Z');

    const durableObject = new AgentConnectionDurableObject({} as any, env as any);
    await durableObject.webSocketMessage({
      deserializeAttachment: () => ({ deviceId: 'dev-1' }),
      send: vi.fn(),
    } as any, JSON.stringify({
      type: 'nack',
      deviceId: 'dev-1',
      reqSeq: 9,
      ts: '2026-05-05T05:36:35.000Z',
      payload: { error: 'PTY_NOT_FOUND', detail: 'PTY session not found' },
    }));

    await expect(sessions.get('stale-session-1')).resolves.toMatchObject({
      state: 'failed',
      closedAt: '2026-05-05T05:36:35.000Z',
      failureCode: 'PTY_NOT_FOUND',
      failureDetail: 'PTY session not found',
    });
  });

  it('handles agent heartbeat via polling', async () => {
    const env = await createEnv();

    const response = await agentPoll(env, { heartbeat: true, agentToken: 'agent-token-1' });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      heartbeatAck: true,
      lastPollAt: expect.any(String),
      commands: [],
    });
    await expect(new D1DeviceStore(env.CC_DB).getDevice('dev-1')).resolves.toMatchObject({ status: 'connected' });
  });

  it('handles agent polling for pending commands', async () => {
    const env = await createEnv();
    env.CC_ADMIN_API_TOKEN = 'admin-token';
    
    // Create a command
    await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-status-snapshot', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'cmd-1' }),
    }), env as any);

    // Poll for commands
    const response = await agentPoll(env, { heartbeat: true, agentToken: 'agent-token-1' });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]).toMatchObject({
      commandId: 'cmd-1',
      commandType: 'request_status_snapshot',
    });
    // After polling, command state should be 'executing'
    await expect(new D1CommandStore(env.CC_DB).getCommand('cmd-1')).resolves.toMatchObject({
      state: 'executing',
    });
  });

  it('handles agent ack via polling', async () => {
    const env = await createEnv();
    env.CC_ADMIN_API_TOKEN = 'admin-token';
    
    // Create a command
    await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-status-snapshot', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'cmd-ack' }),
    }), env as any);

    // Poll and get the command
    let response = await agentPoll(env, { heartbeat: true, agentToken: 'agent-token-1' });
    let body = await response.json() as any;
    let cmd = body.commands[0];

    // Send ack for the command
    response = await agentPoll(env, { 
      heartbeat: true, 
      agentToken: 'agent-token-1', 
      ack: { commandId: cmd.commandId, reqSeq: 1 } 
    });

    expect(response.status).toBe(200);
    await expect(new D1CommandStore(env.CC_DB).getCommand('cmd-ack')).resolves.toMatchObject({
      state: 'executing', // Ack marks as executing
    });
  });

  it('rejects polling without a bearer token', async () => {
    const env = await createEnv();

    const response = await agentPoll(env, {});

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'AGENT_AUTH_REQUIRED' });
  });

  it('rejects polling with an unknown bearer token', async () => {
    const env = await createEnv();

    const response = await agentPoll(env, { agentToken: 'wrong-token', heartbeat: true });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'AGENT_AUTH_FAILED' });
  });

  it('updates device status on heartbeat', async () => {
    const env = await createEnv();
    
    const deviceBefore = await new D1DeviceStore(env.CC_DB).getDevice('dev-1');
    expect(deviceBefore?.status).toBe('disconnected');

    await agentPoll(env, { heartbeat: true, agentToken: 'agent-token-1' });

    const deviceAfter = await new D1DeviceStore(env.CC_DB).getDevice('dev-1');
    expect(deviceAfter?.status).toBe('connected');
    expect(new Date(deviceAfter!.lastSeenAt).getTime()).toBeGreaterThan(new Date(deviceBefore!.lastSeenAt).getTime());
  });
});


describe('Worker WebSocket upgrade response construction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a Response instance instead of a plain object for WebSocket upgrades', async () => {
    const OriginalResponse = globalThis.Response;
    class TestUpgradeResponse {
      readonly status: number;
      readonly webSocket: unknown;
      constructor(_body: unknown, init: { status?: number; webSocket?: unknown } = {}) {
        this.status = init.status ?? 200;
        this.webSocket = init.webSocket;
      }
    }
    vi.stubGlobal('Response', TestUpgradeResponse as any);

    const db = new TestD1Database();
    await new D1DeviceStore(db).addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'disconnected', agentToken: 'agent-token-1' });
    const serverSocket = { send: vi.fn(), serializeAttachment: vi.fn() };
    const clientSocket = { client: true };
    const state = { acceptWebSocket: vi.fn() };
    const WebSocketPair = vi.fn(function(this: unknown) { return [clientSocket, serverSocket]; });
    vi.stubGlobal('WebSocketPair', WebSocketPair as any);

    try {
      const durableObject = new AgentConnectionDurableObject(state as any, { CC_DB: db } as any);
      const response = await durableObject.fetch(new Request('https://cc.example.test/agent', {
        method: 'GET',
        headers: { authorization: 'Bearer agent-token-1', upgrade: 'websocket' },
      }));

      expect(response).toBeInstanceOf(TestUpgradeResponse as any);
      expect(response.status).toBe(101);
      expect((response as any).webSocket).toBe(clientSocket);
    } finally {
      db.close();
      vi.stubGlobal('Response', OriginalResponse);
    }
  });

  it('treats dispatch send failures as stale sockets instead of throwing', async () => {
    const serverSocket = {
      send: vi.fn(() => {
        throw new Error('Network connection lost.');
      }),
      close: vi.fn(),
    };
    const state = { getWebSockets: vi.fn(() => [serverSocket]) };
    const durableObject = new AgentConnectionDurableObject(state as any, {} as any);

    const response = await durableObject.fetch(new Request('https://cc.example.test/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'request_status_snapshot', commandId: 'cmd-1' }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivered: 0, sockets: 1 });
    expect(serverSocket.close).toHaveBeenCalledWith(1011, 'network_connection_lost');
  });

  it('marks the attached device disconnected when a hibernated websocket errors', async () => {
    const db = new TestD1Database();
    await new D1DeviceStore(db).addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1' });
    const durableObject = new AgentConnectionDurableObject({} as any, {
      CC_DB: db,
      now: () => Date.parse('2026-04-29T00:00:05.000Z'),
    } as any);
    const socket = {
      deserializeAttachment: vi.fn(() => ({ deviceId: 'dev-1' })),
    };

    try {
      await durableObject.webSocketError(socket as any, new Error('Network connection lost.'));

      await expect(new D1DeviceStore(db).getDevice('dev-1')).resolves.toMatchObject({
        status: 'disconnected',
        lastSeenAt: '2026-04-29T00:00:05.000Z',
      });
    } finally {
      db.close();
    }
  });
});
