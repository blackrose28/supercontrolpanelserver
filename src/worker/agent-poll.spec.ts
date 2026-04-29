import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { AgentConnectionDurableObject } from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';
import { D1DeviceStore } from './db/d1-device-store';
import { D1LogStore } from './db/d1-log-store';
import { D1CommandStore } from './db/d1-command-store';

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
});
