export const D1_TABLES = [
  'devices',
  'telemetry_logs',
  'device_runtime_state',
  'admin_sessions',
  'admin_api_tokens',
  'commands',
  'command_audit',
  'pty_sessions',
  'pty_audit',
  'file_transfers',
  'remote_browser_sessions',
  'rate_limit_buckets',
  'admin_login_failures',
  'admin_totp',
  'admin_totp_recovery',
  'admin_audit_log',
] as const;

export const D1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lastSeenAt TEXT NOT NULL,
  status TEXT NOT NULL,
  agentToken TEXT NOT NULL,
  os TEXT
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
  createdAt INTEGER NOT NULL,
  ip TEXT,
  userAgent TEXT
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
  kind TEXT NOT NULL DEFAULT 'generic',
  serverId TEXT,
  localSessionId TEXT,
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
  scrollback TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS file_transfers (
  id TEXT PRIMARY KEY,
  transferId TEXT NOT NULL UNIQUE,
  deviceId TEXT NOT NULL,
  serverId TEXT NOT NULL,
  browserSessionId TEXT,
  sessionId TEXT,
  actorType TEXT,
  actorId TEXT,
  state TEXT NOT NULL,
  direction TEXT NOT NULL,
  localPath TEXT,
  remotePath TEXT,
  recursive INTEGER NOT NULL DEFAULT 0,
  overwritePolicy TEXT,
  followSymlinks INTEGER NOT NULL DEFAULT 0,
  rateLimitKbps INTEGER,
  verifyChecksum INTEGER NOT NULL DEFAULT 0,
  preserveMtime INTEGER NOT NULL DEFAULT 0,
  preserveMode INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  maxAttempts INTEGER NOT NULL DEFAULT 1,
  resumeSupported INTEGER NOT NULL DEFAULT 0,
  retryScheduled INTEGER NOT NULL DEFAULT 0,
  resumeToken TEXT,
  resumeOffsetBytes INTEGER,
  tempPathHint TEXT,
  progressEventCount INTEGER NOT NULL DEFAULT 0,
  firstProgressAt TEXT,
  lastProgressAt TEXT,
  finalizeSeen INTEGER NOT NULL DEFAULT 0,
  bytesTransferred INTEGER NOT NULL DEFAULT 0,
  bytesTotal INTEGER,
  percent REAL,
  throughputBps REAL,
  etaSec REAL,
  phase TEXT,
  reasonCode TEXT,
  reasonDetail TEXT,
  message TEXT,
  commandId TEXT,
  reqSeq INTEGER,
  startedAt TEXT,
  finishedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (deviceId) REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS remote_browser_sessions (
  id TEXT PRIMARY KEY,
  browserSessionId TEXT NOT NULL UNIQUE,
  deviceId TEXT NOT NULL,
  serverId TEXT NOT NULL,
  actorType TEXT,
  actorId TEXT,
  state TEXT NOT NULL,
  rootPath TEXT,
  currentPath TEXT,
  failureCode TEXT,
  failureDetail TEXT,
  openedAt TEXT NOT NULL,
  lastActiveAt TEXT,
  closedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (deviceId) REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  resetAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_login_failures (
  clientId TEXT PRIMARY KEY,
  failureCount INTEGER NOT NULL DEFAULT 0,
  lastFailureAt INTEGER NOT NULL,
  lockedUntil INTEGER
);

CREATE TABLE IF NOT EXISTS admin_totp (
  id INTEGER PRIMARY KEY,
  encryptedSecret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_totp_recovery (
  codeHash TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  actor TEXT,
  details TEXT,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_agent_token ON devices(agentToken);
CREATE INDEX IF NOT EXISTS idx_admin_api_tokens_hash ON admin_api_tokens(tokenHash);
CREATE INDEX IF NOT EXISTS idx_telemetry_logs_device_seq ON telemetry_logs(deviceId, seq);
CREATE INDEX IF NOT EXISTS idx_telemetry_logs_device_ts ON telemetry_logs(deviceId, ts);
CREATE INDEX IF NOT EXISTS idx_commands_device_submitted ON commands(deviceId, submittedAt DESC);
CREATE INDEX IF NOT EXISTS idx_commands_state_submitted ON commands(state, submittedAt DESC);
CREATE INDEX IF NOT EXISTS idx_command_audit_command_ts ON command_audit(commandId, ts ASC);
CREATE INDEX IF NOT EXISTS idx_pty_sessions_device_opened ON pty_sessions(deviceId, openedAt DESC);
CREATE INDEX IF NOT EXISTS idx_pty_sessions_state_opened ON pty_sessions(state, openedAt DESC);
CREATE INDEX IF NOT EXISTS idx_pty_audit_session_ts ON pty_audit(sessionId, ts ASC);
CREATE INDEX IF NOT EXISTS idx_file_transfers_device_updated ON file_transfers(deviceId, updatedAt DESC);
CREATE INDEX IF NOT EXISTS idx_file_transfers_state_updated ON file_transfers(state, updatedAt DESC);
CREATE INDEX IF NOT EXISTS idx_remote_browser_sessions_device_updated ON remote_browser_sessions(deviceId, updatedAt DESC);
CREATE INDEX IF NOT EXISTS idx_remote_browser_sessions_state_updated ON remote_browser_sessions(state, updatedAt DESC);
`;
