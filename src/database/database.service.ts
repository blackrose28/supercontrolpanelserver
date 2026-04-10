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

      CREATE TABLE IF NOT EXISTS admin_api_tokens (
        tokenId TEXT PRIMARY KEY,
        tokenHash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        scopesJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        lastUsedAt INTEGER,
        revokedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        commandId TEXT NOT NULL UNIQUE,
        deviceId TEXT NOT NULL,
        commandType TEXT NOT NULL,
        state TEXT NOT NULL,
        actorType TEXT NOT NULL,
        actorId TEXT,
        payloadJson TEXT,
        payloadSummary TEXT,
        submittedAt TEXT NOT NULL,
        dispatchedAt TEXT,
        executingAt TEXT,
        finishedAt TEXT,
        outcome TEXT,
        reasonCode TEXT,
        reasonDetail TEXT,
        reqSeq INTEGER,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (deviceId) REFERENCES devices(id)
      );

      CREATE TABLE IF NOT EXISTS command_audit (
        id TEXT PRIMARY KEY,
        commandId TEXT NOT NULL,
        ts TEXT NOT NULL,
        eventType TEXT NOT NULL,
        actorType TEXT,
        actorId TEXT,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        detailsJson TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (commandId) REFERENCES commands(commandId)
      );

      CREATE TABLE IF NOT EXISTS pty_sessions (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL UNIQUE,
        deviceId TEXT NOT NULL,
        state TEXT NOT NULL,
        openedByActorType TEXT,
        openedByActorId TEXT,
        attachedActorType TEXT,
        attachedActorId TEXT,
        recordingEnabled INTEGER NOT NULL DEFAULT 0,
        recordingConsentAt TEXT,
        cols INTEGER,
        rows INTEGER,
        openedAt TEXT NOT NULL,
        lastAttachedAt TEXT,
        lastDetachedAt TEXT,
        lastOutputAt TEXT,
        closeRequestedAt TEXT,
        closedAt TEXT,
        expiredAt TEXT,
        deletedAt TEXT,
        failureCode TEXT,
        failureDetail TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (deviceId) REFERENCES devices(id)
      );


      CREATE TABLE IF NOT EXISTS pty_audit (
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        deviceId TEXT NOT NULL,
        ts TEXT NOT NULL,
        eventType TEXT NOT NULL,
        actorType TEXT,
        actorId TEXT,
        summary TEXT NOT NULL,
        detailsJson TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (deviceId) REFERENCES devices(id),
        FOREIGN KEY (sessionId) REFERENCES pty_sessions(sessionId)
      );

      CREATE INDEX IF NOT EXISTS idx_devices_agent_token
        ON devices(agentToken);

      CREATE INDEX IF NOT EXISTS idx_admin_api_tokens_hash
        ON admin_api_tokens(tokenHash);

      CREATE INDEX IF NOT EXISTS idx_telemetry_logs_device_seq
        ON telemetry_logs(deviceId, seq);

      CREATE INDEX IF NOT EXISTS idx_telemetry_logs_device_ts
        ON telemetry_logs(deviceId, ts);

      CREATE INDEX IF NOT EXISTS idx_commands_device_submitted
        ON commands(deviceId, submittedAt DESC);

      CREATE INDEX IF NOT EXISTS idx_commands_state_submitted
        ON commands(state, submittedAt DESC);

      CREATE INDEX IF NOT EXISTS idx_command_audit_command_ts
        ON command_audit(commandId, ts ASC);

      CREATE INDEX IF NOT EXISTS idx_pty_sessions_device_opened
        ON pty_sessions(deviceId, openedAt DESC);

      CREATE INDEX IF NOT EXISTS idx_pty_sessions_state_opened
        ON pty_sessions(state, openedAt DESC);

      CREATE INDEX IF NOT EXISTS idx_pty_audit_session_ts
        ON pty_audit(sessionId, ts ASC);
    `);

    const ptySessionColumns = this.db
      .prepare(`PRAGMA table_info(pty_sessions)`)
      .all() as Array<{ name?: string }>;
    if (!ptySessionColumns.some((column) => column.name === 'deletedAt')) {
      this.db.exec(`ALTER TABLE pty_sessions ADD COLUMN deletedAt TEXT;`);
    }
  }
}
