import { Controller, Get, Post, Body, Param, HttpException, HttpStatus, Headers } from '@nestjs/common';
import { DeviceStore } from './device.store';
import { v4 as uuidv4 } from 'uuid';
import { getBootstrapToken } from '../config/auth';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { getClientId } from '../rate-limit/client-id';
import { AgentGateway } from '../agent/agent.gateway';
import { AdminSessionService } from '../admin/admin-session.service';
import { requireAdminAuthorized, requireCsrf } from '../admin/admin-auth';

@Controller('v1')
export class DevicesController {
  constructor(
    private deviceStore: DeviceStore,
    private readonly rateLimitService: RateLimitService,
    private readonly agentGateway: AgentGateway,
    private readonly adminSessions: AdminSessionService,
  ) {}

  @Get('devices')
  getAllDevices() {
    return this.deviceStore.getAllDevices().map(d => ({
      id: d.id,
      name: d.name,
      lastSeenAt: d.lastSeenAt,
      status: d.status,
    }));
  }

  @Get('devices/:id')
  getDevice(@Param('id') id: string) {
    const device = this.deviceStore.getDevice(id);
    if (!device) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }
    return {
      id: device.id,
      name: device.name,
      lastSeenAt: device.lastSeenAt,
      status: device.status,
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

    const deviceId = uuidv4();
    const agentToken = uuidv4();
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
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions);
    requireCsrf(cookie, csrfToken);

    const device = this.deviceStore.getDevice(id);
    if (!device) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const result = this.agentGateway.requestStatusSnapshot(id);
    if (!result.ok) {
      throw new HttpException(result.reason, HttpStatus.CONFLICT);
    }
    return result;
  }
}
