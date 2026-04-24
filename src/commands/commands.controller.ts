import { Body, Controller, Get, Headers, HttpException, HttpStatus, MessageEvent, Param, Post, Query, Sse } from '@nestjs/common';
import { requireAdminAuthorized, requireAdminMutationAuthorized } from '../admin/admin-auth';
import { AdminSessionService } from '../admin/admin-session.service';
import { AdminApiTokenService } from '../admin/admin-api-token.service';
import { Observable, concat, from, map } from 'rxjs';
import { CommandStore, type CommandRecord } from './command.store';
import { DeviceStore } from '../devices/device.store';
import { CommandDispatchService } from './command-dispatch.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { getClientId } from '../rate-limit/client-id';

@Controller('v1')
export class CommandsController {
  constructor(
    private readonly commandStore: CommandStore,
    private readonly deviceStore: DeviceStore,
    private readonly commandDispatch: CommandDispatchService,
    private readonly adminSessions: AdminSessionService,
    private readonly adminApiTokens: AdminApiTokenService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  @Post('commands')
  createCommand(
    @Body('deviceId') deviceId: string | undefined,
    @Body('commandType') commandType: string | undefined,
    @Body('commandId') commandId: string | undefined,
    @Body('payload') payload: unknown,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-real-ip') realIp?: string,
  ) {
    const principal = requireAdminMutationAuthorized(
      auth,
      cookie,
      csrfToken,
      this.adminSessions,
      this.adminApiTokens,
      ['device:control'],
    );

    enforceFileOpRateLimit(
      this.rateLimitService,
      getClientId(forwardedFor, realIp),
      String(deviceId || '').trim(),
      String(commandType || '').trim(),
    );

    return this.commandDispatch.dispatchGenericCommand({
      deviceId: String(deviceId || '').trim(),
      commandType: String(commandType || '').trim(),
      requestedCommandId: commandId,
      payload,
      principal,
    });
  }

  @Get('commands')
  listCommands(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Query('deviceId') deviceId?: string,
    @Query('state') state?: string,
    @Query('commandType') commandType?: string,
    @Query('actorType') actorType?: string,
    @Query('limit') limit?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['device:read']);

    const normalizedDeviceId = deviceId?.trim();
    if (normalizedDeviceId && !this.deviceStore.getDevice(normalizedDeviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    return {
      items: this.commandStore.listCommands({
        deviceId: normalizedDeviceId,
        state: state?.trim() || undefined,
        commandType: commandType?.trim() || undefined,
        actorType: actorType?.trim() || undefined,
        limit: limit ? Number(limit) : undefined,
      }),
    };
  }

  @Sse('commands/stream')
  streamCommands(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Query('deviceId') deviceId?: string,
    @Query('limit') limit?: string,
  ): Observable<MessageEvent> {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['device:read']);

    const normalizedDeviceId = deviceId?.trim();
    if (!normalizedDeviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }
    if (!this.deviceStore.getDevice(normalizedDeviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const resolvedLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const backlog$ = from(
      this.commandStore.listCommands({ deviceId: normalizedDeviceId, limit: resolvedLimit }),
    ).pipe(map((record) => this.toCommandSse(record)));
    const live$ = this.commandStore
      .streamByDevice(normalizedDeviceId)
      .pipe(map((record) => this.toCommandSse(record)));
    return concat(backlog$, live$);
  }

  @Get('commands/:commandId')
  getCommand(
    @Param('commandId') commandId: string,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['device:read']);

    const normalizedCommandId = commandId.trim();
    if (!normalizedCommandId) {
      throw new HttpException('commandId is required', HttpStatus.BAD_REQUEST);
    }

    const command = this.commandStore.getCommand(normalizedCommandId);
    if (!command) {
      throw new HttpException('Command not found', HttpStatus.NOT_FOUND);
    }

    return command;
  }

  @Get('commands/:commandId/audit')
  getCommandAudit(
    @Param('commandId') commandId: string,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['device:read']);

    const normalizedCommandId = commandId.trim();
    if (!normalizedCommandId) {
      throw new HttpException('commandId is required', HttpStatus.BAD_REQUEST);
    }

    const command = this.commandStore.getCommand(normalizedCommandId);
    if (!command) {
      throw new HttpException('Command not found', HttpStatus.NOT_FOUND);
    }

    return {
      commandId: normalizedCommandId,
      items: this.commandStore.listAudit(normalizedCommandId),
    };
  }

  private toCommandSse(record: CommandRecord): MessageEvent {
    return {
      type: 'command',
      data: record,
    };
  }
}

function enforceFileOpRateLimit(
  rateLimitService: RateLimitService,
  clientId: string,
  deviceId: string,
  commandType: string,
) {
  const normalizedCommandType = commandType.trim();
  if (!normalizedCommandType) {
    return;
  }

  let bucket:
    | { key: string; limit: number; windowMs: number; message: string }
    | null = null;

  if (isBrowserReadCommand(normalizedCommandType)) {
    bucket = {
      key: `browser-read:${deviceId}:${clientId}`,
      limit: rateLimitService.browserReadLimit(),
      windowMs: rateLimitService.browserReadWindowMs(),
      message: 'Remote browser requests are temporarily rate limited',
    };
  } else if (isBrowserMutationCommand(normalizedCommandType)) {
    bucket = {
      key: `browser-mutation:${deviceId}:${clientId}`,
      limit: rateLimitService.browserMutationLimit(),
      windowMs: rateLimitService.browserMutationWindowMs(),
      message: 'Remote browser mutations are temporarily rate limited',
    };
  } else if (isTransferStartCommand(normalizedCommandType)) {
    bucket = {
      key: `transfer-start:${deviceId}:${clientId}`,
      limit: rateLimitService.transferStartLimit(),
      windowMs: rateLimitService.transferStartWindowMs(),
      message: 'Transfer starts are temporarily rate limited',
    };
  } else if (isFileOpCommand(normalizedCommandType)) {
    bucket = {
      key: `file-op:${deviceId}:${clientId}`,
      limit: rateLimitService.fileOpCommandLimit(),
      windowMs: rateLimitService.fileOpCommandWindowMs(),
      message: 'File operations are temporarily rate limited',
    };
  }

  if (!bucket) {
    return;
  }

  const result = rateLimitService.checkDetailed(bucket.key, bucket.limit, bucket.windowMs);
  if (result.ok) {
    return;
  }

  throw new HttpException(
    {
      type: 'nack',
      payload: {
        code: 'rate_limited',
        rate_limited: true,
        retryAfterMs: 'retryAfterMs' in result ? result.retryAfterMs : 1000,
        commandType: normalizedCommandType,
        message: bucket.message,
      },
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

function isBrowserReadCommand(commandType: string) {
  return commandType === 'list_remote_browser_children' || commandType === 'stat_remote_browser_path';
}

function isBrowserMutationCommand(commandType: string) {
  return (
    commandType === 'open_remote_browser'
    || commandType === 'close_remote_browser'
    || commandType === 'create_remote_browser_directory'
    || commandType === 'delete_remote_browser_path'
  );
}

function isTransferStartCommand(commandType: string) {
  return commandType === 'start_scp_upload' || commandType === 'start_scp_download';
}

function isFileOpCommand(commandType: string) {
  return (
    isBrowserReadCommand(commandType)
    || isBrowserMutationCommand(commandType)
    || isTransferStartCommand(commandType)
    || commandType === 'scp_upload'
    || commandType === 'scp_download'
  );
}
