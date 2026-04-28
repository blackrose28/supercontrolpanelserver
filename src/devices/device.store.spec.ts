import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service';
import { DeviceStore } from './device.store';

const createdPaths: string[] = [];

function createStore() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-server-device-store-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  createdPaths.push(tempDir);
  process.env.CC_DB_PATH = dbPath;
  const database = new DatabaseService();
  const store = new DeviceStore(database);
  return { database, store };
}

afterEach(() => {
  delete process.env.CC_DB_PATH;
  while (createdPaths.length) {
    const target = createdPaths.pop();
    if (target) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
});

describe('DeviceStore status change events', () => {
  it('emits a device-connected event via the status change stream when a session is added', () => {
    const { store } = createStore();
    const events: Array<{ deviceId: string; status: string }> = [];
    const sub = store.statusChangeStream().subscribe((event) => events.push(event));

    const device = store.addDevice({
      id: 'dev-1',
      name: 'Device One',
      lastSeenAt: new Date().toISOString(),
      status: 'disconnected',
      agentToken: 'token-abc',
    });

    store.addSession({ id: 'sess-1', deviceId: device.id, connectedAt: new Date().toISOString() });

    expect(events.length).toBe(1);
    expect(events[0].deviceId).toBe('dev-1');
    expect(events[0].status).toBe('connected');

    sub.unsubscribe();
  });

  it('emits a device-disconnected event via the status change stream when a session is removed', () => {
    const { store } = createStore();
    const events: Array<{ deviceId: string; status: string }> = [];
    const sub = store.statusChangeStream().subscribe((event) => events.push(event));

    const device = store.addDevice({
      id: 'dev-2',
      name: 'Device Two',
      lastSeenAt: new Date().toISOString(),
      status: 'disconnected',
      agentToken: 'token-xyz',
    });

    store.addSession({ id: 'sess-2', deviceId: device.id, connectedAt: new Date().toISOString() });
    store.removeSession('sess-2');

    expect(events.length).toBe(2);
    expect(events[0].status).toBe('connected');
    expect(events[1].deviceId).toBe('dev-2');
    expect(events[1].status).toBe('disconnected');

    sub.unsubscribe();
  });

  it('does not emit duplicate connected events when device is already connected', () => {
    const { store } = createStore();
    const events: Array<{ deviceId: string; status: string }> = [];
    const sub = store.statusChangeStream().subscribe((event) => events.push(event));

    const device = store.addDevice({
      id: 'dev-3',
      name: 'Device Three',
      lastSeenAt: new Date().toISOString(),
      status: 'disconnected',
      agentToken: 'token-dup',
    });

    // First session: should emit connected
    store.addSession({ id: 'sess-3a', deviceId: device.id, connectedAt: new Date().toISOString() });
    expect(events.length).toBe(1);
    expect(events[0].status).toBe('connected');

    // AddSession replaces old session, should not emit duplicate connected
    store.addSession({ id: 'sess-3b', deviceId: device.id, connectedAt: new Date().toISOString() });
    expect(events.length).toBe(1);

    sub.unsubscribe();
  });
});
