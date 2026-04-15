import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { redactTelemetryPayload } from '../logs/log-redaction';

export type RemoteBrowserSessionState = 'opening' | 'open' | 'closed' | 'failed';

export interface RemoteBrowserSessionRecord {
  id: string;
  browserSessionId: string;
  deviceId: string;
  serverId: string;
  actorType: string | null;
  actorId: string | null;
  state: RemoteBrowserSessionState;
  rootPath: string | null;
  currentPath: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  openedAt: string;
  lastActiveAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class RemoteBrowserSessionStore {
  constructor(private readonly databaseService: DatabaseService) {}

  createOpening(input: {
    id: string;
    browserSessionId: string;
    deviceId: string;
    serverId: string;
    actorType?: string | null;
    actorId?: string | null;
    openedAt: string;
    rootPath?: string | null;
  }): RemoteBrowserSessionRecord {
    this.databaseService.connection
      .prepare(
        `
          INSERT INTO remote_browser_sessions (
            id, browserSessionId, deviceId, serverId, actorType, actorId,
            state, rootPath, currentPath, failureCode, failureDetail,
            openedAt, lastActiveAt, closedAt, createdAt, updatedAt
          )
          VALUES (
            @id, @browserSessionId, @deviceId, @serverId, @actorType, @actorId,
            'opening', @rootPath, @rootPath, NULL, NULL,
            @openedAt, @openedAt, NULL, @openedAt, @openedAt
          )
        `,
      )
      .run({
        ...input,
        actorType: input.actorType ?? null,
        actorId: input.actorId ?? null,
        rootPath: input.rootPath ?? null,
      });

    return this.getRequired(input.browserSessionId);
  }

  markOpen(browserSessionId: string, ts: string, rootPath?: string | null): RemoteBrowserSessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE remote_browser_sessions
          SET state = 'open',
              rootPath = COALESCE(@rootPath, rootPath),
              currentPath = COALESCE(@rootPath, currentPath),
              failureCode = NULL,
              failureDetail = NULL,
              lastActiveAt = @ts,
              updatedAt = @ts
          WHERE browserSessionId = @browserSessionId
        `,
      )
      .run({ browserSessionId, ts, rootPath: rootPath ?? null });
    return this.getRequired(browserSessionId);
  }

  noteActivity(browserSessionId: string, ts: string, currentPath?: string | null): RemoteBrowserSessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE remote_browser_sessions
          SET currentPath = COALESCE(@currentPath, currentPath),
              lastActiveAt = @ts,
              updatedAt = @ts
          WHERE browserSessionId = @browserSessionId
        `,
      )
      .run({ browserSessionId, ts, currentPath: currentPath ?? null });
    return this.getRequired(browserSessionId);
  }

  markFailed(browserSessionId: string, code: string, detail: string | null, ts: string): RemoteBrowserSessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE remote_browser_sessions
          SET state = 'failed',
              failureCode = @code,
              failureDetail = @detail,
              closedAt = COALESCE(closedAt, @ts),
              updatedAt = @ts
          WHERE browserSessionId = @browserSessionId
        `,
      )
      .run({ browserSessionId, code, detail: sanitizeText(detail), ts });
    return this.getRequired(browserSessionId);
  }

  markClosed(browserSessionId: string, ts: string, detail?: string | null): RemoteBrowserSessionRecord {
    this.databaseService.connection
      .prepare(
        `
          UPDATE remote_browser_sessions
          SET state = 'closed',
              failureDetail = COALESCE(@detail, failureDetail),
              closedAt = COALESCE(closedAt, @ts),
              updatedAt = @ts
          WHERE browserSessionId = @browserSessionId
        `,
      )
      .run({ browserSessionId, ts, detail: sanitizeText(detail), });
    return this.getRequired(browserSessionId);
  }

  get(browserSessionId: string): RemoteBrowserSessionRecord | undefined {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM remote_browser_sessions
          WHERE browserSessionId = ?
        `,
      )
      .get(browserSessionId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  listByDevice(deviceId: string, limit = 100): RemoteBrowserSessionRecord[] {
    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT *
          FROM remote_browser_sessions
          WHERE deviceId = ?
          ORDER BY updatedAt DESC, createdAt DESC
          LIMIT ?
        `,
      )
      .all(deviceId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  countActiveByDevice(deviceId: string): number {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT COUNT(*) as count
          FROM remote_browser_sessions
          WHERE deviceId = ?
            AND state IN ('opening', 'open')
        `,
      )
      .get(deviceId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  countActive(): number {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT COUNT(*) as count
          FROM remote_browser_sessions
          WHERE state IN ('opening', 'open')
        `,
      )
      .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  expireStaleActive(ts: string, maxIdleMs: number, maxOpeningMs = maxIdleMs): number {
    const staleOpeningBefore = new Date(Date.parse(ts) - maxOpeningMs).toISOString();
    const staleActiveBefore = new Date(Date.parse(ts) - maxIdleMs).toISOString();
    const result = this.databaseService.connection
      .prepare(
        `
          UPDATE remote_browser_sessions
          SET state = 'closed',
              failureCode = COALESCE(failureCode, 'BROWSER_SESSION_EXPIRED'),
              failureDetail = COALESCE(
                failureDetail,
                CASE
                  WHEN state = 'opening' THEN 'Remote browser session expired while opening'
                  ELSE 'Remote browser session expired after inactivity'
                END
              ),
              closedAt = COALESCE(closedAt, @ts),
              updatedAt = @ts
          WHERE state IN ('opening', 'open')
            AND (
              (state = 'opening' AND openedAt <= @staleOpeningBefore)
              OR
              (state = 'open' AND COALESCE(lastActiveAt, openedAt) <= @staleActiveBefore)
            )
        `,
      )
      .run({ ts, staleOpeningBefore, staleActiveBefore }) as { changes?: number };
    return Number(result.changes ?? 0);
  }

  private getRequired(browserSessionId: string): RemoteBrowserSessionRecord {
    const record = this.get(browserSessionId);
    if (!record) {
      throw new Error(`Remote browser session not found: ${browserSessionId}`);
    }
    return record;
  }

  private mapRow(row: Record<string, unknown>): RemoteBrowserSessionRecord {
    return {
      id: String(row.id),
      browserSessionId: String(row.browserSessionId),
      deviceId: String(row.deviceId),
      serverId: String(row.serverId),
      actorType: nullableString(row.actorType),
      actorId: nullableString(row.actorId),
      state: String(row.state) as RemoteBrowserSessionState,
      rootPath: nullableString(row.rootPath),
      currentPath: nullableString(row.currentPath),
      failureCode: nullableString(row.failureCode),
      failureDetail: nullableString(row.failureDetail),
      openedAt: String(row.openedAt),
      lastActiveAt: nullableString(row.lastActiveAt),
      closedAt: nullableString(row.closedAt),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function sanitizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return redactTelemetryPayload(value);
}
