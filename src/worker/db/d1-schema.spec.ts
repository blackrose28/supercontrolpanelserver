import { describe, expect, it } from 'vitest';
import { D1_SCHEMA_SQL, D1_TABLES } from './d1-schema';

const requiredTables = [
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
];

const requiredIndexes = [
  'idx_devices_agent_token',
  'idx_admin_api_tokens_hash',
  'idx_telemetry_logs_device_seq',
  'idx_telemetry_logs_device_ts',
  'idx_commands_device_submitted',
  'idx_commands_state_submitted',
  'idx_command_audit_command_ts',
  'idx_pty_sessions_device_opened',
  'idx_pty_sessions_state_opened',
  'idx_pty_audit_session_ts',
  'idx_file_transfers_device_updated',
  'idx_file_transfers_state_updated',
  'idx_remote_browser_sessions_device_updated',
  'idx_remote_browser_sessions_state_updated',
];

describe('D1 schema', () => {
  it('declares every current cc-server table for D1 migration', () => {
    expect(D1_TABLES).toEqual(requiredTables);

    for (const table of requiredTables) {
      expect(D1_SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('preserves current lookup indexes for D1 migration', () => {
    for (const index of requiredIndexes) {
      expect(D1_SCHEMA_SQL).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
    }
  });

  it('keeps agent and admin token columns in the schema', () => {
    expect(D1_SCHEMA_SQL).toMatch(/agentToken\s+TEXT\s+NOT\s+NULL/i);
    expect(D1_SCHEMA_SQL).toMatch(/tokenHash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
  });
});
