import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { AgentConnectionDurableObject, AdminPtyHubDurableObject } from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';
import { D1CommandStore } from './db/d1-command-store';
import { D1DeviceStore } from './db/d1-device-store';
import { D1LogStore } from './db/d1-log-store';
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

class FakeAdminPtyHubState {
  readonly websockets: WebSocket[] = [];
  constructor(private readonly hubGetter: () => AdminPtyHubDurableObject) {}
  acceptWebSocket(socket: WebSocket, tags?: string[]) {
    this.websockets.push(socket);
    if (typeof (socket as any).accept === 'function') {
      (socket as any).accept();
    }
    let attachment: any = null;
    (socket as any).serializeAttachment = (att: any) => {
      attachment = att;
    };
    (socket as any).deserializeAttachment = () => {
      return attachment;
    };
    const hub = this.hubGetter();
    socket.addEventListener('message', async (event: any) => {
      const data = event?.data ?? event;
      return hub.webSocketMessage(socket, data);
    });
    socket.addEventListener('close', async (event: any) => {
      const code = event?.code ?? 1000;
      const reason = event?.reason ?? '';
      const wasClean = event?.wasClean ?? true;
      return hub.webSocketClose(socket, code, reason, wasClean);
    });
  }
  getWebSockets(tag?: string) {
    return this.websockets;
  }
}

class FakeAdminPtyHubNamespace {
  private hubInstance: AdminPtyHubDurableObject | null = null;
  readonly state: FakeAdminPtyHubState;
  constructor(private readonly env: any) {
    this.state = new FakeAdminPtyHubState(() => this.hubInstance!);
  }
  idFromName(name: string) { return { name }; }
  get(id: { name: string }) {
    if (!this.hubInstance) {
      this.hubInstance = new AdminPtyHubDurableObject(this.state as any, this.env);
    }
    return {
      fetch: async (request: Request) => {
        return this.hubInstance!.fetch(request);
      },
    };
  }
}

type TestEnv = {
  CC_DB: TestD1Database;
  CC_ADMIN_API_TOKEN?: string;
  CC_AGENT_DO?: FakeDurableObjectNamespace;
  CC_ADMIN_PTY_HUB?: FakeAdminPtyHubNamespace;
  uuid?: () => string;
  now?: () => number;
};

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
    const env: any = {
      CC_DB: db,
      CC_ADMIN_API_TOKEN: 'admin-token',
      uuid: () => `uuid-${++nextUuid}`,
      now: () => Date.parse('2026-04-29T00:00:00.000Z'),
    };
    env.CC_ADMIN_PTY_HUB = new FakeAdminPtyHubNamespace(env);
    return env;
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

  it('lists PTY sessions for a device over the admin API', async () => {
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({
      id: 'row-server-ssh-1',
      sessionId: 'server-ssh-srv-1-11111111-1111-4111-8111-111111111111',
      deviceId: 'dev-1',
      cols: 120,
      rows: 32,
      openedAt: '2026-04-29T00:00:00.000Z',
    });
    await sessions.markOpen('server-ssh-srv-1-11111111-1111-4111-8111-111111111111', '2026-04-29T00:00:01.000Z');

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/pty-sessions', {
      headers: { authorization: 'Bearer admin-token' },
    }), env as any);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          deviceId: 'dev-1',
          sessionId: 'server-ssh-srv-1-11111111-1111-4111-8111-111111111111',
          state: 'open',
          cols: 120,
          rows: 32,
        },
      ],
    });
  });

  it('omits failed PTY_NOT_FOUND sessions from the admin PTY session list', async () => {
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({
      id: 'row-failed-missing-1',
      sessionId: 'server-ssh-srv-1-missing-1',
      deviceId: 'dev-1',
      cols: 120,
      rows: 32,
      openedAt: '2026-04-29T00:00:00.000Z',
    });
    await sessions.markOpenFailed('server-ssh-srv-1-missing-1', 'PTY_NOT_FOUND', 'PTY session not found', '2026-04-29T00:00:01.000Z');
    await sessions.createOpening({
      id: 'row-opening-1',
      sessionId: 'server-ssh-srv-1-opening-1',
      deviceId: 'dev-1',
      cols: 120,
      rows: 32,
      openedAt: '2026-04-29T00:00:02.000Z',
    });

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/pty-sessions', {
      headers: { authorization: 'Bearer admin-token' },
    }), env as any);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          sessionId: 'server-ssh-srv-1-opening-1',
          state: 'opening',
        },
      ],
    });
  });

  it('expires stale opening PTY sessions before returning the admin PTY session list', async () => {
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({
      id: 'row-stale-opening-1',
      sessionId: 'server-ssh-srv-1-stale-opening',
      deviceId: 'dev-1',
      kind: 'server_ssh',
      serverId: 'srv-1',
      cols: 120,
      rows: 32,
      openedAt: '2026-04-28T23:57:00.000Z',
    });
    await sessions.createOpening({
      id: 'row-fresh-opening-1',
      sessionId: 'server-ssh-srv-2-fresh-opening',
      deviceId: 'dev-1',
      kind: 'server_ssh',
      serverId: 'srv-2',
      cols: 120,
      rows: 32,
      openedAt: '2026-04-28T23:59:59.000Z',
    });

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/pty-sessions', {
      headers: { authorization: 'Bearer admin-token' },
    }), env as any);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          sessionId: 'server-ssh-srv-2-fresh-opening',
          state: 'opening',
        },
      ],
    });
    await expect(sessions.get('server-ssh-srv-1-stale-opening')).resolves.toMatchObject({
      state: 'expired',
      failureCode: 'PTY_OPEN_TIMEOUT',
    });
  });

  it('adds serverId metadata to listed server SSH PTY sessions from the command payload', async () => {
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({
      id: 'row-legacy-server-ssh-1',
      sessionId: '36528a8f-fa45-454c-82fa-4fa34fb4daec',
      deviceId: 'dev-1',
      cols: 120,
      rows: 32,
      openedAt: '2026-05-05T04:47:29.071Z',
    });
    await new D1CommandStore(env.CC_DB).createQueuedCommand({
      id: 'command-row-1',
      commandId: '36528a8f-fa45-454c-82fa-4fa34fb4daec',
      deviceId: 'dev-1',
      commandType: 'start_server_ssh',
      actorType: 'admin_session',
      payload: { serverId: 'srv-1', sessionId: '36528a8f-fa45-454c-82fa-4fa34fb4daec' },
      submittedAt: '2026-05-05T04:47:29.071Z',
    });

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/pty-sessions', {
      headers: { authorization: 'Bearer admin-token' },
    }), env as any);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          sessionId: '36528a8f-fa45-454c-82fa-4fa34fb4daec',
          state: 'opening',
          serverId: 'srv-1',
        },
      ],
    });
  });

  it('lists PTY session kind and server metadata stored on the PTY row', async () => {
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({
      id: 'row-server-ssh-metadata-1',
      sessionId: 'server-ssh-srv-1-11111111-1111-4111-8111-111111111111',
      deviceId: 'dev-1',
      kind: 'server_ssh',
      serverId: 'srv-1',
      localSessionId: 'local-ssh-session-1',
      cols: 120,
      rows: 32,
      openedAt: '2026-05-05T04:47:29.071Z',
    });

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/pty-sessions', {
      headers: { authorization: 'Bearer admin-token' },
    }), env as any);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          sessionId: 'server-ssh-srv-1-11111111-1111-4111-8111-111111111111',
          kind: 'server_ssh',
          serverId: 'srv-1',
          localSessionId: 'local-ssh-session-1',
        },
      ],
    });
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


  it('accepts browser PTY messages that wrap fields in payload', async () => {
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
    await sessions.createOpening({ id: 'row-pty-payload', sessionId: 'pty-payload', deviceId: 'dev-1', cols: 80, rows: 24, openedAt: '2026-04-29T00:00:00.000Z' });
    await sessions.markOpen('pty-payload', '2026-04-29T00:00:01.000Z');

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      await listeners.get('message')?.({
        data: JSON.stringify({
          type: 'pty_attach',
          payload: { deviceId: 'dev-1', sessionId: 'pty-payload', csrfToken: 'csrf' },
        }),
      });

      await expect(sessions.get('pty-payload')).resolves.toMatchObject({
        attachedActorType: 'admin_env_token',
        attachedActorId: 'CC_ADMIN_API_TOKEN',
      });
      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('pty_attached'));
      expect(serverSocket.send).not.toHaveBeenCalledWith(expect.stringContaining('SESSION_ID_REQUIRED'));
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

  it('assigns unique reqSeq values so PTY nacks fail the matching command only', async () => {
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
    await sessions.createOpening({ id: 'row-pty-unique-seq', sessionId: 'pty-unique-seq', deviceId: 'dev-1', cols: 80, rows: 24, openedAt: '2026-04-29T00:00:00.000Z', attachedActorType: 'admin_env_token', attachedActorId: 'CC_ADMIN_API_TOKEN' });
    await sessions.markOpen('pty-unique-seq', '2026-04-29T00:00:01.000Z');

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_write', sessionId: 'pty-unique-seq', data: 'a' }) });
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_resize', sessionId: 'pty-unique-seq', cols: 120, rows: 50 }) });

      const firstEnvelope = await env.CC_AGENT_DO.requests[0].request.json() as any;
      const secondEnvelope = await env.CC_AGENT_DO.requests[1].request.json() as any;
      expect(firstEnvelope.seq).not.toBe(secondEnvelope.seq);

      const durableObject = new AgentConnectionDurableObject({} as any, env as any);
      await durableObject.webSocketMessage({ deserializeAttachment: () => ({ deviceId: 'dev-1' }), send: vi.fn() } as any, JSON.stringify({
        type: 'nack',
        deviceId: 'dev-1',
        reqSeq: firstEnvelope.seq,
        ts: '2026-04-29T00:00:02.000Z',
        payload: { error: 'PTY_NOT_FOUND', detail: 'PTY session not found' },
      }));

      await expect(new D1CommandStore(env.CC_DB).getCommand(firstEnvelope.commandId)).resolves.toMatchObject({ state: 'failed', reasonCode: 'PTY_NOT_FOUND' });
      await expect(new D1CommandStore(env.CC_DB).getCommand(secondEnvelope.commandId)).resolves.toMatchObject({ state: 'dispatched' });
      await expect(sessions.get('pty-unique-seq')).resolves.toMatchObject({ state: 'failed', failureCode: 'PTY_NOT_FOUND' });
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });

  it('rejects writes to terminal PTY sessions instead of dispatching stale commands', async () => {
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
    await sessions.createOpening({ id: 'row-pty-terminal', sessionId: 'pty-terminal', deviceId: 'dev-1', cols: 80, rows: 24, openedAt: '2026-04-29T00:00:00.000Z', attachedActorType: 'admin_env_token', attachedActorId: 'CC_ADMIN_API_TOKEN' });
    await sessions.markOpenFailed('pty-terminal', 'PTY_NOT_FOUND', 'PTY session not found', '2026-04-29T00:00:01.000Z');

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_write', sessionId: 'pty-terminal', data: 'stale' }) });

      expect(serverSocket.send).toHaveBeenCalledWith(expect.stringContaining('PTY_SESSION_NOT_ACTIVE'));
      expect(env.CC_AGENT_DO.requests).toHaveLength(0);
      await expect(new D1CommandStore(env.CC_DB).listCommands({ deviceId: 'dev-1' })).resolves.toHaveLength(0);
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });

  it('marks PTY sessions failed when command_status reports PTY_NOT_FOUND', async () => {
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({ id: 'row-status-missing', sessionId: 'pty-status-missing', deviceId: 'dev-1', cols: 80, rows: 24, openedAt: '2026-04-29T00:00:00.000Z' });
    await sessions.markOpen('pty-status-missing', '2026-04-29T00:00:01.000Z');
    const commands = new D1CommandStore(env.CC_DB);
    await commands.createQueuedCommand({
      id: 'cmd-status-missing-row',
      commandId: 'cmd-status-missing',
      deviceId: 'dev-1',
      commandType: 'write_pty',
      actorType: 'admin_env_token',
      actorId: 'CC_ADMIN_API_TOKEN',
      payload: { sessionId: 'pty-status-missing', data: 'x' },
      payloadSummary: 'Write stale PTY',
      submittedAt: '2026-04-29T00:00:01.000Z',
    });
    await commands.markDispatched('cmd-status-missing', 7, '2026-04-29T00:00:01.000Z');

    const durableObject = new AgentConnectionDurableObject({} as any, env as any);
    await durableObject.webSocketMessage({ deserializeAttachment: () => ({ deviceId: 'dev-1' }), send: vi.fn() } as any, JSON.stringify({
      type: 'command_status',
      seq: 99,
      commandId: 'cmd-status-missing',
      deviceId: 'dev-1',
      ts: '2026-04-29T00:00:02.000Z',
      payload: { state: 'failed', reasonCode: 'PTY_NOT_FOUND', reasonDetail: 'PTY session not found' },
    }));

    await expect(commands.getCommand('cmd-status-missing')).resolves.toMatchObject({ state: 'failed', reasonCode: 'PTY_NOT_FOUND' });
    await expect(sessions.get('pty-status-missing')).resolves.toMatchObject({ state: 'failed', failureCode: 'PTY_NOT_FOUND' });
  });

  it('assigns unique reqSeq values to server SSH start commands', async () => {
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const firstResponse = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-start-server-ssh', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv-1', cols: 120, rows: 32 }),
    }), env as any);
    const secondResponse = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-start-server-ssh', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv-2', cols: 120, rows: 32 }),
    }), env as any);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const firstEnvelope = await env.CC_AGENT_DO.requests[0].request.json() as any;
    const secondEnvelope = await env.CC_AGENT_DO.requests[1].request.json() as any;
    expect(firstEnvelope.seq).not.toBe(secondEnvelope.seq);
    await expect(firstResponse.json()).resolves.toMatchObject({ reqSeq: firstEnvelope.seq });
    await expect(secondResponse.json()).resolves.toMatchObject({ reqSeq: secondEnvelope.seq });
  });

  it('marks server SSH PTY sessions open when the agent acks the start command', async () => {
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-start-server-ssh', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv-1', cols: 120, rows: 32 }),
    }), env as any);
    expect(response.status).toBe(200);
    const envelope = await env.CC_AGENT_DO.requests[0].request.json() as any;

    const durableObject = new AgentConnectionDurableObject({} as any, env as any);
    await durableObject.webSocketMessage({ deserializeAttachment: () => ({ deviceId: 'dev-1' }), send: vi.fn() } as any, JSON.stringify({
      type: 'ack',
      deviceId: 'dev-1',
      reqSeq: envelope.seq,
      ts: '2026-04-29T00:00:02.000Z',
      payload: { sessionId: envelope.payload.sessionId, localSessionId: 'local-ssh-1' },
    }));

    await expect(new D1PtySessionStore(env.CC_DB).get(envelope.payload.sessionId)).resolves.toMatchObject({
      state: 'open',
      localSessionId: 'local-ssh-1',
    });
  });

  it('rejects stale server SSH attach requests before creating a PTY session', async () => {
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();
    await new D1LogStore(env.CC_DB).append({
      id: 'stale-function-status',
      deviceId: 'dev-1',
      type: 'function-status',
      functionId: 'server-ssh-srv-1',
      sessionId: 'pty-3',
      seq: 1,
      ts: '2026-04-28T23:55:00.000Z',
      payload: { functionId: 'server-ssh-srv-1', state: 'running', sessionId: 'pty-3' },
    });

    const response = await worker.fetch(new Request('https://cc.example.test/v1/devices/dev-1/request-attach-server-ssh', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ serverId: 'srv-1', localSessionId: 'pty-3', cols: 120, rows: 32 }),
    }), env as any);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'STALE_SSH_SESSION' });
    await expect(new D1PtySessionStore(env.CC_DB).listByDevice('dev-1')).resolves.toHaveLength(0);
    expect(env.CC_AGENT_DO.requests).toHaveLength(0);
  });

  it('expires volatile PTY sessions and clears tunnel state when agent run id changes', async () => {
    const env = await createEnv();
    const logs = new D1LogStore(env.CC_DB);
    await logs.append({
      id: 'old-status',
      deviceId: 'dev-1',
      type: 'status_snapshot',
      sessionId: null,
      functionId: null,
      seq: 1,
      ts: '2026-04-29T00:00:00.000Z',
      payload: {
        agentRunId: 'run-old',
        functionStates: [
          { functionId: 'server-tunnel-srv-1', state: 'running', sessionId: 'tunnel-pty-1', message: 'Tunnel active' },
          { functionId: 'server-ssh-srv-1', state: 'running', sessionId: 'ssh-pty-1', message: 'SSH active' },
          { functionId: 'openvpn-connect', state: 'running', sessionId: 'vpn-pty-1', message: 'VPN active' },
        ],
      },
    });
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({ id: 'row-tunnel', sessionId: 'tunnel-pty-1', deviceId: 'dev-1', cols: 120, rows: 32, openedAt: '2026-04-29T00:00:00.000Z' });
    await sessions.markOpen('tunnel-pty-1', '2026-04-29T00:00:01.000Z');

    const durableObject = new AgentConnectionDurableObject({} as any, env as any);
    await durableObject.webSocketMessage({ deserializeAttachment: () => ({ deviceId: 'dev-1' }), send: vi.fn() } as any, JSON.stringify({
      type: 'heartbeat',
      deviceId: 'dev-1',
      seq: 2,
      ts: '2026-04-29T00:00:05.000Z',
      payload: { agentRunId: 'run-new', uptimeSec: 1 },
    }));

    await expect(sessions.get('tunnel-pty-1')).resolves.toMatchObject({
      state: 'expired',
      failureCode: 'AGENT_RESTARTED',
    });
    await expect(logs.getDeviceRuntimeSummary('dev-1')).resolves.toMatchObject({
      agentRunId: 'run-new',
      functions: {
        'server-tunnel-srv-1': { state: 'idle', sessionId: null, message: expect.stringContaining('Agent restarted') },
        'server-ssh-srv-1': { state: 'idle', sessionId: null, message: expect.stringContaining('Agent restarted') },
        'openvpn-connect': { state: 'running', sessionId: 'vpn-pty-1' },
      },
    });
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


  it('dispatches request_pty_scrollback on admin attach and replays device pty-scrollback to admin', async () => {
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
    await sessions.createOpening({ id: 'row-pty-scroll', sessionId: 'pty-scroll', deviceId: 'dev-1', openedAt: '2026-04-29T00:00:00.000Z' });
    await sessions.markOpen('pty-scroll', '2026-04-29T00:00:01.000Z');

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_attach', sessionId: 'pty-scroll' }) });

      expect(env.CC_AGENT_DO.requests.length).toBeGreaterThanOrEqual(1);
      const scrollDispatch = await env.CC_AGENT_DO.requests[env.CC_AGENT_DO.requests.length - 1].request.json() as any;
      expect(scrollDispatch.type).toBe('request_pty_scrollback');
      expect(scrollDispatch.payload).toMatchObject({ sessionId: 'pty-scroll' });

      const agentSocket = { deserializeAttachment: () => ({ deviceId: 'dev-1' }), send: vi.fn() };
      const durableObject = new AgentConnectionDurableObject({} as any, env as any);
      await durableObject.webSocketMessage(agentSocket as any, JSON.stringify({
        type: 'pty-scrollback',
        deviceId: 'dev-1',
        seq: 42,
        payload: {
          sessionId: 'pty-scroll',
          data: 'uname -a\nLinux box\n',
          truncated: false,
        },
      }));

      const sent = serverSocket.send.mock.calls.map((c) => JSON.parse(String(c[0])));
      const attachedIdx = sent.findIndex((m) => m.type === 'pty_attached');
      const replayIdx = sent.findIndex((m) => m.type === 'pty_output' && m.payload?.replay === true);
      expect(attachedIdx).toBeGreaterThanOrEqual(0);
      expect(replayIdx).toBeGreaterThanOrEqual(0);
      expect(attachedIdx).toBeLessThan(replayIdx);
      expect(sent[replayIdx]).toMatchObject({
        type: 'pty_output',
        payload: {
          sessionId: 'pty-scroll',
          deviceId: 'dev-1',
          data: 'uname -a\nLinux box\n',
          replay: true,
          truncated: false,
        },
      });
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });


  it('fans out pty-output from DO to admin WS via internal relay endpoint', async () => {
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
    const serverSocket = {
      accept: vi.fn(),
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: (event: { data?: unknown }) => unknown) => listeners.set(type, listener)),
    };
    vi.stubGlobal('WebSocketPair', vi.fn(function(this: unknown) { return [{ client: true }, serverSocket]; }) as any);
    const env = await createEnv();
    const sessions = new D1PtySessionStore(env.CC_DB);
    await sessions.createOpening({ id: 'row-pty-relay', sessionId: 'pty-relay', deviceId: 'dev-1', openedAt: '2026-04-29T00:00:00.000Z' });
    await sessions.markOpen('pty-relay', '2026-04-29T00:00:01.000Z');

    try {
      await worker.fetch(wsRequest({ authorization: 'Bearer admin-token' }), env as any);
      await listeners.get('message')?.({ data: JSON.stringify({ type: 'pty_attach', sessionId: 'pty-relay' }) });

      // Restore original Response so the fanout endpoint returns a proper Response with .json()
      vi.stubGlobal('Response', OriginalResponse);

      const response = await worker.fetch(new Request('https://cc.internal/internal/pty-fanout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'pty-relay',
          type: 'pty_output',
          payload: { sessionId: 'pty-relay', deviceId: 'dev-1', data: 'hello from DO relay' },
        }),
      }), env as any);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true });
      expect(serverSocket.send).toHaveBeenCalledWith(JSON.stringify({
        type: 'pty_output',
        payload: { sessionId: 'pty-relay', deviceId: 'dev-1', data: 'hello from DO relay' },
      }));
    } finally {
      vi.stubGlobal('Response', OriginalResponse);
    }
  });

  it('returns delivered zero when no subscribers for session', async () => {
    const env = await createEnv();
    const response = await worker.fetch(new Request('https://cc.internal/internal/pty-fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'no-such-session',
        type: 'pty_output',
        payload: { sessionId: 'no-such-session', deviceId: 'dev-1', data: 'no one listening' },
      }),
    }), env as any);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, delivered: 0 });
  });

});
