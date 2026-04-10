import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { requireAdminAuthorized, requireAdminMutationAuthorized } from '../admin/admin-auth';
import { AdminSessionService } from '../admin/admin-session.service';
import { AdminApiTokenService } from '../admin/admin-api-token.service';
import { CommandStore } from './command.store';
import { DeviceStore } from '../devices/device.store';
import { CommandDispatchService } from './command-dispatch.service';

@Controller('v1')
export class CommandsController {
  constructor(
    private readonly commandStore: CommandStore,
    private readonly deviceStore: DeviceStore,
    private readonly commandDispatch: CommandDispatchService,
    private readonly adminSessions: AdminSessionService,
    private readonly adminApiTokens: AdminApiTokenService,
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
  ) {
    const principal = requireAdminMutationAuthorized(
      auth,
      cookie,
      csrfToken,
      this.adminSessions,
      this.adminApiTokens,
      ['device:control'],
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
}
