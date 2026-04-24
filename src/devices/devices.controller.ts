import { Controller, Get, Post, Body, Param, HttpException, HttpStatus, Headers } from '@nestjs/common';
import { DeviceStore } from './device.store';
import { randomUUID } from 'node:crypto';
import { getBootstrapToken } from '../config/auth';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { getClientId } from '../rate-limit/client-id';
import { AdminSessionService } from '../admin/admin-session.service';
import {
  requireAdminAuthorized,
  requireAdminMutationAuthorized,
} from '../admin/admin-auth';
import { AdminApiTokenService } from '../admin/admin-api-token.service';
import { CommandDispatchService } from '../commands/command-dispatch.service';

@Controller('v1')
export class DevicesController {
  constructor(
    private deviceStore: DeviceStore,
    private readonly rateLimitService: RateLimitService,
    private readonly adminSessions: AdminSessionService,
    private readonly adminApiTokens: AdminApiTokenService,
    private readonly commandDispatch: CommandDispatchService,
  ) {}

  @Get('devices')
  getAllDevices(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['device:read']);
    return this.deviceStore.getAllDevices().map(d => ({
      id: d.id,
      name: d.name,
      lastSeenAt: d.lastSeenAt,
      status: d.status,
      os: d.os,
    }));
  }

  @Get('devices/:id')
  getDevice(
    @Param('id') id: string,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['device:read']);
    const device = this.deviceStore.getDevice(id);
    if (!device) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }
    return {
      id: device.id,
      name: device.name,
      lastSeenAt: device.lastSeenAt,
      status: device.status,
      os: device.os,
    };
  }

  @Post('enroll')
  enroll(
    @Body() body: { bootstrapToken: string; deviceName?: string },
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-real-ip') realIp?: string,
  ) {
    const clientId = getClientId(forwardedFor, realIp);
    this.rateLimitService.check(
      `enroll:${clientId}`,
      this.rateLimitService.enrollLimit(),
      this.rateLimitService.enrollWindowMs(),
    );

    const validToken = getBootstrapToken();
    if (!body.bootstrapToken || body.bootstrapToken !== validToken) {
      throw new HttpException('BOOTSTRAP_TOKEN_INVALID', HttpStatus.UNAUTHORIZED);
    }

    const deviceId = randomUUID();
    const agentToken = randomUUID();
    const deviceName = body.deviceName || `device-${deviceId.substring(0, 8)}`;

    const device = this.deviceStore.addDevice({
      id: deviceId,
      name: deviceName,
      lastSeenAt: new Date().toISOString(),
      status: 'disconnected',
      agentToken,
    });

    return {
      deviceId: device.id,
      ccAgentToken: agentToken,
      deviceName: device.name,
    };
  }

  @Post('devices/:id/request-status-snapshot')
  requestStatusSnapshot(
    @Param('id') id: string,
    @Body('commandId') commandId: string | undefined,
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
      deviceId: id,
      commandType: 'request_status_snapshot',
      requestedCommandId: commandId,
      principal,
    });
  }

  @Post('devices/:id/request-inventory')
  requestInventory(
    @Param('id') id: string,
    @Body('commandId') commandId: string | undefined,
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
      deviceId: id,
      commandType: 'request_inventory',
      requestedCommandId: commandId,
      principal,
    });
  }

  @Post('devices/:id/request-recent-logs')
  requestRecentLogs(
    @Param('id') id: string,
    @Body('commandId') commandId: string | undefined,
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
      deviceId: id,
      commandType: 'request_recent_logs',
      requestedCommandId: commandId,
      principal,
    });
  }

  @Post('devices/:id/request-restart-openvpn')
  requestRestartOpenvpn(
    @Param('id') id: string,
    @Body('commandId') commandId: string | undefined,
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
      deviceId: id,
      commandType: 'restart_openvpn',
      requestedCommandId: commandId,
      principal,
    });
  }

  @Post('devices/:id/request-restart-boundary-auth')
  requestRestartBoundaryAuth(
    @Param('id') id: string,
    @Body('commandId') commandId: string | undefined,
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
      deviceId: id,
      commandType: 'restart_boundary_auth',
      requestedCommandId: commandId,
      principal,
    });
  }

  @Post('devices/:id/request-restart-server-tunnel')
  requestRestartServerTunnel(
    @Param('id') id: string,
    @Body('serverId') serverId: string | undefined,
    @Body('commandId') commandId: string | undefined,
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
      deviceId: id,
      commandType: 'restart_server_tunnel',
      requestedCommandId: commandId,
      payload: { serverId: String(serverId || '').trim() },
      principal,
    });
  }

  @Post('devices/:id/request-start-server-tunnel')
  requestStartServerTunnel(
    @Param('id') id: string,
    @Body('serverId') serverId: string | undefined,
    @Body('commandId') commandId: string | undefined,
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
      deviceId: id,
      commandType: 'start_server_tunnel',
      requestedCommandId: commandId,
      payload: { serverId: String(serverId || '').trim() },
      principal,
    });
  }

  @Post('devices/:id/request-stop-server-tunnel')
  requestStopServerTunnel(
    @Param('id') id: string,
    @Body('serverId') serverId: string | undefined,
    @Body('commandId') commandId: string | undefined,
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
      deviceId: id,
      commandType: 'stop_server_tunnel',
      requestedCommandId: commandId,
      payload: { serverId: String(serverId || '').trim() },
      principal,
    });
  }

  @Post('devices/:id/request-restart-server-ssh')
  requestRestartServerSsh(
    @Param('id') id: string,
    @Body('serverId') serverId: string | undefined,
    @Body('commandId') commandId: string | undefined,
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
      deviceId: id,
      commandType: 'restart_server_ssh',
      requestedCommandId: commandId,
      payload: { serverId: String(serverId || '').trim() },
      principal,
    });
  }
}
