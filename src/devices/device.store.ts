import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { normalizeStoredSecret } from '../config/secrets';

export interface Device {
  id: string;
  name: string;
  lastSeenAt: string;
  status: 'connected' | 'disconnected';
  agentToken?: string;
  os?: string;
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
    console.log('[DEVICE_STORE] Looking up device by token');
    console.log('[DEVICE_STORE] Input token:', token.substring(0, 8) + '...');
    console.log('[DEVICE_STORE] Normalized token:', normalized.substring(0, 15) + '...');
    console.log('[DEVICE_STORE] Total devices in store:', this.devices.size);

    const device = Array.from(this.devices.values()).find(
      (device) => device.agentToken === normalized,
    );

    if (device) {
      console.log('[DEVICE_STORE] Device found:', device.id, device.name);
    } else {
      console.log('[DEVICE_STORE] Device NOT found');
      console.log('[DEVICE_STORE] Available device tokens:');
      Array.from(this.devices.values()).forEach(d => {
        console.log('  -', d.id, d.name, 'token:', d.agentToken?.substring(0, 15) + '...');
      });
    }

    return device;
  }

  updateDeviceStatus(id: string, status: 'connected' | 'disconnected'): void {
    const device = this.devices.get(id);
    if (device) {
      device.status = status;
      device.lastSeenAt = new Date().toISOString();
      this.persistDevice(device);
    }
  }

  updateDeviceOs(id: string, os: string): void {
    const device = this.devices.get(id);
    if (device && device.os !== os) {
      device.os = os;
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
    console.log('[DEVICE_STORE] Loading devices from database...');
    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT id, name, lastSeenAt, status, agentToken, os
          FROM devices
          ORDER BY lastSeenAt DESC, id DESC
        `,
      )
      .all() as Device[];

    console.log('[DEVICE_STORE] Found', rows.length, 'devices in database');

    for (const row of rows) {
      const device: Device = {
        id: row.id,
        name: row.name,
        lastSeenAt: row.lastSeenAt,
        status: 'disconnected',
        agentToken: normalizeStoredSecret(row.agentToken),
        os: row.os ?? undefined,
      };
      console.log('[DEVICE_STORE] Loading device:', device.id, device.name, 'token:', device.agentToken?.substring(0, 15) + '...');
      this.devices.set(device.id, device);
      if (device.agentToken !== row.agentToken) {
        console.log('[DEVICE_STORE] Token was normalized, persisting back to DB');
        this.persistDevice(device);
      }
    }

    if (rows.length) {
      this.databaseService.connection
        .prepare(`UPDATE devices SET status = 'disconnected'`)
        .run();
    }

    console.log('[DEVICE_STORE] Device loading complete. Total devices in memory:', this.devices.size);
  }

  private persistDevice(device: Device) {
    this.databaseService.connection
      .prepare(
        `
          INSERT INTO devices (id, name, lastSeenAt, status, agentToken, os)
          VALUES (@id, @name, @lastSeenAt, @status, @agentToken, @os)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            lastSeenAt = excluded.lastSeenAt,
            status = excluded.status,
            agentToken = excluded.agentToken,
            os = excluded.os
        `,
      )
      .run({
        id: device.id,
        name: device.name,
        lastSeenAt: device.lastSeenAt,
        status: device.status,
        agentToken: normalizeStoredSecret(device.agentToken),
        os: device.os ?? null,
      });
  }
}
