import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export const AuditEvents = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGIN_LOCKOUT: 'LOGIN_LOCKOUT',
  LOGIN_TOTP_FAILED: 'LOGIN_TOTP_FAILED',
  LOGIN_RECOVERY_USED: 'LOGIN_RECOVERY_USED',
  TOTP_ENABLED: 'TOTP_ENABLED',
  TOTP_DISABLED: 'TOTP_DISABLED',
  TOTP_RECOVERY_REGENERATED: 'TOTP_RECOVERY_REGENERATED',
  API_TOKEN_CREATED: 'API_TOKEN_CREATED',
  API_TOKEN_REVOKED: 'API_TOKEN_REVOKED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  SESSIONS_REVOKED_ALL: 'SESSIONS_REVOKED_ALL',
} as const;

export type AuditEvent = (typeof AuditEvents)[keyof typeof AuditEvents];

export type AuditEntry = {
  id: number;
  event: AuditEvent;
  actor: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
};

export type AuditListOptions = {
  limit?: number;
  event?: AuditEvent;
  actor?: string;
};

@Injectable()
export class AdminAuditService {
  constructor(private readonly databaseService: DatabaseService) {}

  log(event: AuditEvent, actor?: string, details?: Record<string, unknown>) {
    const now = Date.now();
    this.databaseService.connection
      .prepare(
        'INSERT INTO admin_audit_log (event, actor, details, createdAt) VALUES (?, ?, ?, ?)',
      )
      .run(event, actor ?? null, details ? JSON.stringify(details) : null, now);
  }

  list(opts: AuditListOptions = {}): AuditEntry[] {
    const limit = opts.limit ?? 100;
    let sql = 'SELECT id, event, actor, details, createdAt FROM admin_audit_log WHERE 1=1';
    const params: unknown[] = [];

    if (opts.event) {
      sql += ' AND event = ?';
      params.push(opts.event);
    }
    if (opts.actor) {
      sql += ' AND actor = ?';
      params.push(opts.actor);
    }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    const rows = this.databaseService.connection
      .prepare(sql)
      .all(...params) as Array<{
        id: number;
        event: string;
        actor: string | null;
        details: string | null;
        createdAt: number;
      }>;

    return rows.map((row) => ({
      id: row.id,
      event: row.event as AuditEvent,
      actor: row.actor,
      details: row.details ? JSON.parse(row.details) : null,
      createdAt: new Date(row.createdAt),
    }));
  }
}
