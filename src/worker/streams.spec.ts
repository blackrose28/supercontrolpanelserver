import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';
import { D1DeviceStore } from './db/d1-device-store';
import { D1LogStore } from './db/d1-log-store';
import { D1CommandStore } from './db/d1-command-store';
import { D1FileTransferStore } from './db/d1-file-op-store';

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

type TestEnv = { CC_DB: TestD1Database; CC_ADMIN_API_TOKEN: string; streamPollMs?: number };

async function firstStreamChunk(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value);
}

describe('Worker admin live streams', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { vi.useRealTimers(); while (databases.length) databases.pop()?.close(); });

  async function createEnv() {
    const db = new TestD1Database();
    databases.push(db);
    await new D1DeviceStore(db).addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1' });
    await new D1LogStore(db).append({ id: 'evt-1', deviceId: 'dev-1', type: 'function-status', functionId: 'openvpn-connect', seq: 1, ts: '2026-04-29T00:00:01.000Z', payload: { state: 'running' } });
    const commands = new D1CommandStore(db);
    await commands.createQueuedCommand({ id: 'cmd-row-1', commandId: 'cmd-1', deviceId: 'dev-1', commandType: 'request_status_snapshot', actorType: 'admin_env_token', submittedAt: '2026-04-29T00:00:02.000Z' });
    await commands.markDispatched('cmd-1', 1, '2026-04-29T00:00:03.000Z');
    const transfers = new D1FileTransferStore(db);
    await transfers.create({ id: 'tr-row-1', transferId: 'tr-1', deviceId: 'dev-1', serverId: 'srv-1', direction: 'upload', localPath: '/tmp/a', remotePath: '/srv/a', ts: '2026-04-29T00:00:04.000Z' });
    await transfers.updateProgress('tr-1', '2026-04-29T00:00:05.000Z', { bytesTransferred: 64, bytesTotal: 100, percent: 64 });
    return { CC_DB: db, CC_ADMIN_API_TOKEN: 'admin-token' } satisfies TestEnv;
  }

  function request(path: string, env: TestEnv) {
    return worker.fetch(new Request(`https://cc.example.test${path}`, { headers: { authorization: 'Bearer admin-token' } }), env as any);
  }

  it('streams connected device events in EventSource format', async () => {
    const env = await createEnv();

    const response = await request('/v1/devices/stream', env);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const chunk = await firstStreamChunk(response);
    expect(chunk).toContain(': connected');
  });

  it('streams telemetry, command, and file transfer events by device', async () => {
    const env = await createEnv();

    const telemetry = await firstStreamChunk(await request('/v1/logs/stream?deviceId=dev-1', env));
    expect(telemetry).toContain(': connected');

    const command = await firstStreamChunk(await request('/v1/commands/stream?deviceId=dev-1', env));
    expect(command).toContain(': connected');

    const transfer = await firstStreamChunk(await request('/v1/file-transfers/stream?deviceId=dev-1', env));
    expect(transfer).toContain(': connected');
  });



  it('polls telemetry streams for new D1 records after the stream opens', async () => {
    vi.useFakeTimers();
    const env = await createEnv();
    env.streamPollMs = 25;
    const response = await request('/v1/logs/stream?deviceId=dev-1', env);
    const reader = response.body!.getReader();
    await reader.read();

    await new D1LogStore(env.CC_DB).append({ id: 'evt-live', deviceId: 'dev-1', type: 'function-status', functionId: 'boundary-auth', seq: 2, ts: '2026-04-29T00:00:06.000Z', payload: { state: 'running' } });
    await vi.advanceTimersByTimeAsync(30);
    const { value } = await reader.read();
    await reader.cancel();

    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain('event: telemetry');
    expect(chunk).toContain('"id":"evt-live"');
  });

  it('requires admin auth and validates stream device ids', async () => {
    const env = await createEnv();

    const unauthorized = await worker.fetch(new Request('https://cc.example.test/v1/logs/stream?deviceId=dev-1'), env as any);
    expect(unauthorized.status).toBe(401);
    expect((await request('/v1/logs/stream', env)).status).toBe(400);
    expect((await request('/v1/logs/stream?deviceId=missing', env)).status).toBe(404);
  });

  it('returns tunnel PTY logs for a server runtime route', async () => {
    const env = await createEnv();
    await new D1LogStore(env.CC_DB).append({
      id: 'evt-tun-1',
      deviceId: 'dev-1',
      type: 'function-status',
      functionId: 'server-tunnel-srv-1',
      sessionId: 'tun-1',
      seq: 3,
      ts: '2026-04-29T00:00:06.000Z',
      payload: { functionId: 'server-tunnel-srv-1', state: 'running', sessionId: 'tun-1' },
    });
    await new D1LogStore(env.CC_DB).append({
      id: 'evt-tun-out-1',
      deviceId: 'dev-1',
      type: 'pty-output',
      functionId: 'server-tunnel-srv-1',
      sessionId: 'tun-1',
      seq: 4,
      ts: '2026-04-29T00:00:07.000Z',
      payload: { data: 'Tunnel connected' },
    });

    const response = await request('/v1/devices/dev-1/tunnels/srv-1/logs?limit=200&offset=0', env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      entries: [
        {
          sessionId: 'tun-1',
          data: 'Tunnel connected',
        },
      ],
      total: 1,
    });
  });
});
