import { D1LikeDatabase } from './d1-device-store';

export type AdminAuditEntry = {
  id: number;
  event: string;
  actor: string | null;
  details: Record<string, unknown> | null;
  createdAt: number;
};

export type AdminAuditListOptions = {
  limit?: number;
  event?: string;
  actor?: string;
};

type AuditRow = {
  id: number;
  event: string;
  actor: string | null;
  details: string | null;
  createdAt: number;
};

export class D1AdminAuditStore {
  constructor(private readonly db: D1LikeDatabase) {}

  async log(event: string, actor?: string | null, details?: Record<string, unknown> | null, nowMs?: number) {
    const ts = nowMs ?? Date.now();
    await this.db.prepare(
      'INSERT INTO admin_audit_log (event, actor, details, createdAt) VALUES (?, ?, ?, ?)',
    ).bind(
      event,
      actor ?? null,
      details ? JSON.stringify(details) : null,
      ts,
    ).run();
  }

  async list(opts: AdminAuditListOptions = {}): Promise<AdminAuditEntry[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
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

    const { results = [] } = await this.db.prepare(sql).bind(...params).all<AuditRow>();

    return results.map((row) => ({
      id: row.id,
      event: row.event,
      actor: row.actor,
      details: row.details ? JSON.parse(row.details) : null,
      createdAt: row.createdAt,
    }));
  }
}
