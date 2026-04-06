import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { normalizeStoredSecret } from '../config/secrets';

export interface Device {
  id: string;
  name: string;
  lastSeenAt: string;
  status: 'connected' | 'disconnected';
  agentToken?: string;
}

export interface Session {
  id: string;
  deviceId: string;
  connectedAt: string;
  ws?: any;
}

@Injectable()
export class DeviceStore {
  private devices = new Map<string, Device>();
  private sessions = new Map<string, Session>();
  private deviceToSession = new Map<string, string>();

  constructor(private readonly databaseService: DatabaseService) {
    this.loadDevicesFromDb();
  }

  addDevice(device: Device): Device {
    const normalized: Device = {
      ...device,
      agentToken: normalizeStoredSecret(device.agentToken),
    };
    this.devices.set(normalized.id, normalized);
    this.persistDevice(normalized);
    return normalized;
  }

  getDevice(id: string): Device | undefined {
    return this.devices.get(id);
  }

  getAllDevices(): Device[] {
    return Array.from(this.devices.values());
  }

  findDeviceByAgentToken(token: string): Device | undefined {
    const normalized = normalizeStoredSecret(token);
    return Array.from(this.devices.values()).find(
      (device) => device.agentToken === normalized,
    );
  }

  updateDeviceStatus(id: string, status: 'connected' | 'disconnected'): void {
    const device = this.devices.get(id);
    if (device) {
      device.status = status;
      device.lastSeenAt = new Date().toISOString();
      this.persistDevice(device);
    }
  }

  addSession(session: Session): void {
    // Evict old session for same deviceId (duplicate-connection policy)
    const oldSessionId = this.deviceToSession.get(session.deviceId);
    if (oldSessionId) {
      const oldSession = this.sessions.get(oldSessionId);
      if (oldSession?.ws) {
        oldSession.ws.close(1000, 'replaced_by_new_connection');
      }
      this.sessions.delete(oldSessionId);
    }
    
    this.sessions.set(session.id, session);
    this.deviceToSession.set(session.deviceId, session.id);
    this.updateDeviceStatus(session.deviceId, 'connected');
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.deviceToSession.delete(session.deviceId);
      this.sessions.delete(sessionId);
      this.updateDeviceStatus(session.deviceId, 'disconnected');
    }
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionByDeviceId(deviceId: string): Session | undefined {
    const sessionId = this.deviceToSession.get(deviceId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  private loadDevicesFromDb() {
    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT id, name, lastSeenAt, status, agentToken
          FROM devices
          ORDER BY lastSeenAt DESC, id DESC
        `,
      )
      .all() as Device[];

    for (const row of rows) {
      const device: Device = {
        id: row.id,
        name: row.name,
        lastSeenAt: row.lastSeenAt,
        status: 'disconnected',
        agentToken: normalizeStoredSecret(row.agentToken),
      };
      this.devices.set(device.id, device);
      if (device.agentToken !== row.agentToken) {
        this.persistDevice(device);
      }
    }

    if (rows.length) {
      this.databaseService.connection
        .prepare(`UPDATE devices SET status = 'disconnected'`)
        .run();
    }
  }

  private persistDevice(device: Device) {
    this.databaseService.connection
      .prepare(
        `
          INSERT INTO devices (id, name, lastSeenAt, status, agentToken)
          VALUES (@id, @name, @lastSeenAt, @status, @agentToken)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            lastSeenAt = excluded.lastSeenAt,
            status = excluded.status,
            agentToken = excluded.agentToken
        `,
      )
      .run({
        id: device.id,
        name: device.name,
        lastSeenAt: device.lastSeenAt,
        status: device.status,
        agentToken: normalizeStoredSecret(device.agentToken),
      });
  }
}
