import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  MessageEvent,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { Observable, concat, from, map } from 'rxjs';
import { AdminAuthPrincipal, requireAdminAuthorized, requireAdminMutationAuthorized } from '../admin/admin-auth';
import { AdminSessionService } from '../admin/admin-session.service';
import { AdminApiTokenService } from '../admin/admin-api-token.service';
import { DeviceStore } from '../devices/device.store';
import { FileOpSloService } from './file-op-slo.service';
import { FileTransferStore } from './file-transfer.store';
import { FileTransferRecord } from './file-transfer.types';
import { AgentGateway } from '../agent/agent.gateway';

@Controller('v1')
export class FileOpsController {
  constructor(
    private readonly deviceStore: DeviceStore,
    private readonly fileTransferStore: FileTransferStore,
    private readonly fileOpSloService: FileOpSloService,
    private readonly agentGateway: AgentGateway,
    private readonly adminSessions: AdminSessionService,
    private readonly adminApiTokens: AdminApiTokenService,
  ) {}

  @Get('file-transfers')
  listTransfers(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Query('deviceId') deviceId?: string,
    @Query('limit') limit?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['device:read']);

    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedDeviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }
    if (!this.deviceStore.getDevice(normalizedDeviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const resolvedLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return this.fileTransferStore.listByDevice(normalizedDeviceId, resolvedLimit);
  }

  @Post('file-transfers/dismiss')
  dismissTransfer(
    @Body('deviceId') deviceId: string | undefined,
    @Body('transferId') transferId: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminMutationAuthorized(auth, cookie, csrfToken, this.adminSessions, this.adminApiTokens, ['device:control']);

    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedDeviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }
    if (!this.deviceStore.getDevice(normalizedDeviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const normalizedTransferId = String(transferId || '').trim();
    if (!normalizedTransferId) {
      throw new HttpException('transferId is required', HttpStatus.BAD_REQUEST);
    }

    const record = this.fileTransferStore.get(normalizedTransferId);
    if (!record || record.deviceId !== normalizedDeviceId) {
      throw new HttpException('Transfer not found', HttpStatus.NOT_FOUND);
    }
    if (!isTerminalTransferState(record.state)) {
      throw new HttpException(
        {
          code: 'transfer_not_finished',
          message: 'Only finished transfers can be dismissed',
        },
        HttpStatus.CONFLICT,
      );
    }

    this.fileTransferStore.deleteAny(normalizedTransferId);
    return {
      ok: true,
      transferId: normalizedTransferId,
    };
  }

  @Post('file-transfers/stop')
  async stopTransfer(
    @Body('deviceId') deviceId: string | undefined,
    @Body('transferId') transferId: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const principal = requireAdminMutationAuthorized(auth, cookie, csrfToken, this.adminSessions, this.adminApiTokens, ['device:control']);

    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedDeviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }
    if (!this.deviceStore.getDevice(normalizedDeviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const normalizedTransferId = String(transferId || '').trim();
    if (!normalizedTransferId) {
      throw new HttpException('transferId is required', HttpStatus.BAD_REQUEST);
    }

    const record = this.fileTransferStore.get(normalizedTransferId);
    if (!record || record.deviceId !== normalizedDeviceId) {
      throw new HttpException('Transfer not found', HttpStatus.NOT_FOUND);
    }
    ensurePrincipalOwnsTransfer(record, principal);
    if (isTerminalTransferState(record.state)) {
      throw new HttpException({ code: 'transfer_not_running', message: 'Transfer is already finished' }, HttpStatus.CONFLICT);
    }
    if (!record.sessionId) {
      throw new HttpException({ code: 'transfer_stop_unavailable', message: 'Transfer stop is unavailable because the PTY session was not captured for this transfer' }, HttpStatus.CONFLICT);
    }

    const result = this.agentGateway.closePty(normalizedDeviceId, { sessionId: record.sessionId });
    if (!result.ok || typeof result.reqSeq !== 'number') {
      throw new HttpException({ code: result.reason ?? 'TRANSFER_STOP_FAILED', message: 'Failed to request transfer stop' }, HttpStatus.CONFLICT);
    }

    this.fileTransferStore.markState(normalizedTransferId, 'canceled', new Date().toISOString(), {
      phase: record.phase ?? 'transfer',
      reasonCode: 'transfer_stop_requested',
      reasonDetail: 'Operator requested transfer stop',
      message: 'Stopping transfer…',
    });

    return { ok: true, transferId: normalizedTransferId, sessionId: record.sessionId, reqSeq: result.reqSeq, requestedAt: result.requestedAt };
  }

  @Post('file-transfers/force-remove')
  forceRemoveTransfer(
    @Body('deviceId') deviceId: string | undefined,
    @Body('transferId') transferId: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    const principal = requireAdminMutationAuthorized(auth, cookie, csrfToken, this.adminSessions, this.adminApiTokens, ['device:control']);

    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedDeviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }
    if (!this.deviceStore.getDevice(normalizedDeviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const normalizedTransferId = String(transferId || '').trim();
    if (!normalizedTransferId) {
      throw new HttpException('transferId is required', HttpStatus.BAD_REQUEST);
    }

    const record = this.fileTransferStore.get(normalizedTransferId);
    if (!record || record.deviceId !== normalizedDeviceId) {
      throw new HttpException('Transfer not found', HttpStatus.NOT_FOUND);
    }
    ensurePrincipalOwnsTransfer(record, principal);

    this.fileTransferStore.deleteAny(normalizedTransferId);
    return {
      ok: true,
      transferId: normalizedTransferId,
      forced: !isTerminalTransferState(record.state),
    };
  }

  @Post('file-transfers/dismiss-finished')
  dismissFinishedTransfers(
    @Body('deviceId') deviceId: string | undefined,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminMutationAuthorized(auth, cookie, csrfToken, this.adminSessions, this.adminApiTokens, ['device:control']);

    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedDeviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }
    if (!this.deviceStore.getDevice(normalizedDeviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const result = this.fileTransferStore.deleteFinishedByDevice(normalizedDeviceId);
    return {
      ok: true,
      deletedCount: result.deletedCount,
    };
  }

  @Get('file-transfers/slo-summary')
  getTransferSloSummary(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Query('deviceId') deviceId?: string,
    @Query('windowHours') windowHours?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['device:read']);

    const normalizedDeviceId = String(deviceId || '').trim();
    if (normalizedDeviceId && !this.deviceStore.getDevice(normalizedDeviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    return this.fileOpSloService.getSummary({
      deviceId: normalizedDeviceId || undefined,
      windowHours: windowHours ? Number(windowHours) : undefined,
    });
  }

  @Sse('file-transfers/stream')
  streamTransfers(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Query('deviceId') deviceId?: string,
    @Query('limit') limit?: string,
  ): Observable<MessageEvent> {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['device:read']);

    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedDeviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }
    if (!this.deviceStore.getDevice(normalizedDeviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const resolvedLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const backlog$ = from(this.fileTransferStore.listByDevice(normalizedDeviceId, resolvedLimit)).pipe(
      map((record) => this.toSse(record)),
    );
    const live$ = this.fileTransferStore
      .streamByDevice(normalizedDeviceId)
      .pipe(map((record) => this.toSse(record)));
    return concat(backlog$, live$);
  }

  private toSse(record: FileTransferRecord): MessageEvent {
    return {
      type: 'file_transfer',
      data: record,
    };
  }
}

function isTerminalTransferState(state: FileTransferRecord['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'canceled';
}

function ensurePrincipalOwnsTransfer(record: FileTransferRecord, principal: AdminAuthPrincipal) {
  const actor = mapPrincipalToTransferActor(principal);
  if (!record.actorType) {
    return;
  }
  if (record.actorType === actor.actorType && record.actorId === actor.actorId) {
    return;
  }
  throw new HttpException({ code: 'TRANSFER_UNAUTHORIZED', message: 'Transfer is owned by another operator' }, HttpStatus.FORBIDDEN);
}

function mapPrincipalToTransferActor(principal: AdminAuthPrincipal): { actorType: string; actorId: string | null } {
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
