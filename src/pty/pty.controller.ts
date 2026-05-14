import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
import { LogStore } from '../logs/log.store';
import { newServerSshStartSessionId, resolveServerSshAttachSessionId } from './ccPtySessionId';

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
    private readonly logStore: LogStore,
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
    const normalizedSessionId = String(sessionId || '').trim() || newServerSshStartSessionId(deviceId);
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

  @Post('devices/:id/request-start-server-ssh')
  async requestStartServerSsh(
    @Param('id') id: string,
    @Body('serverId') serverId: string | undefined,
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
    const normalizedServerId = String(serverId || '').trim();
    if (!normalizedServerId) {
      throw new HttpException(
        { ok: false, code: 'SERVER_ID_REQUIRED', message: 'serverId is required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const normalizedCols = Number(cols || 120);
    const normalizedRows = Number(rows || 32);
    if (!Number.isInteger(normalizedCols) || normalizedCols < 1 || !Number.isInteger(normalizedRows) || normalizedRows < 1) {
      throw new HttpException(
        { ok: false, code: 'PTY_INVALID_SIZE', message: 'cols and rows must be positive integers' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const actor = mapPrincipalToPtyActor(principal);
    const result = this.agentGateway.requestStartServerSsh(deviceId, {
      serverId: normalizedServerId,
      sessionId: newServerSshStartSessionId(deviceId),
      cols: normalizedCols,
      rows: normalizedRows,
      actorType: actor.actorType,
      actorId: actor.actorId,
    });
    if (!result.ok) {
      throw new HttpException(
        { ok: false, code: result.reason ?? 'DEVICE_NOT_CONNECTED', message: 'Failed to request server SSH terminal' },
        HttpStatus.CONFLICT,
      );
    }
    let ack: { ok: true; payload: unknown; ts: string };
    try {
      ack = await this.agentGateway.awaitReqResponse(deviceId, result.reqSeq);
    } catch (error) {
      throw agentRequestErrorToHttpException(error);
    }

    return {
      ...result,
      agentAck: ack.payload,
    };
  }

  @Post('devices/:id/request-attach-server-ssh')
  async requestAttachServerSsh(
    @Param('id') id: string,
    @Body('serverId') serverId: string | undefined,
    @Body('localSessionId') localSessionId: string | undefined,
    @Body('sessionId') clientSessionId: string | undefined,
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
    const normalizedServerId = String(serverId || '').trim();
    if (!normalizedServerId) {
      throw new HttpException(
        { ok: false, code: 'SERVER_ID_REQUIRED', message: 'serverId is required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const normalizedLocalSessionId = String(localSessionId || '').trim();
    if (!normalizedLocalSessionId) {
      throw new HttpException(
        { ok: false, code: 'LOCAL_SESSION_ID_REQUIRED', message: 'localSessionId is required' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const normalizedCols = Number(cols || 120);
    const normalizedRows = Number(rows || 32);
    if (!Number.isInteger(normalizedCols) || normalizedCols < 1 || !Number.isInteger(normalizedRows) || normalizedRows < 1) {
      throw new HttpException(
        { ok: false, code: 'PTY_INVALID_SIZE', message: 'cols and rows must be positive integers' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const actor = mapPrincipalToPtyActor(principal);
    let sessionId: string;
    try {
      sessionId = resolveServerSshAttachSessionId(deviceId, normalizedLocalSessionId, clientSessionId);
    } catch (err) {
      throw new HttpException(
        {
          ok: false,
          code: 'SESSION_ID_INVALID',
          message: err instanceof Error ? err.message : 'Invalid sessionId for attach',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    this.ptyHub.clearScrollback(sessionId);
    const result = this.agentGateway.requestAttachServerSsh(deviceId, {
      serverId: normalizedServerId,
      sessionId,
      localSessionId: normalizedLocalSessionId,
      cols: normalizedCols,
      rows: normalizedRows,
      actorType: actor.actorType,
      actorId: actor.actorId,
    });
    if (!result.ok) {
      throw new HttpException(
        { ok: false, code: result.reason ?? 'DEVICE_NOT_CONNECTED', message: 'Failed to attach server SSH terminal' },
        HttpStatus.CONFLICT,
      );
    }
    this.seedScrollbackFromLocalSession(deviceId, normalizedLocalSessionId, result.sessionId);

    let ack: { ok: true; payload: unknown; ts: string };
    try {
      ack = await this.agentGateway.awaitReqResponse(deviceId, result.reqSeq);
    } catch (error) {
      this.ptyHub.clearScrollback(result.sessionId);
      throw agentRequestErrorToHttpException(error);
    }

    return {
      ...result,
      agentAck: ack.payload,
    };
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
      id: randomUUID(),
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

  private seedScrollbackFromLocalSession(deviceId: string, localSessionId: string, remoteSessionId: string) {
    const events = this.logStore.listPtyOutputBySession(deviceId, localSessionId, 200);
    for (const event of events) {
      const payload = isRecord(event.payload) ? event.payload : null;
      const data = typeof payload?.data === 'string' ? payload.data : '';
      if (data) {
        this.ptyHub.appendOutput(remoteSessionId, data);
      }
    }
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

function agentRequestErrorToHttpException(error: unknown): HttpException {
  if (error instanceof HttpException) {
    return error;
  }

  const errorRecord = isRecord(error) ? error : null;
  const payload = isRecord(errorRecord?.payload) ? errorRecord.payload : null;
  const code = readString(payload?.error) || readString(errorRecord?.code) || 'AGENT_NACK';
  const message =
    readString(payload?.message)
    || readString(errorRecord?.message)
    || (error instanceof Error ? error.message : '')
    || 'Agent rejected server SSH terminal request';

  return new HttpException(
    {
      ok: false,
      code,
      message,
      agentError: payload ?? errorRecord ?? null,
    },
    HttpStatus.CONFLICT,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
