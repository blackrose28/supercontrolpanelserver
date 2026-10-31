import { randomUUID } from "node:crypto";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database.service';
import { LogStore, type TelemetryEvent } from './log.store';

const createdPaths: string[] = [];
const createdDatabases: DatabaseService[] = [];

function createStore(options?: { maxEventsPerDevice?: number }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-server-log-store-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  createdPaths.push(tempDir);

  process.env.CC_DB_PATH = dbPath;
  if (options?.maxEventsPerDevice) {
    process.env.CC_LOG_RETENTION_MAX_EVENTS_PER_DEVICE = String(options.maxEventsPerDevice);
  } else {
    delete process.env.CC_LOG_RETENTION_MAX_EVENTS_PER_DEVICE;
  }
  process.env.CC_LOG_RETENTION_MAX_AGE_DAYS = '365';

  const database = new DatabaseService();
  createdDatabases.push(database);
  const store = new LogStore(database);
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

function appendEvents(
  store: LogStore,
  database: DatabaseService,
  deviceId: string,
  events: Array<Partial<TelemetryEvent>>,
) {
  ensureDevice(database, deviceId);
  events.forEach((event, index) => {
    store.append({
      id: event.id || `event-${index}`,
      deviceId,
      type: event.type || 'recent_logs',
      seq: typeof event.seq === 'number' ? event.seq : index + 1,
      ts: event.ts || `2026-04-22T00:00:0${index}.000Z`,
      payload: event.payload ?? { index },
      functionId: event.functionId ?? null,
      sessionId: event.sessionId ?? null,
    });
  });
}

afterEach(() => {
  delete process.env.CC_DB_PATH;
  delete process.env.CC_LOG_RETENTION_MAX_EVENTS_PER_DEVICE;
  delete process.env.CC_LOG_RETENTION_MAX_AGE_DAYS;

  while (createdDatabases.length) {
    createdDatabases.pop()?.connection.close();
  }

  while (createdPaths.length) {
    const target = createdPaths.pop();
    if (target) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
});

describe('LogStore ordering and retention', () => {
  it('lists device logs by newest timestamp even when seq resets lower', () => {
    const { store, database } = createStore();
    appendEvents(store, database, 'dev-1', [
      { id: 'old-high-seq', seq: 900, ts: '2026-04-22T09:12:59.000Z', type: 'recent_logs' },
      { id: 'newer-low-seq', seq: 10, ts: '2026-04-23T03:33:36.000Z', type: 'recent_logs' },
    ]);

    const logs = store.listByDevice('dev-1', 10);

    expect(logs.map((entry) => entry.id)).toEqual(['old-high-seq', 'newer-low-seq']);
    expect(logs.at(-1)?.ts).toBe('2026-04-23T03:33:36.000Z');
  });

  it('lists telemetry across devices by newest timestamp even when seq resets lower', () => {
    const { store, database } = createStore();
    appendEvents(store, database, 'dev-1', [
      { id: 'old-high-seq', seq: 900, ts: '2026-04-22T09:12:59.000Z', type: 'recent_logs' },
      { id: 'newer-low-seq', seq: 10, ts: '2026-04-23T03:33:36.000Z', type: 'recent_logs' },
    ]);

    const logs = store.listAll(10, { deviceId: 'dev-1' });

    expect(logs.map((entry) => entry.id)).toEqual(['old-high-seq', 'newer-low-seq']);
    expect(logs.at(-1)?.ts).toBe('2026-04-23T03:33:36.000Z');
  });

  it('retains the newest timestamps for a device when seq resets lower', () => {
    const { store, database } = createStore({ maxEventsPerDevice: 2 });
    appendEvents(store, database, 'dev-1', [
      { id: 'older-1', seq: 1000, ts: '2026-04-22T09:12:59.000Z', type: 'inventory' },
      { id: 'older-2', seq: 999, ts: '2026-04-22T09:13:59.000Z', type: 'recent_logs' },
      { id: 'newer-1', seq: 10, ts: '2026-04-23T03:33:23.000Z', type: 'recent_logs' },
      { id: 'newer-2', seq: 11, ts: '2026-04-23T03:33:36.000Z', type: 'status_snapshot' },
    ]);

    const logs = store.listByDevice('dev-1', 10);

    expect(logs.map((entry) => entry.id)).toEqual(['newer-1', 'newer-2']);
  });

  it('lists PTY output logs for a specific session only', () => {
    const { store, database } = createStore();
    appendEvents(store, database, 'dev-1', [
      {
        id: 'pty-a-1',
        type: 'pty-output',
        sessionId: 'sess-a',
        ts: '2026-04-23T03:33:23.000Z',
        payload: { data: 'first line' },
      },
      {
        id: 'pty-b-1',
        type: 'pty-output',
        sessionId: 'sess-b',
        ts: '2026-04-23T03:33:24.000Z',
        payload: { data: 'other line' },
      },
      {
        id: 'pty-a-2',
        type: 'pty-output',
        sessionId: 'sess-a',
        ts: '2026-04-23T03:33:25.000Z',
        payload: { data: 'second line' },
      },
    ]);

    const logs = store.listPtyOutputBySession('dev-1', 'sess-a', 10);

    expect(logs.map((entry) => entry.id)).toEqual(['pty-a-1', 'pty-a-2']);
    expect(logs.every((entry) => entry.type === 'pty-output')).toBe(true);
    expect(logs.every((entry) => entry.sessionId === 'sess-a')).toBe(true);
  });
});

describe('Runtime summary from status_snapshot', () => {
  it('populates runtime summary function states from status_snapshot payload', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    store.append({
      id: 'snap-1',
      deviceId: 'dev-1',
      type: 'status_snapshot',
      sessionId: null,
      functionId: null,
      seq: 100,
      ts: '2026-04-23T10:00:00.000Z',
      payload: {
        activeSessions: [],
        lastSeqByStream: {},
        functionStates: [
          {
            functionId: 'server-tunnel-srv1',
            state: 'running',
            message: 'Tunnel active',
            sessionId: 'pty-abc123',
            updatedAtMs: 1714000000000,
          },
          {
            functionId: 'openvpn-connect',
            state: 'idle',
            message: 'Ready',
            sessionId: null,
            updatedAtMs: 1714000000001,
          },
        ],
      },
    });

    const summary = store.getDeviceRuntimeSummary('dev-1');

    expect(summary.functions['server-tunnel-srv1']).toBeDefined();
    expect(summary.functions['server-tunnel-srv1'].state).toBe('running');
    expect(summary.functions['server-tunnel-srv1'].message).toBe('Tunnel active');
    expect(summary.functions['server-tunnel-srv1'].sessionId).toBe('pty-abc123');
    expect(summary.functions['server-tunnel-srv1'].updatedAtMs).toBe(1714000000000);

    expect(summary.functions['openvpn-connect']).toBeDefined();
    expect(summary.functions['openvpn-connect'].state).toBe('idle');
    expect(summary.functions['openvpn-connect'].sessionId).toBeNull();
  });

  it('replaces existing function states with snapshot data on reconnect', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    // First, establish some function states via regular function-status events
    store.append({
      id: 'fs-1',
      deviceId: 'dev-1',
      type: 'function-status',
      sessionId: 'pty-old',
      functionId: 'server-tunnel-srv1',
      seq: 1,
      ts: '2026-04-23T09:00:00.000Z',
      payload: {
        functionId: 'server-tunnel-srv1',
        state: 'running',
        message: 'Old state',
        sessionId: 'pty-old',
      },
    });

    let summary = store.getDeviceRuntimeSummary('dev-1');
    expect(summary.functions['server-tunnel-srv1']?.sessionId).toBe('pty-old');

    // Now a reconnect happens and a status_snapshot comes in with updated states
    store.append({
      id: 'snap-2',
      deviceId: 'dev-1',
      type: 'status_snapshot',
      sessionId: null,
      functionId: null,
      seq: 100,
      ts: '2026-04-23T10:00:00.000Z',
      payload: {
        activeSessions: [],
        lastSeqByStream: {},
        functionStates: [
          {
            functionId: 'server-tunnel-srv1',
            state: 'running',
            message: 'Tunnel active (reconnected)',
            sessionId: 'pty-new-abc',
            updatedAtMs: 1714000099999,
          },
        ],
      },
    });

    summary = store.getDeviceRuntimeSummary('dev-1');
    expect(summary.functions['server-tunnel-srv1']?.sessionId).toBe('pty-new-abc');
    expect(summary.functions['server-tunnel-srv1']?.message).toBe('Tunnel active (reconnected)');
    expect(summary.updatedAt).toBe('2026-04-23T10:00:00.000Z');
  });
});


  it('clears stale function states not present in a new status_snapshot', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    // Device previously had a tunnel running
    store.append({
      id: 'fs-1',
      deviceId: 'dev-1',
      type: 'function-status',
      sessionId: 'pty-old',
      functionId: 'server-tunnel-srv1',
      seq: 1,
      ts: '2026-04-23T09:00:00.000Z',
      payload: {
        functionId: 'server-tunnel-srv1',
        state: 'running',
        message: 'Tunnel active',
        sessionId: 'pty-old',
      },
    });

    store.append({
      id: 'fs-2',
      deviceId: 'dev-1',
      type: 'function-status',
      sessionId: null,
      functionId: 'openvpn-connect',
      seq: 2,
      ts: '2026-04-23T09:01:00.000Z',
      payload: {
        functionId: 'openvpn-connect',
        state: 'idle',
        message: 'Ready',
      },
    });

    let summary = store.getDeviceRuntimeSummary('dev-1');
    expect(summary.functions['server-tunnel-srv1']).toBeDefined();
    expect(summary.functions['openvpn-connect']).toBeDefined();

    // Device reconnects — tunnel no longer exists, only openvpn in snapshot
    store.append({
      id: 'snap-3',
      deviceId: 'dev-1',
      type: 'status_snapshot',
      sessionId: null,
      functionId: null,
      seq: 100,
      ts: '2026-04-23T10:00:00.000Z',
      payload: {
        activeSessions: [],
        lastSeqByStream: {},
        functionStates: [
          {
            functionId: 'openvpn-connect',
            state: 'idle',
            message: 'Ready',
            sessionId: null,
            updatedAtMs: 1714000000001,
          },
        ],
      },
    });

    summary = store.getDeviceRuntimeSummary('dev-1');
    // Tunnel function state should be removed — it was not in the new snapshot
    expect(summary.functions['server-tunnel-srv1']).toBeUndefined();
    // OpenVPN should still be present
    expect(summary.functions['openvpn-connect']).toBeDefined();
    expect(summary.functions['openvpn-connect'].state).toBe('idle');
  });
describe('Runtime summary from function-status events', () => {
  it('stores sessionId from function-status payload into runtime summary', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    store.append({
      id: 'fs-tunnel',
      deviceId: 'dev-1',
      type: 'function-status',
      sessionId: 'pty-session-123',
      functionId: 'server-tunnel-srv-abc',
      seq: 50,
      ts: '2026-04-23T12:00:00.000Z',
      payload: {
        functionId: 'server-tunnel-srv-abc',
        state: 'running',
        message: 'Tunnel active',
        sessionId: 'pty-session-123',
        updatedAtMs: 1714000000000,
      },
    });

    const summary = store.getDeviceRuntimeSummary('dev-1');
    expect(summary.functions['server-tunnel-srv-abc']).toBeDefined();
    expect(summary.functions['server-tunnel-srv-abc'].state).toBe('running');
    expect(summary.functions['server-tunnel-srv-abc'].sessionId).toBe('pty-session-123');
  });

  it('prefers top-level sessionId over payload.sessionId for function-status', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    store.append({
      id: 'fs-canonical',
      deviceId: 'dev-1',
      type: 'function-status',
      sessionId: 'ccpty:dev-1:local-pty-1',
      functionId: 'server-ssh-srv-1',
      seq: 51,
      ts: '2026-04-23T12:01:00.000Z',
      payload: {
        functionId: 'server-ssh-srv-1',
        state: 'running',
        message: 'SSH',
        sessionId: 'legacy-local-only',
        updatedAtMs: 1714000000001,
      },
    });

    const summary = store.getDeviceRuntimeSummary('dev-1');
    expect(summary.functions['server-ssh-srv-1']?.sessionId).toBe('ccpty:dev-1:local-pty-1');
  });
});

describe('Tunnel logs integration', () => {
  it('end-to-end: function-status provides sessionId, pty-output events are queryable', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    // Simulate function-status event arriving from telemetry
    store.append({
      id: 'fs-1',
      deviceId: 'dev-1',
      type: 'function-status',
      sessionId: 'pty-tunnel-session-99',
      functionId: 'server-tunnel-srv-abc',
      seq: 50,
      ts: '2026-04-23T12:00:00.000Z',
      payload: {
        functionId: 'server-tunnel-srv-abc',
        state: 'running',
        message: 'Tunnel active',
        sessionId: 'pty-tunnel-session-99',
        updatedAtMs: 1714000000000,
      },
    });

    // Simulate pty-output events arriving from telemetry
    store.append({
      id: 'pty-1',
      deviceId: 'dev-1',
      type: 'pty-output',
      sessionId: 'pty-tunnel-session-99',
      functionId: null,
      seq: 51,
      ts: '2026-04-23T12:00:01.000Z',
      payload: { id: 'pty-tunnel-session-99', data: 'Starting boundary connect...\r\n' },
    });
    store.append({
      id: 'pty-2',
      deviceId: 'dev-1',
      type: 'pty-output',
      sessionId: 'pty-tunnel-session-99',
      functionId: null,
      seq: 52,
      ts: '2026-04-23T12:00:02.000Z',
      payload: { id: 'pty-tunnel-session-99', data: 'Tunnel established on port 6222\r\n' },
    });

    // Now simulate what the tunnelLogs endpoint does
    const summary = store.getDeviceRuntimeSummary('dev-1');
    const functionId = 'server-tunnel-srv-abc';
    const sessionId = summary.functions?.[functionId]?.sessionId;

    expect(sessionId).toBe('pty-tunnel-session-99');

    const logs = store.listPtyOutputBySession('dev-1', sessionId!, 200);
    expect(logs.length).toBe(2);
    expect(logs[0].payload).toBeDefined();
    const payload0 = logs[0].payload as Record<string, unknown>;
    expect(payload0.data).toBe('Starting boundary connect...\r\n');
    const payload1 = logs[1].payload as Record<string, unknown>;
    expect(payload1.data).toBe('Tunnel established on port 6222\r\n');
  });
});

describe('Redaction preserves sessionId in function-status payloads', () => {
  it('sessionId survives redaction when function-status is appended', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    // Simulate a function-status event with token-like content in message
    // to test that sessionId is NOT affected by redaction
    store.append({
      id: 'fs-redact-test',
      deviceId: 'dev-1',
      type: 'function-status',
      sessionId: 'pty-session-xyz',
      functionId: 'server-tunnel-srv-token-test',
      seq: 60,
      ts: '2026-04-23T13:00:00.000Z',
      payload: {
        functionId: 'server-tunnel-srv-token-test',
        state: 'running',
        message: 'Bearer at_abc123def456 token established',
        sessionId: 'pty-session-xyz',
        updatedAtMs: 1714000000000,
      },
    });

    const summary = store.getDeviceRuntimeSummary('dev-1');
    // sessionId should NOT be redacted
    expect(summary.functions['server-tunnel-srv-token-test']?.sessionId).toBe('pty-session-xyz');
    // message should be redacted
    expect(summary.functions['server-tunnel-srv-token-test']?.message).toContain('[redacted]');
  });
});

describe('Telemetry ingest format for tunnel events', () => {
  it('function-status from telemetry ingest correctly updates runtime summary with sessionId', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    // Simulate exactly what the ingest controller does when it receives a function-status
    // from the telemetry HTTP POST. The telemetry body wraps the FunctionStatus.
    const telemetryEvent = {
      type: 'function-status',
      sessionId: 'pty-session-from-telemetry',
      functionId: 'server-tunnel-srv-telemetry-test',
      seq: 100,
      ts: '2026-04-23T14:00:00.000Z',
      payload: {
        functionId: 'server-tunnel-srv-telemetry-test',
        state: 'running',
        message: 'Tunnel active',
        boundaryTokenSource: null,
        sessionId: 'pty-session-from-telemetry',
        updatedAtMs: 1714000000000,
      },
    };

    store.append({
      id: 'ingest-fs-1',
      deviceId: 'dev-1',
      type: telemetryEvent.type,
      sessionId: telemetryEvent.sessionId ?? null,
      functionId: telemetryEvent.functionId ?? null,
      seq: telemetryEvent.seq,
      ts: telemetryEvent.ts,
      payload: telemetryEvent.payload,
    });

    const summary = store.getDeviceRuntimeSummary('dev-1');
    expect(summary.functions['server-tunnel-srv-telemetry-test']).toBeDefined();
    expect(summary.functions['server-tunnel-srv-telemetry-test'].sessionId).toBe('pty-session-from-telemetry');
  });

  it('pty-output from telemetry ingest is stored and queryable by sessionId', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    // Simulate pty-output from telemetry HTTP POST
    store.append({
      id: 'ingest-pty-1',
      deviceId: 'dev-1',
      type: 'pty-output',
      sessionId: 'pty-session-from-telemetry',
      functionId: null,
      seq: 101,
      ts: '2026-04-23T14:00:01.000Z',
      payload: { id: 'pty-session-from-telemetry', data: 'boundary connect output\r\n' },
    });

    const logs = store.listPtyOutputBySession('dev-1', 'pty-session-from-telemetry', 200);
    expect(logs.length).toBe(1);
    const payload = logs[0].payload as Record<string, unknown>;
    expect(payload.data).toBe('boundary connect output\r\n');
  });
});

describe('Recent logs expansion into individual events', () => {
  it('function-status events inside recent_logs must be expanded to update runtime summary', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    // Simulate recent_logs containing a function-status event
    const recentLogsPayload = {
      count: 1,
      events: [
        {
          type: 'function-status',
          sessionId: 'pty-session-recent',
          functionId: 'server-tunnel-srv-recent',
          seq: 200,
          ts: '2026-04-23T15:00:00.000Z',
          payload: {
            functionId: 'server-tunnel-srv-recent',
            state: 'running',
            message: 'Tunnel active',
            sessionId: 'pty-session-recent',
            updatedAtMs: 1714000000000,
          },
        },
      ],
    };

    // handleAgentRecentLogs expands events: store the blob AND individual events
    store.append({
      id: 'recent-logs-blob',
      deviceId: 'dev-1',
      type: 'recent_logs',
      sessionId: null,
      functionId: null,
      seq: 300,
      ts: '2026-04-23T15:00:01.000Z',
      payload: recentLogsPayload,
    });

    const events = Array.isArray(recentLogsPayload.events) ? recentLogsPayload.events : [];
    for (const evt of events) {
      store.append({
        id: randomUUID(),
        deviceId: 'dev-1',
        type: evt.type ?? 'unknown',
        sessionId: evt.sessionId ?? null,
        functionId: evt.functionId ?? null,
        seq: typeof evt.seq === 'number' ? evt.seq : Date.now(),
        ts: evt.ts || new Date().toISOString(),
        payload: evt.payload ?? null,
      });
    }

    const summary = store.getDeviceRuntimeSummary('dev-1');
    expect(summary.functions['server-tunnel-srv-recent']?.sessionId).toBe('pty-session-recent');
  });

  it('pty-output events inside recent_logs should be queryable by sessionId', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    // Simulate recent_logs containing pty-output events
    const recentLogsPayload = {
      count: 2,
      events: [
        {
          type: 'function-status',
          sessionId: 'pty-session-recent-pty',
          functionId: 'server-tunnel-srv-recent-pty',
          seq: 200,
          ts: '2026-04-23T15:00:00.000Z',
          payload: {
            functionId: 'server-tunnel-srv-recent-pty',
            state: 'running',
            message: 'Tunnel active',
            sessionId: 'pty-session-recent-pty',
            updatedAtMs: 1714000000000,
          },
        },
        {
          type: 'pty-output',
          sessionId: 'pty-session-recent-pty',
          functionId: null,
          seq: 201,
          ts: '2026-04-23T15:00:01.000Z',
          payload: { id: 'pty-session-recent-pty', data: 'boundary output line\r\n' },
        },
      ],
    };

    // Expand recent_logs events into individual rows
    const events = Array.isArray(recentLogsPayload.events) ? recentLogsPayload.events : [];
    for (const event of events) {
      store.append({
        id: randomUUID(),
        deviceId: 'dev-1',
        type: event.type ?? 'unknown',
        sessionId: event.sessionId ?? null,
        functionId: event.functionId ?? null,
        seq: typeof event.seq === 'number' ? event.seq : Date.now(),
        ts: event.ts || new Date().toISOString(),
        payload: event.payload ?? null,
      });
    }

    const summary = store.getDeviceRuntimeSummary('dev-1');
    const sessionId = summary.functions['server-tunnel-srv-recent-pty']?.sessionId;
    expect(sessionId).toBe('pty-session-recent-pty');

    const logs = store.listPtyOutputBySession('dev-1', sessionId!, 200);
    expect(logs.length).toBe(1);
    const payload = logs[0].payload as Record<string, unknown>;
    expect(payload.data).toBe('boundary output line\r\n');
  });
});

describe('Tunnel logs when sessionId was cleared after exit', () => {
  it('endpoint can find logs using last known sessionId from recent function-status events', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    // Tunnel started: function-status with sessionId
    store.append({
      id: 'fs-running',
      deviceId: 'dev-1',
      type: 'function-status',
      sessionId: 'pty-crashed',
      functionId: 'server-tunnel-srv-crash',
      seq: 1,
      ts: '2026-04-23T16:00:00.000Z',
      payload: {
        functionId: 'server-tunnel-srv-crash',
        state: 'running',
        sessionId: 'pty-crashed',
        updatedAtMs: 1000,
      },
    });

    // PTY output events
    store.append({
      id: 'pty-out-1',
      deviceId: 'dev-1',
      type: 'pty-output',
      sessionId: 'pty-crashed',
      functionId: null,
      seq: 2,
      ts: '2026-04-23T16:00:01.000Z',
      payload: { id: 'pty-crashed', data: 'Starting tunnel...\r\n' },
    });
    store.append({
      id: 'pty-out-2',
      deviceId: 'dev-1',
      type: 'pty-output',
      sessionId: 'pty-crashed',
      functionId: null,
      seq: 3,
      ts: '2026-04-23T16:00:02.000Z',
      payload: { id: 'pty-crashed', data: 'Error: connection refused\r\n' },
    });

    // PTY exits: function-status with sessionId=null (current behavior)
    store.append({
      id: 'fs-exited',
      deviceId: 'dev-1',
      type: 'function-status',
      sessionId: null,
      functionId: 'server-tunnel-srv-crash',
      seq: 4,
      ts: '2026-04-23T16:00:03.000Z',
      payload: {
        functionId: 'server-tunnel-srv-crash',
        state: 'error',
        message: 'PTY exited (code=1)',
        sessionId: null,
        updatedAtMs: 2000,
      },
    });

    // Current behavior: runtime summary has sessionId=null
    const summary = store.getDeviceRuntimeSummary('dev-1');
    expect(summary.functions['server-tunnel-srv-crash']?.sessionId).toBeNull();

    // The endpoint should still be able to find logs by looking up the last known sessionId
    const lastSessionId = store.getLastSessionIdForFunction('dev-1', 'server-tunnel-srv-crash');
    expect(lastSessionId).toBe('pty-crashed');

    const logs = store.listPtyOutputBySession('dev-1', lastSessionId!, 200);
    expect(logs.length).toBe(2);
  });
});

describe('Tunnel logs pagination', () => {
  it('countPtyOutputBySession returns total count for a session', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    for (let i = 0; i < 25; i++) {
      store.append({
        id: `pty-page-${i}`,
        deviceId: 'dev-1',
        type: 'pty-output',
        sessionId: 'pty-page-test',
        functionId: null,
        seq: i,
        ts: `2026-04-23T17:00:${String(i).padStart(2, '0')}.000Z`,
        payload: { id: 'pty-page-test', data: `line ${i}\r\n` },
      });
    }

    expect(store.countPtyOutputBySession('dev-1', 'pty-page-test')).toBe(25);
    expect(store.countPtyOutputBySession('dev-1', 'nonexistent')).toBe(0);
  });

  it('listPtyOutputBySession supports offset for pagination', () => {
    const { store, database } = createStore();
    ensureDevice(database, 'dev-1');

    for (let i = 0; i < 25; i++) {
      store.append({
        id: `pty-off-${i}`,
        deviceId: 'dev-1',
        type: 'pty-output',
        sessionId: 'pty-offset-test',
        functionId: null,
        seq: i,
        ts: `2026-04-23T17:01:${String(i).padStart(2, '0')}.000Z`,
        payload: { id: 'pty-offset-test', data: `line ${i}\r\n` },
      });
    }

    // Query sorts DESC by ts then reversed to chronological.
    // Page 1 (offset=0, limit=10): most recent 10 items = lines 15..24
    const page1 = store.listPtyOutputBySession('dev-1', 'pty-offset-test', 10, 0);
    expect(page1.length).toBe(10);
    const p1first = page1[0].payload as Record<string, unknown>;
    expect(p1first.data).toBe('line 15\r\n');
    const p1last = page1[9].payload as Record<string, unknown>;
    expect(p1last.data).toBe('line 24\r\n');

    // Page 2 (offset=10, limit=10): lines 5..14
    const page2 = store.listPtyOutputBySession('dev-1', 'pty-offset-test', 10, 10);
    expect(page2.length).toBe(10);
    const p2first = page2[0].payload as Record<string, unknown>;
    expect(p2first.data).toBe('line 5\r\n');

    // Page 3 (offset=20, limit=10): lines 0..4
    const page3 = store.listPtyOutputBySession('dev-1', 'pty-offset-test', 10, 20);
    expect(page3.length).toBe(5);
    const p3first = page3[0].payload as Record<string, unknown>;
    expect(p3first.data).toBe('line 0\r\n');

    // Empty page: offset past the end
    const page4 = store.listPtyOutputBySession('dev-1', 'pty-offset-test', 10, 25);
    expect(page4.length).toBe(0);
  });
});
