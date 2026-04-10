import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  AdminAuthPrincipal,
  requireAdminAuthorized,
  requireAdminMutationAuthorized,
} from '../admin/admin-auth';
import { AdminSessionService } from '../admin/admin-session.service';
import { AdminApiTokenService } from '../admin/admin-api-token.service';
import { DeviceStore } from '../devices/device.store';
import { AgentGateway } from '../agent/agent.gateway';
import { PtySessionStore } from './pty-session.store';
import { PtyHubService } from './pty-hub.service';
import { PtyAuditStore } from './pty-audit.store';

@Controller('v1')
export class PtyController {
  constructor(
    private readonly deviceStore: DeviceStore,
    private readonly agentGateway: AgentGateway,
    private readonly ptySessions: PtySessionStore,
    private readonly ptyHub: PtyHubService,
    private readonly ptyAudit: PtyAuditStore,
    private readonly adminSessions: AdminSessionService,
    private readonly adminApiTokens: AdminApiTokenService,
  ) {}

  @Get('devices/:id/pty-sessions')
  listPtySessions(
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['device:read']);
    this.requireDevice(id);
    this.pruneTerminalSessions();
    this.ptySessions.expireDetachedSessions(new Date().toISOString());
    return {
      items: this.ptySessions.listByDevice(id.trim()),
    };
  }

  @Post('devices/:id/pty/open')
  openPty(
    @Param('id') id: string,
    @Body('sessionId') sessionId: string | undefined,
    @Body('cols') cols: number | undefined,
    @Body('rows') rows: number | undefined,
    @Body('recording') recording: boolean | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const principal = requireAdminMutationAuthorized(
      auth,
      cookie,
      csrfToken,
      this.adminSessions,
      this.adminApiTokens,
      ['device:control'],
    );
    const deviceId = this.requireDevice(id);
    this.pruneTerminalSessions();
    this.ptySessions.expireDetachedSessions(new Date().toISOString());
    const normalizedSessionId = String(sessionId || '').trim() || `pty-${uuidv4()}`;
    const normalizedCols = Number(cols);
    const normalizedRows = Number(rows);
    if (!Number.isInteger(normalizedCols) || normalizedCols < 1 || !Number.isInteger(normalizedRows) || normalizedRows < 1) {
      throw new HttpException(
        { ok: false, code: 'PTY_INVALID_SIZE', message: 'cols and rows must be positive integers' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const actor = mapPrincipalToPtyActor(principal);
    return this.agentGateway.openPty(
      deviceId,
      {
        sessionId: normalizedSessionId,
        cols: normalizedCols,
        rows: normalizedRows,
        recording: Boolean(recording),
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
    );
  }

  @Post('devices/:id/pty/attach')
  attachPty(
    @Param('id') id: string,
    @Body('sessionId') sessionId: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const principal = requireAdminMutationAuthorized(
      auth,
      cookie,
      csrfToken,
      this.adminSessions,
      this.adminApiTokens,
      ['device:control'],
    );
    const deviceId = this.requireDevice(id);
    this.pruneTerminalSessions();
    this.ptySessions.expireDetachedSessions(new Date().toISOString());
    const record = this.requireSessionForDevice(deviceId, sessionId);
    const actor = mapPrincipalToPtyActor(principal);
    ensureActorMayAttach(record, actor.actorType, actor.actorId);
    return {
      ok: true,
      session: this.ptySessions.attach(record.sessionId, actor.actorType, actor.actorId, new Date().toISOString()),
    };
  }

  @Post('devices/:id/pty/detach')
  detachPty(
    @Param('id') id: string,
    @Body('sessionId') sessionId: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const principal = requireAdminMutationAuthorized(
      auth,
      cookie,
      csrfToken,
      this.adminSessions,
      this.adminApiTokens,
      ['device:control'],
    );
    const deviceId = this.requireDevice(id);
    this.pruneTerminalSessions();
    this.ptySessions.expireDetachedSessions(new Date().toISOString());
    const record = this.requireSessionForDevice(deviceId, sessionId);
    const actor = mapPrincipalToPtyActor(principal);
    ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
    return {
      ok: true,
      session: this.ptySessions.detach(record.sessionId, new Date().toISOString()),
    };
  }

  @Post('devices/:id/pty/write')
  writePty(
    @Param('id') id: string,
    @Body('sessionId') sessionId: string | undefined,
    @Body('data') data: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const principal = requireAdminMutationAuthorized(
      auth,
      cookie,
      csrfToken,
      this.adminSessions,
      this.adminApiTokens,
      ['device:control'],
    );
    const deviceId = this.requireDevice(id);
    this.pruneTerminalSessions();
    this.ptySessions.expireDetachedSessions(new Date().toISOString());
    const record = this.requireSessionForDevice(deviceId, sessionId);
    const actor = mapPrincipalToPtyActor(principal);
    ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
    if (record.state !== 'open' && record.state !== 'opening' && record.state !== 'closing') {
      throw new HttpException(
        { ok: false, code: 'PTY_ALREADY_CLOSED', message: `PTY session is not writable in state ${record.state}` },
        HttpStatus.CONFLICT,
      );
    }
    return this.agentGateway.writePty(deviceId, {
      sessionId: record.sessionId,
      data: String(data ?? ''),
    });
  }

  @Post('devices/:id/pty/resize')
  resizePty(
    @Param('id') id: string,
    @Body('sessionId') sessionId: string | undefined,
    @Body('cols') cols: number | undefined,
    @Body('rows') rows: number | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const principal = requireAdminMutationAuthorized(
      auth,
      cookie,
      csrfToken,
      this.adminSessions,
      this.adminApiTokens,
      ['device:control'],
    );
    const deviceId = this.requireDevice(id);
    this.pruneTerminalSessions();
    this.ptySessions.expireDetachedSessions(new Date().toISOString());
    const record = this.requireSessionForDevice(deviceId, sessionId);
    const actor = mapPrincipalToPtyActor(principal);
    ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
    const normalizedCols = Number(cols);
    const normalizedRows = Number(rows);
    if (!Number.isInteger(normalizedCols) || normalizedCols < 1 || !Number.isInteger(normalizedRows) || normalizedRows < 1) {
      throw new HttpException(
        { ok: false, code: 'PTY_INVALID_SIZE', message: 'cols and rows must be positive integers' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.agentGateway.resizePty(deviceId, {
      sessionId: record.sessionId,
      cols: normalizedCols,
      rows: normalizedRows,
    });
  }

  @Post('devices/:id/pty/close')
  closePty(
    @Param('id') id: string,
    @Body('sessionId') sessionId: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const principal = requireAdminMutationAuthorized(
      auth,
      cookie,
      csrfToken,
      this.adminSessions,
      this.adminApiTokens,
      ['device:control'],
    );
    const deviceId = this.requireDevice(id);
    this.pruneTerminalSessions();
    this.ptySessions.expireDetachedSessions(new Date().toISOString());
    const record = this.requireSessionForDevice(deviceId, sessionId);
    const actor = mapPrincipalToPtyActor(principal);
    ensureActorOwnsAttachment(record, actor.actorType, actor.actorId);
    return this.agentGateway.closePty(deviceId, { sessionId: record.sessionId });
  }

  @Post('devices/:id/pty/delete')
  deletePty(
    @Param('id') id: string,
    @Body('sessionId') sessionId: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const principal = requireAdminMutationAuthorized(
      auth,
      cookie,
      csrfToken,
      this.adminSessions,
      this.adminApiTokens,
      ['device:control'],
    );
    const deviceId = this.requireDevice(id);
    this.pruneTerminalSessions();
    this.ptySessions.expireDetachedSessions(new Date().toISOString());
    const record = this.requireSessionForDevice(deviceId, sessionId);
    if (!['closed', 'expired', 'failed'].includes(record.state)) {
      throw new HttpException(
        { ok: false, code: 'PTY_DELETE_REJECTED', message: `PTY session cannot be deleted in state ${record.state}` },
        HttpStatus.CONFLICT,
      );
    }
    const deleted = this.ptySessions.deleteTerminalSession(record.sessionId);
    if (!deleted) {
      throw new HttpException(
        { ok: false, code: 'PTY_NOT_FOUND', message: 'PTY session not found for this device' },
        HttpStatus.NOT_FOUND,
      );
    }
    this.ptyHub.clearScrollback(deleted.sessionId);
    const actor = mapPrincipalToPtyActor(principal);
    this.ptyAudit.append({
      id: uuidv4(),
      sessionId: deleted.sessionId,
      deviceId: deleted.deviceId,
      ts: new Date().toISOString(),
      eventType: 'pty_deleted',
      actorType: actor.actorType as any,
      actorId: actor.actorId,
      summary: 'PTY session row deleted from admin UI',
      details: { previousState: deleted.state },
    });
    return {
      ok: true,
      deleted: {
        sessionId: deleted.sessionId,
        state: deleted.state,
      },
    };
  }

  private requireDevice(id: string): string {
    const deviceId = id.trim();
    if (!deviceId) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }
    if (!this.deviceStore.getDevice(deviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }
    return deviceId;
  }

  private requireSessionForDevice(deviceId: string, sessionId: string | undefined) {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      throw new HttpException(
        { ok: false, code: 'SESSION_ID_REQUIRED', message: 'sessionId is required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const record = this.ptySessions.get(normalizedSessionId);
    if (!record || record.deviceId !== deviceId) {
      throw new HttpException(
        { ok: false, code: 'PTY_NOT_FOUND', message: 'PTY session not found for this device' },
        HttpStatus.NOT_FOUND,
      );
    }
    return record;
  }

  private pruneTerminalSessions() {
    const pruned = this.ptySessions.pruneTerminalSessions(new Date().toISOString());
    for (const record of pruned) {
      this.ptyHub.clearScrollback(record.sessionId);
    }
  }
}

function mapPrincipalToPtyActor(principal: AdminAuthPrincipal): { actorType: string; actorId: string | null } {
  switch (principal.kind) {
    case 'db-token':
      return { actorType: 'admin_api_token', actorId: principal.tokenId };
    case 'env-token':
      return { actorType: 'admin_env_token', actorId: 'CC_ADMIN_API_TOKEN' };
    case 'session':
    default:
      return { actorType: 'admin_session', actorId: null };
  }
}

function ensureActorMayAttach(
  record: { attachedActorType: string | null; attachedActorId: string | null; state: string },
  actorType: string,
  actorId: string | null,
) {
  if (['closed', 'expired', 'failed'].includes(record.state)) {
    throw new HttpException(
      { ok: false, code: 'PTY_ALREADY_CLOSED', message: `PTY session is in terminal state ${record.state}` },
      HttpStatus.CONFLICT,
    );
  }
  if (!record.attachedActorType) {
    return;
  }
  if (record.attachedActorType === actorType && record.attachedActorId === actorId) {
    return;
  }
  throw new HttpException(
    { ok: false, code: 'PTY_UNAUTHORIZED', message: 'PTY session is already attached by another operator' },
    HttpStatus.FORBIDDEN,
  );
}

function ensureActorOwnsAttachment(
  record: { attachedActorType: string | null; attachedActorId: string | null },
  actorType: string,
  actorId: string | null,
) {
  if (record.attachedActorType === actorType && record.attachedActorId === actorId) {
    return;
  }
  throw new HttpException(
    { ok: false, code: 'PTY_UNAUTHORIZED', message: 'PTY session is not attached to the current operator' },
    HttpStatus.FORBIDDEN,
  );
}
