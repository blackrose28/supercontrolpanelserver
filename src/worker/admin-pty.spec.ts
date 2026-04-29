import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { AgentConnectionDurableObject } from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';
import { D1CommandStore } from './db/d1-command-store';
import { D1DeviceStore } from './db/d1-device-store';
import { D1PtyAuditStore, D1PtySessionStore } from './db/d1-pty-store';

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
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      },
    };
  }
}

type TestEnv = { CC_DB: TestD1Database; CC_ADMIN_API_TOKEN?: string; CC_AGENT_DO?: FakeDurableObjectNamespace; uuid?: () => string; now?: () => number };

describe('Worker admin PTY WebSocket auth', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => {
    while (databases.length) databases.pop()?.close();
    vi.unstubAllGlobals();
  });

  async function createEnv(): Promise<TestEnv> {
    const db = new TestD1Database();
    databases.push(db);
    await new D1DeviceStore(db).addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1' });
    let nextUuid = 0;
    return { CC_DB: db, CC_ADMIN_API_TOKEN: 'admin-token', uuid: () => `uuid-${++nextUuid}`, now: () => Date.parse('2026-04-29T00:00:00.000Z') };
  }

  function wsRequest(headers: Record<string, string> = {}) {
    return new Request('https://cc.example.test/admin/ws/pty', {
      headers: { connection: 'Upgrade', upgrade: 'websocket', ...headers },
    });
  }

  it('rejects unauthenticated admin PTY WebSocket upgrades', async () => {
    const env = await createEnv();

    const response = await worker.fetch(wsRequest(), env as any);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'ADMIN_API_AUTH_FAILED' });
  });

  it('requires a WebSocket upgrade for authenticated admin PTY endpoint', async () => {
    const env = await createEnv();

    const response = await worker.fetch(new Request('https://cc.example.test/admin/ws/pty', {
      headers: { authorization: 'Bearer admin-token' },
    }), env as any);

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({ error: 'WEBSOCKET_UPGRADE_REQUIRED' });
  });

  it('accepts authenticated admin PTY WebSocket upgrades with a real Response', async () => {
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
    const clientSocket = { client: true };
    const serverSocket = { accept: vi.fn(), send: vi.fn(), addEventListener: vi.fn() };
    vi.stubGlobal('WebSocketPair', vi.fn(function(this: unknown) { return [clientSocket, serverSocket]; }) as any);
    const env = await createEnv();

    try {
      const response = await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);

      expect(response).toBeInstanceOf(TestUpgradeResponse as any);
      expect(response.status).toBe(101);
      expect((response as any).webSocket).toBe(clientSocket);
      expect(serverSocket.accept).toHaveBeenCalled();
      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('pty_state'));
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });

  it('creates an opening PTY session and dispatches open_pty when admin sends pty_open', async () => {
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
    const listeners = new Map<string, (event: { data?: unknown }) => unknown>();
    const clientSocket = { client: true };
    const serverSocket = {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: (event: { data?: unknown }) => unknown) => listeners.set(type, listener)),
    };
    vi.stubGlobal('WebSocketPair', vi.fn(function(this: unknown) { return [clientSocket, serverSocket]; }) as any);
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_open', deviceId: 'dev-1', sessionId: 'pty-1', cols: 100, rows: 40 }) });

      await expect(new D1PtySessionStore(env.CC_DB).get('pty-1')).resolves.toMatchObject({
        sessionId: 'pty-1',
        deviceId: 'dev-1',
        state: 'opening',
        cols: 100,
        rows: 40,
      });
      await expect(new D1CommandStore(env.CC_DB).getCommand('pty-1')).resolves.toMatchObject({
        commandId: 'pty-1',
        commandType: 'open_pty',
        state: 'dispatched',
        payload: { sessionId: 'pty-1', cols: 100, rows: 40 },
      });
      await expect(new D1PtyAuditStore(env.CC_DB).listBySession('pty-1')).resolves.toEqual([
        expect.objectContaining({ eventType: 'pty_open_requested', summary: 'Admin requested PTY open' }),
      ]);
      expect(env.CC_AGENT_DO.requests).toHaveLength(1);
      expect(env.CC_AGENT_DO.requests[0].name).toBe('dev-1');
      await expect(env.CC_AGENT_DO.requests[0].request.json()).resolves.toMatchObject({
        commandId: 'pty-1',
        type: 'open_pty',
        payload: { sessionId: 'pty-1', cols: 100, rows: 40 },
      });
      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('pty_opening'));
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });


  it('attaches and detaches an existing PTY session with audit records', async () => {
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
    const listeners = new Map<string, (event: { data?: unknown }) => unknown>();
    const clientSocket = { client: true };
    const serverSocket = {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: (event: { data?: unknown }) => unknown) => listeners.set(type, listener)),
    };
    vi.stubGlobal('WebSocketPair', vi.fn(function(this: unknown) { return [clientSocket, serverSocket]; }) as any);
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({ id: 'row-pty-2', sessionId: 'pty-2', deviceId: 'dev-1', cols: 80, rows: 24, openedAt: '2026-04-29T00:00:00.000Z' });
    await sessions.markOpen('pty-2', '2026-04-29T00:00:01.000Z');

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_attach', sessionId: 'pty-2' }) });

      await expect(sessions.get('pty-2')).resolves.toMatchObject({
        attachedActorType: 'admin_env_token',
        attachedActorId: 'CC_ADMIN_API_TOKEN',
        lastDetachedAt: null,
      });
      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('pty_attached'));

      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_detach', sessionId: 'pty-2' }) });

      await expect(sessions.get('pty-2')).resolves.toMatchObject({
        attachedActorType: null,
        attachedActorId: null,
        lastDetachedAt: '2026-04-29T00:00:00.000Z',
      });
      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('pty_detached'));
      await expect(new D1PtyAuditStore(env.CC_DB).listBySession('pty-2')).resolves.toEqual([
        expect.objectContaining({ eventType: 'pty_attached', summary: 'Admin attached PTY session' }),
        expect.objectContaining({ eventType: 'pty_detached', summary: 'Admin detached PTY session' }),
      ]);
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });


  it('dispatches write and resize requests for an attached PTY session', async () => {
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
    const listeners = new Map<string, (event: { data?: unknown }) => unknown>();
    const clientSocket = { client: true };
    const serverSocket = {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: (event: { data?: unknown }) => unknown) => listeners.set(type, listener)),
    };
    vi.stubGlobal('WebSocketPair', vi.fn(function(this: unknown) { return [clientSocket, serverSocket]; }) as any);
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({ id: 'row-pty-3', sessionId: 'pty-3', deviceId: 'dev-1', cols: 80, rows: 24, openedAt: '2026-04-29T00:00:00.000Z', attachedActorType: 'admin_env_token', attachedActorId: 'CC_ADMIN_API_TOKEN' });
    await sessions.markOpen('pty-3', '2026-04-29T00:00:01.000Z');

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_write', sessionId: 'pty-3', data: 'ls\n' }) });
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_resize', sessionId: 'pty-3', cols: 120, rows: 50 }) });

      expect(env.CC_AGENT_DO.requests).toHaveLength(2);
      await expect(env.CC_AGENT_DO.requests[0].request.json()).resolves.toMatchObject({
        type: 'write_pty',
        payload: { sessionId: 'pty-3', data: 'ls\n' },
      });
      await expect(env.CC_AGENT_DO.requests[1].request.json()).resolves.toMatchObject({
        type: 'resize_pty',
        payload: { sessionId: 'pty-3', cols: 120, rows: 50 },
      });
      await expect(sessions.get('pty-3')).resolves.toMatchObject({ cols: 120, rows: 50 });
      await expect(new D1PtyAuditStore(env.CC_DB).listBySession('pty-3')).resolves.toEqual([
        expect.objectContaining({ eventType: 'pty_write', summary: 'Admin wrote to PTY session' }),
        expect.objectContaining({ eventType: 'pty_resize', summary: 'Admin resized PTY session' }),
      ]);
      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('pty_write_accepted'));
      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('pty_resize_accepted'));
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });

  it('rejects write requests for unattached PTY sessions', async () => {
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
    const listeners = new Map<string, (event: { data?: unknown }) => unknown>();
    const clientSocket = { client: true };
    const serverSocket = {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: (event: { data?: unknown }) => unknown) => listeners.set(type, listener)),
    };
    vi.stubGlobal('WebSocketPair', vi.fn(function(this: unknown) { return [clientSocket, serverSocket]; }) as any);
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({ id: 'row-pty-4', sessionId: 'pty-4', deviceId: 'dev-1', cols: 80, rows: 24, openedAt: '2026-04-29T00:00:00.000Z' });
    await sessions.markOpen('pty-4', '2026-04-29T00:00:01.000Z');

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_write', sessionId: 'pty-4', data: 'nope' }) });

      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('PTY_NOT_ATTACHED'));
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });


  it('rate-limits excessive PTY write requests', async () => {
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
    const listeners = new Map<string, (event: { data?: unknown }) => unknown>();
    const clientSocket = { client: true };
    const serverSocket = {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: (event: { data?: unknown }) => unknown) => listeners.set(type, listener)),
    };
    vi.stubGlobal('WebSocketPair', vi.fn(function(this: unknown) { return [clientSocket, serverSocket]; }) as any);
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({ id: 'row-pty-5', sessionId: 'pty-5', deviceId: 'dev-1', openedAt: '2026-04-29T00:00:00.000Z', attachedActorType: 'admin_env_token', attachedActorId: 'CC_ADMIN_API_TOKEN' });
    await sessions.markOpen('pty-5', '2026-04-29T00:00:01.000Z');

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      for (let i = 0; i < 21; i += 1) {
        await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_write', sessionId: 'pty-5', data: String(i) }) });
      }

      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('PTY_WRITE_RATE_LIMITED'));
      expect(env.CC_AGENT_DO.requests).toHaveLength(20);
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });

  it('closes active PTY sessions and soft-deletes terminal PTY sessions with audit records', async () => {
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
    const listeners = new Map<string, (event: { data?: unknown }) => unknown>();
    const clientSocket = { client: true };
    const serverSocket = {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: (event: { data?: unknown }) => unknown) => listeners.set(type, listener)),
    };
    vi.stubGlobal('WebSocketPair', vi.fn(function(this: unknown) { return [clientSocket, serverSocket]; }) as any);
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({ id: 'row-pty-6', sessionId: 'pty-6', deviceId: 'dev-1', openedAt: '2026-04-29T00:00:00.000Z', attachedActorType: 'admin_env_token', attachedActorId: 'CC_ADMIN_API_TOKEN' });
    await sessions.markOpen('pty-6', '2026-04-29T00:00:01.000Z');
    await sessions.createOpening({ id: 'row-pty-7', sessionId: 'pty-7', deviceId: 'dev-1', openedAt: '2026-04-29T00:00:00.000Z' });
    await sessions.markClosed('pty-7', '2026-04-29T00:00:01.000Z', 'done');

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_close', sessionId: 'pty-6' }) });
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_delete', sessionId: 'pty-7' }) });

      await expect(sessions.get('pty-6')).resolves.toMatchObject({
        state: 'closing',
        closeRequestedAt: '2026-04-29T00:00:00.000Z',
      });
      await expect(new D1CommandStore(env.CC_DB).getCommand('uuid-2')).resolves.toMatchObject({
        commandType: 'close_pty',
        state: 'dispatched',
        payload: { sessionId: 'pty-6' },
      });
      expect(env.CC_AGENT_DO.requests).toHaveLength(1);
      await expect(env.CC_AGENT_DO.requests[0].request.json()).resolves.toMatchObject({
        type: 'close_pty',
        payload: { sessionId: 'pty-6' },
      });
      await expect(sessions.get('pty-7')).resolves.toMatchObject({
        state: 'closed',
        deletedAt: '2026-04-29T00:00:00.000Z',
      });
      await expect(new D1PtyAuditStore(env.CC_DB).listBySession('pty-6')).resolves.toEqual([
        expect.objectContaining({ eventType: 'pty_close_requested', summary: 'Admin requested PTY close' }),
      ]);
      await expect(new D1PtyAuditStore(env.CC_DB).listBySession('pty-7')).resolves.toEqual([
        expect.objectContaining({ eventType: 'pty_deleted', summary: 'Admin deleted PTY session record' }),
      ]);
      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('pty_close_requested'));
      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('pty_deleted'));
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });

  it('fans out agent pty-output messages to attached admin PTY clients', async () => {
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
    const listeners = new Map<string, (event: { data?: unknown }) => unknown>();
    const clientSocket = { client: true };
    const serverSocket = {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: (event: { data?: unknown }) => unknown) => listeners.set(type, listener)),
    };
    vi.stubGlobal('WebSocketPair', vi.fn(function(this: unknown) { return [clientSocket, serverSocket]; }) as any);
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({ id: 'row-pty-8', sessionId: 'pty-8', deviceId: 'dev-1', openedAt: '2026-04-29T00:00:00.000Z' });
    await sessions.markOpen('pty-8', '2026-04-29T00:00:01.000Z');

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_attach', sessionId: 'pty-8' }) });

      const agentSocket = { deserializeAttachment: () => ({ deviceId: 'dev-1' }) };
      const durableObject = new AgentConnectionDurableObject({} as any, env as any);
      await durableObject.webSocketMessage(agentSocket as any, JSON.stringify({
        type: 'pty-output',
        sessionId: 'pty-8',
        data: 'hello from agent',
      }));

      expect(serverSocket.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'pty_output',
        payload: { sessionId: 'pty-8', deviceId: 'dev-1', data: 'hello from agent' },
      }));
      await expect(sessions.get('pty-8')).resolves.toMatchObject({
        lastOutputAt: '2026-04-29T00:00:00.000Z',
      });
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });

});
