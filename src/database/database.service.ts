import { Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

@Injectable()
export class DatabaseService {
  private readonly db: Database;

  constructor() {
    const configuredPath = process.env.CC_DB_PATH?.trim();
    const dbPath = configuredPath
      ? path.resolve(configuredPath)
      : path.resolve(process.cwd(), 'data', 'cc-server.sqlite');

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initialize();
  }

  get connection(): Database {
    return this.db;
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lastSeenAt TEXT NOT NULL,
        status TEXT NOT NULL,
        agentToken TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry_logs (
        id TEXT PRIMARY KEY,
        deviceId TEXT NOT NULL,
        type TEXT NOT NULL,
        sessionId TEXT,
        functionId TEXT,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        payloadJson TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (deviceId) REFERENCES devices(id)
      );

      CREATE TABLE IF NOT EXISTS device_runtime_state (
        deviceId TEXT PRIMARY KEY,
        summaryJson TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        FOREIGN KEY (deviceId) REFERENCES devices(id)
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        expiresAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_devices_agent_token
        ON devices(agentToken);

      CREATE INDEX IF NOT EXISTS idx_telemetry_logs_device_seq
        ON telemetry_logs(deviceId, seq);

      CREATE INDEX IF NOT EXISTS idx_telemetry_logs_device_ts
        ON telemetry_logs(deviceId, ts);
    `);
  }
}
