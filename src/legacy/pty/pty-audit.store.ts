import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type PtyAuditActorType = 'admin_session' | 'admin_api_token' | 'admin_env_token' | 'system';

@Injectable()
export class PtyAuditStore {
  constructor(private readonly databaseService: DatabaseService) {}

  append(entry: {
    id: string;
    sessionId: string;
    deviceId: string;
    ts: string;
    eventType: string;
    actorType?: PtyAuditActorType | null;
    actorId?: string | null;
    summary: string;
    details?: unknown;
  }) {
    this.databaseService.connection
      .prepare(
        `
          INSERT INTO pty_audit (
            id, sessionId, deviceId, ts, eventType, actorType, actorId, summary, detailsJson
          )
          VALUES (
            @id, @sessionId, @deviceId, @ts, @eventType, @actorType, @actorId, @summary, @detailsJson
          )
        `,
      )
      .run({
        id: entry.id,
        sessionId: entry.sessionId,
        deviceId: entry.deviceId,
        ts: entry.ts,
        eventType: entry.eventType,
        actorType: entry.actorType ?? null,
        actorId: entry.actorId ?? null,
        summary: entry.summary,
        detailsJson: entry.details == null ? null : JSON.stringify(entry.details),
      });
  }
}
