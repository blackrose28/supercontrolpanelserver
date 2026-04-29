import { normalizeStoredSecret } from './worker-secrets';

export type WorkerDeviceStatus = 'connected' | 'disconnected';

export interface WorkerDevice {
  id: string;
  name: string;
  lastSeenAt: string;
  status: WorkerDeviceStatus;
  agentToken?: string;
  os?: string;
}

type D1Result<T> = { results?: T[] };

type D1PreparedStatement = {
  bind: (...values: unknown[]) => D1PreparedStatement;
  run: () => Promise<unknown>;
  first: <T = unknown>() => Promise<T | null>;
  all: <T = unknown>() => Promise<D1Result<T>>;
};

export type D1LikeDatabase = {
  prepare: (sql: string) => D1PreparedStatement;
};

function mapDeviceRow(row: WorkerDevice | null | undefined): WorkerDevice | undefined {
  if (!row) {
    return undefined;
  }

  return {
    id: row.id,
    name: row.name,
    lastSeenAt: row.lastSeenAt,
    status: row.status,
    agentToken: row.agentToken,
    os: row.os ?? undefined,
  };
}

export class D1DeviceStore {
  constructor(private readonly db: D1LikeDatabase) {}

  async addDevice(device: WorkerDevice): Promise<WorkerDevice> {
    const normalized: WorkerDevice = {
      ...device,
      agentToken: await normalizeStoredSecret(device.agentToken),
      os: device.os ?? undefined,
    };

    await this.db
      .prepare(
        `
          INSERT INTO devices (id, name, lastSeenAt, status, agentToken, os)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            lastSeenAt = excluded.lastSeenAt,
            status = excluded.status,
            agentToken = excluded.agentToken,
            os = excluded.os
        `,
      )
      .bind(
        normalized.id,
        normalized.name,
        normalized.lastSeenAt,
        normalized.status,
        normalized.agentToken ?? '',
        normalized.os ?? null,
      )
      .run();

    return normalized;
  }

  async getDevice(id: string): Promise<WorkerDevice | undefined> {
    const row = await this.db
      .prepare(
        `
          SELECT id, name, lastSeenAt, status, agentToken, os
          FROM devices
          WHERE id = ?
        `,
      )
      .bind(id)
      .first<WorkerDevice>();

    return mapDeviceRow(row);
  }

  async getAllDevices(): Promise<WorkerDevice[]> {
    const { results = [] } = await this.db
      .prepare(
        `
          SELECT id, name, lastSeenAt, status, agentToken, os
          FROM devices
          ORDER BY lastSeenAt DESC, id DESC
        `,
      )
      .all<WorkerDevice>();

    return results.map((row) => mapDeviceRow(row)).filter((row): row is WorkerDevice => Boolean(row));
  }

  async findDeviceByAgentToken(token: string): Promise<WorkerDevice | undefined> {
    const normalized = await normalizeStoredSecret(token);
    const row = await this.db
      .prepare(
        `
          SELECT id, name, lastSeenAt, status, agentToken, os
          FROM devices
          WHERE agentToken = ?
        `,
      )
      .bind(normalized)
      .first<WorkerDevice>();

    return mapDeviceRow(row);
  }

  async updateDeviceStatus(id: string, status: WorkerDeviceStatus, lastSeenAt = new Date().toISOString()): Promise<WorkerDevice | undefined> {
    await this.db
      .prepare(
        `
          UPDATE devices
          SET status = ?, lastSeenAt = ?
          WHERE id = ?
        `,
      )
      .bind(status, lastSeenAt, id)
      .run();

    return this.getDevice(id);
  }

  async updateDeviceOs(id: string, os: string): Promise<WorkerDevice | undefined> {
    await this.db
      .prepare(
        `
          UPDATE devices
          SET os = ?
          WHERE id = ?
        `,
      )
      .bind(os, id)
      .run();

    return this.getDevice(id);
  }

  async removeDevice(id: string): Promise<boolean> {
    const existing = await this.getDevice(id);
    if (!existing) {
      return false;
    }

    const statements = [
      `DELETE FROM command_audit WHERE commandId IN (SELECT commandId FROM commands WHERE deviceId = ?)`,
      `DELETE FROM commands WHERE deviceId = ?`,
      `DELETE FROM pty_audit WHERE deviceId = ?`,
      `DELETE FROM pty_sessions WHERE deviceId = ?`,
      `DELETE FROM telemetry_logs WHERE deviceId = ?`,
      `DELETE FROM device_runtime_state WHERE deviceId = ?`,
      `DELETE FROM file_transfers WHERE deviceId = ?`,
      `DELETE FROM remote_browser_sessions WHERE deviceId = ?`,
      `DELETE FROM devices WHERE id = ?`,
    ];

    for (const sql of statements) {
      await this.db.prepare(sql).bind(id).run();
    }

    return true;
  }
}
