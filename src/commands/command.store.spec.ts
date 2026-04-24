import { firstValueFrom, timeout } from 'rxjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database.service';
import { CommandStore, type CommandRecord } from './command.store';

const createdPaths: string[] = [];

function createStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-server-command-store-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  createdPaths.push(tempDir);

  process.env.CC_DB_PATH = dbPath;

  const database = new DatabaseService();
  ensureDevice(database, 'dev-1');
  ensureDevice(database, 'dev-2');
  const store = new CommandStore(database);
  return { database, store };
}

function ensureDevice(database: DatabaseService, deviceId: string) {
  database.connection
    .prepare(
      `
        INSERT INTO devices (id, name, lastSeenAt, status, agentToken, os)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run(deviceId, deviceId, '2026-04-23T00:00:00.000Z', 'connected', `token-${deviceId}`, 'linux');
}

afterEach(() => {
  for (const p of createdPaths.splice(0)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
});

describe('CommandStore streaming', () => {
  let store: CommandStore;

  beforeEach(() => {
    const result = createStore();
    store = result.store;
  });

  it('streamByDevice returns an Observable', () => {
    const observable = store.streamByDevice('dev-1');
    expect(observable).toBeDefined();
    expect(typeof observable.subscribe).toBe('function');
  });

  it('emits a record when a command is created for that device', async () => {
    const emitted: CommandRecord[] = [];
    const sub = store.streamByDevice('dev-1').subscribe((record) => emitted.push(record));

    store.createQueuedCommand({
      id: 'row-1',
      commandId: 'cmd-1',
      deviceId: 'dev-1',
      commandType: 'request_status_snapshot',
      actorType: 'admin_session',
      actorId: 'session-1',
      submittedAt: '2026-04-23T00:00:00.000Z',
    });

    // Give synchronous Subject a tick
    await new Promise((r) => setTimeout(r, 0));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].commandId).toBe('cmd-1');
    expect(emitted[0].state).toBe('queued');

    sub.unsubscribe();
  });

  it('does not emit when a command is created for a different device', async () => {
    const emitted: CommandRecord[] = [];
    const sub = store.streamByDevice('dev-1').subscribe((record) => emitted.push(record));

    store.createQueuedCommand({
      id: 'row-1',
      commandId: 'cmd-2',
      deviceId: 'dev-2',
      commandType: 'request_status_snapshot',
      actorType: 'admin_session',
      actorId: 'session-1',
      submittedAt: '2026-04-23T00:00:00.000Z',
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(emitted).toHaveLength(0);
    sub.unsubscribe();
  });

  it('emits on markDispatched', async () => {
    store.createQueuedCommand({
      id: 'row-1',
      commandId: 'cmd-3',
      deviceId: 'dev-1',
      commandType: 'request_status_snapshot',
      actorType: 'admin_session',
      actorId: 'session-1',
      submittedAt: '2026-04-23T00:00:00.000Z',
    });

    const emitted: CommandRecord[] = [];
    const sub = store.streamByDevice('dev-1').subscribe((record) => {
      if (record.commandId === 'cmd-3') emitted.push(record);
    });

    store.markDispatched('cmd-3', 1, '2026-04-23T00:00:01.000Z');
    await new Promise((r) => setTimeout(r, 0));

    const dispatched = emitted.find((r) => r.state === 'dispatched');
    expect(dispatched).toBeDefined();
    expect(dispatched!.reqSeq).toBe(1);
    sub.unsubscribe();
  });

  it('emits on markExecuting', async () => {
    store.createQueuedCommand({
      id: 'row-1',
      commandId: 'cmd-4',
      deviceId: 'dev-1',
      commandType: 'request_status_snapshot',
      actorType: 'admin_session',
      actorId: 'session-1',
      submittedAt: '2026-04-23T00:00:00.000Z',
    });

    const emitted: CommandRecord[] = [];
    const sub = store.streamByDevice('dev-1').subscribe((record) => {
      if (record.commandId === 'cmd-4') emitted.push(record);
    });

    store.markDispatched('cmd-4', 1, '2026-04-23T00:00:01.000Z');
    store.markExecuting('cmd-4', '2026-04-23T00:00:02.000Z');
    await new Promise((r) => setTimeout(r, 0));

    const executing = emitted.find((r) => r.state === 'executing');
    expect(executing).toBeDefined();
    sub.unsubscribe();
  });

  it('emits on markSucceeded', async () => {
    store.createQueuedCommand({
      id: 'row-1',
      commandId: 'cmd-5',
      deviceId: 'dev-1',
      commandType: 'request_status_snapshot',
      actorType: 'admin_session',
      actorId: 'session-1',
      submittedAt: '2026-04-23T00:00:00.000Z',
    });
    store.markDispatched('cmd-5', 1, '2026-04-23T00:00:01.000Z');
    store.markExecuting('cmd-5', '2026-04-23T00:00:02.000Z');

    const emitted: CommandRecord[] = [];
    const sub = store.streamByDevice('dev-1').subscribe((record) => {
      if (record.commandId === 'cmd-5') emitted.push(record);
    });

    store.markSucceeded('cmd-5', 'ok', '2026-04-23T00:00:03.000Z');
    await new Promise((r) => setTimeout(r, 0));

    const succeeded = emitted.find((r) => r.state === 'succeeded');
    expect(succeeded).toBeDefined();
    expect(succeeded!.outcome).toBe('ok');
    sub.unsubscribe();
  });

  it('emits on markFailed', async () => {
    store.createQueuedCommand({
      id: 'row-1',
      commandId: 'cmd-6',
      deviceId: 'dev-1',
      commandType: 'request_status_snapshot',
      actorType: 'admin_session',
      actorId: 'session-1',
      submittedAt: '2026-04-23T00:00:00.000Z',
    });

    const emitted: CommandRecord[] = [];
    const sub = store.streamByDevice('dev-1').subscribe((record) => {
      if (record.commandId === 'cmd-6') emitted.push(record);
    });

    store.markFailed('cmd-6', 'timeout', null, '2026-04-23T00:00:05.000Z');
    await new Promise((r) => setTimeout(r, 0));

    const failed = emitted.find((r) => r.state === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.reasonCode).toBe('timeout');
    sub.unsubscribe();
  });

  it('does not emit on markExecuting/markSucceeded when already in terminal state', async () => {
    store.createQueuedCommand({
      id: 'row-1',
      commandId: 'cmd-7',
      deviceId: 'dev-1',
      commandType: 'request_status_snapshot',
      actorType: 'admin_session',
      actorId: 'session-1',
      submittedAt: '2026-04-23T00:00:00.000Z',
    });
    store.markFailed('cmd-7', 'timeout', null, '2026-04-23T00:00:05.000Z');

    const emitted: CommandRecord[] = [];
    const sub = store.streamByDevice('dev-1').subscribe((record) => {
      if (record.commandId === 'cmd-7') emitted.push(record);
    });

    store.markExecuting('cmd-7', '2026-04-23T00:00:06.000Z');
    store.markSucceeded('cmd-7', 'ok', '2026-04-23T00:00:07.000Z');
    await new Promise((r) => setTimeout(r, 0));

    // No new emissions — already failed
    expect(emitted).toHaveLength(0);
    sub.unsubscribe();
  });
});
