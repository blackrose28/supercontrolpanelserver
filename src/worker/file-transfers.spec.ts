import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import worker, { AgentConnectionDurableObject } from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';
import { D1DeviceStore } from './db/d1-device-store';
import { D1CommandStore } from './db/d1-command-store';
import { D1FileTransferStore, D1RemoteBrowserSessionStore } from './db/d1-file-op-store';

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

type TestEnv = { CC_DB: TestD1Database; CC_ADMIN_API_TOKEN: string; CC_AGENT_DO?: FakeDurableObjectNamespace; uuid?: () => string; now?: () => number };

describe('Worker file transfer routes', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  async function createEnv() {
    const db = new TestD1Database();
    databases.push(db);
    await new D1DeviceStore(db).addDevice({ id: 'dev-1', name: 'One', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-1' });
    await new D1DeviceStore(db).addDevice({ id: 'dev-2', name: 'Two', lastSeenAt: '2026-04-29T00:00:00.000Z', status: 'connected', agentToken: 'agent-token-2' });
    const transfers = new D1FileTransferStore(db);
    await transfers.create({ id: 'row-1', transferId: 'tr-running', deviceId: 'dev-1', serverId: 'srv-1', direction: 'upload', localPath: '/tmp/a', remotePath: '/srv/a', ts: '2026-04-29T00:00:00.000Z' });
    await transfers.updateProgress('tr-running', '2026-04-29T00:00:01.000Z', { bytesTransferred: 512, bytesTotal: 1024, percent: 50, message: 'copying' });
    await transfers.create({ id: 'row-2', transferId: 'tr-done', deviceId: 'dev-1', serverId: 'srv-1', direction: 'download', localPath: '/tmp/b', remotePath: '/srv/b', ts: '2026-04-29T00:01:00.000Z' });
    await transfers.markState('tr-done', 'succeeded', '2026-04-29T00:01:05.000Z', { message: 'done' });
    await transfers.create({ id: 'row-3', transferId: 'tr-other-device', deviceId: 'dev-2', serverId: 'srv-2', direction: 'upload', ts: '2026-04-29T00:02:00.000Z' });
    await transfers.markState('tr-other-device', 'failed', '2026-04-29T00:02:05.000Z');
    let nextUuid = 0;
    return { CC_DB: db, CC_ADMIN_API_TOKEN: 'admin-token', uuid: () => `uuid-${++nextUuid}`, now: () => Date.parse('2026-04-29T00:00:00.000Z') } satisfies TestEnv;
  }

  function request(path: string, env: TestEnv, init: RequestInit = {}) {
    return worker.fetch(new Request(`https://cc.example.test${path}`, init), env as any);
  }

  const headers = { authorization: 'Bearer admin-token' };
  const jsonHeaders = { ...headers, 'content-type': 'application/json' };

  it('lists file transfers for a device with limit validation', async () => {
    const env = await createEnv();

    const response = await request('/v1/file-transfers?deviceId=dev-1&limit=10', env, { headers });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.items.map((item: any) => item.transferId)).toEqual(['tr-done', 'tr-running']);
    expect(body.items[1]).toMatchObject({ state: 'running', bytesTransferred: 512, percent: 50 });
  });

  it('requires admin auth and validates the requested device', async () => {
    const env = await createEnv();

    expect((await request('/v1/file-transfers?deviceId=dev-1', env)).status).toBe(401);
    expect((await request('/v1/file-transfers', env, { headers })).status).toBe(400);
    expect((await request('/v1/file-transfers?deviceId=missing', env, { headers })).status).toBe(404);
  });

  it('dismisses finished transfers and rejects unfinished transfers', async () => {
    const env = await createEnv();

    const running = await request('/v1/file-transfers/dismiss', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-running' }) });
    expect(running.status).toBe(409);

    const done = await request('/v1/file-transfers/dismiss', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-done' }) });
    expect(done.status).toBe(200);
    await expect(done.json()).resolves.toMatchObject({ ok: true, transferId: 'tr-done' });

    const listed = await request('/v1/file-transfers?deviceId=dev-1', env, { headers });
    const body = await listed.json() as any;
    expect(body.items.map((item: any) => item.transferId)).toEqual(['tr-running']);
  });

  it('stops and force-removes transfers and clears finished transfers by device', async () => {
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const stop = await request('/v1/file-transfers/stop', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-running' }) });
    expect(stop.status).toBe(200);
    await expect(stop.json()).resolves.toMatchObject({ ok: true, transferId: 'tr-running', state: 'canceled' });
    await expect(new D1CommandStore(env.CC_DB).getCommand('uuid-2')).resolves.toMatchObject({
      commandType: 'stop_file_transfer',
      state: 'dispatched',
      payload: { transferId: 'tr-running' },
    });

    const force = await request('/v1/file-transfers/force-remove', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', transferId: 'tr-running' }) });
    expect(force.status).toBe(200);
    await expect(force.json()).resolves.toMatchObject({ ok: true, transferId: 'tr-running', forced: false });

    const clear = await request('/v1/file-transfers/dismiss-finished', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1' }) });
    expect(clear.status).toBe(200);
    await expect(clear.json()).resolves.toMatchObject({ ok: true, deletedCount: 1 });

    const otherDevice = await request('/v1/file-transfers?deviceId=dev-2', env, { headers });
    const body = await otherDevice.json() as any;
    expect(body.items.map((item: any) => item.transferId)).toEqual(['tr-other-device']);
  });

  it('opens a remote browser by creating browser session state and dispatching an agent command', async () => {
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const response = await request('/v1/file-ops/remote-browser/open', env, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ deviceId: 'dev-1', serverId: 'srv-1', rootPath: '/srv' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      browserId: 'uuid-1',
      deviceId: 'dev-1',
      serverId: 'srv-1',
      state: 'opening',
    });
    await expect(new D1RemoteBrowserSessionStore(env.CC_DB).get('uuid-1')).resolves.toMatchObject({
      browserSessionId: 'uuid-1',
      deviceId: 'dev-1',
      serverId: 'srv-1',
      state: 'opening',
      rootPath: '/srv',
    });
    await expect(new D1CommandStore(env.CC_DB).getCommand('uuid-3')).resolves.toMatchObject({
      commandType: 'open_remote_browser',
      state: 'dispatched',
      payload: { browserId: 'uuid-1', serverId: 'srv-1', rootPath: '/srv' },
    });
    expect(env.CC_AGENT_DO.requests).toHaveLength(1);
    await expect(env.CC_AGENT_DO.requests[0].request.json()).resolves.toMatchObject({
      type: 'open_remote_browser',
      payload: { browserId: 'uuid-1', serverId: 'srv-1', rootPath: '/srv' },
    });
  });

  it('validates and dispatches remote browser list/stat/mkdir/delete/close commands', async () => {
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();
    const browsers = new D1RemoteBrowserSessionStore(env.CC_DB);
    await browsers.createOpening({ id: 'browser-row-1', browserSessionId: 'browser-1', deviceId: 'dev-1', serverId: 'srv-1', openedAt: '2026-04-29T00:00:00.000Z', rootPath: '/srv' });
    await browsers.markOpen('browser-1', '2026-04-29T00:00:01.000Z', '/srv');

    const list = await request('/v1/file-ops/remote-browser/list', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', browserId: 'browser-1', path: '/srv/logs' }) });
    const stat = await request('/v1/file-ops/remote-browser/stat', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', browserId: 'browser-1', path: '/srv/app.log' }) });
    const mkdir = await request('/v1/file-ops/remote-browser/mkdir', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', browserId: 'browser-1', path: '/srv/new' }) });
    const del = await request('/v1/file-ops/remote-browser/delete', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', browserId: 'browser-1', path: '/srv/old', recursive: true }) });
    const close = await request('/v1/file-ops/remote-browser/close', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', browserId: 'browser-1' }) });

    expect([list.status, stat.status, mkdir.status, del.status, close.status]).toEqual([200, 200, 200, 200, 200]);
    expect(env.CC_AGENT_DO.requests).toHaveLength(5);
    const envelopes = await Promise.all(env.CC_AGENT_DO.requests.map((entry) => entry.request.json() as Promise<any>));
    expect(envelopes.map((envelope) => envelope.type)).toEqual([
      'list_remote_browser_children',
      'stat_remote_browser_path',
      'create_remote_browser_directory',
      'delete_remote_browser_path',
      'close_remote_browser',
    ]);
    expect(envelopes[0].payload).toMatchObject({ browserId: 'browser-1', path: '/srv/logs' });
    expect(envelopes[3].payload).toMatchObject({ browserId: 'browser-1', path: '/srv/old', recursive: true });
    await expect(browsers.get('browser-1')).resolves.toMatchObject({
      state: 'closed',
      currentPath: '/srv/logs',
      closedAt: '2026-04-29T00:00:00.000Z',
    });

    const missingPath = await request('/v1/file-ops/remote-browser/list', env, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ deviceId: 'dev-1', browserId: 'browser-1' }) });
    expect(missingPath.status).toBe(400);
  });

  it('creates SCP upload and download transfer records and dispatches start commands', async () => {
    const env = await createEnv();
    env.CC_AGENT_DO = new FakeDurableObjectNamespace();

    const upload = await request('/v1/file-transfers/upload', env, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ deviceId: 'dev-1', serverId: 'srv-1', localPath: 'C:\\tmp\\a.txt', remotePath: '/srv/a.txt', recursive: false }),
    });
    const download = await request('/v1/file-transfers/download', env, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ deviceId: 'dev-1', serverId: 'srv-1', remotePath: '/srv/b', localPath: 'C:\\tmp\\b', recursive: true }),
    });

    expect([upload.status, download.status]).toEqual([200, 200]);
    await expect(upload.json()).resolves.toMatchObject({ transferId: 'uuid-1', direction: 'upload', state: 'queued' });
    await expect(download.json()).resolves.toMatchObject({ transferId: 'uuid-4', direction: 'download', state: 'queued' });
    await expect(new D1FileTransferStore(env.CC_DB).get('uuid-1')).resolves.toMatchObject({
      transferId: 'uuid-1',
      direction: 'upload',
      commandId: 'uuid-3',
      localPath: 'C:\\tmp\\a.txt',
      remotePath: '/srv/a.txt',
    });
    await expect(new D1FileTransferStore(env.CC_DB).get('uuid-4')).resolves.toMatchObject({
      transferId: 'uuid-4',
      direction: 'download',
      commandId: 'uuid-6',
      recursive: true,
    });
    const envelopes = await Promise.all(env.CC_AGENT_DO.requests.map((entry) => entry.request.json() as Promise<any>));
    expect(envelopes.map((envelope) => envelope.type)).toEqual(['start_scp_upload', 'start_scp_download']);
    expect(envelopes[0].payload).toMatchObject({ transferId: 'uuid-1', serverId: 'srv-1', localPath: 'C:\\tmp\\a.txt', remotePath: '/srv/a.txt', recursive: false });
    expect(envelopes[1].payload).toMatchObject({ transferId: 'uuid-4', serverId: 'srv-1', remotePath: '/srv/b', localPath: 'C:\\tmp\\b', recursive: true });
  });

  it('updates transfer state from agent transfer progress and status messages', async () => {
    const env = await createEnv();
    const transfers = new D1FileTransferStore(env.CC_DB);
    await transfers.create({ id: 'agent-row-1', transferId: 'agent-tr-1', deviceId: 'dev-1', serverId: 'srv-1', direction: 'download', ts: '2026-04-29T00:00:00.000Z' });
    const durableObject = new AgentConnectionDurableObject({} as any, env as any);
    const agentSocket = { send: () => {}, deserializeAttachment: () => ({ deviceId: 'dev-1' }) };

    await durableObject.webSocketMessage(agentSocket as any, JSON.stringify({
      type: 'transfer_progress',
      payload: { transferId: 'agent-tr-1', bytesTransferred: 256, bytesTotal: 1024, percent: 25, phase: 'copy', message: 'copying' },
    }));
    await expect(transfers.get('agent-tr-1')).resolves.toMatchObject({
      state: 'running',
      bytesTransferred: 256,
      bytesTotal: 1024,
      percent: 25,
      phase: 'copy',
      message: 'copying',
    });

    await durableObject.webSocketMessage(agentSocket as any, JSON.stringify({
      type: 'transfer_status',
      payload: { transferId: 'agent-tr-1', state: 'succeeded', phase: 'finalize', message: 'done' },
    }));
    await expect(transfers.get('agent-tr-1')).resolves.toMatchObject({
      state: 'succeeded',
      phase: 'finalize',
      message: 'done',
      finishedAt: '2026-04-29T00:00:00.000Z',
    });
  });
});
