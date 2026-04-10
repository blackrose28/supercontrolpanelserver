import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpException,
  HttpStatus,
  MessageEvent,
  Post,
  Query,
  Res,
  Sse,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable, concat, from, map } from 'rxjs';
import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { DeviceStore } from '../devices/device.store';
import { LogStore, TelemetryEvent, TelemetryFilter } from './log.store';
import { requireAdminAuthorized } from '../admin/admin-auth';
import { AdminSessionService } from '../admin/admin-session.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { getClientId } from '../rate-limit/client-id';
import { AdminApiTokenService } from '../admin/admin-api-token.service';

type LogIngestBody = {
  events?: Array<Partial<TelemetryEvent>>;
} & Partial<TelemetryEvent>;

@Controller('v1')
export class LogsController {
  constructor(
    private readonly deviceStore: DeviceStore,
    private readonly logStore: LogStore,
    private readonly adminSessions: AdminSessionService,
    private readonly adminApiTokens: AdminApiTokenService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  @Post('logs')
  ingest(
    @Headers('authorization') auth?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-real-ip') realIp?: string,
    @Body() body?: LogIngestBody,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const device = this.authenticateAgent(auth);
    const clientId = getClientId(forwardedFor, realIp);
    const ingestLimit = this.rateLimitService.checkDetailed(
      `ingest:${device.id}:${clientId}`,
      this.rateLimitService.ingestLimit(),
      this.rateLimitService.ingestWindowMs(),
    );
    if (!ingestLimit.ok) {
      const retryAfterMs = 'retryAfterMs' in ingestLimit ? ingestLimit.retryAfterMs : 1000;
      res?.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      throw new HttpException(
        {
          type: 'nack',
          payload: {
            code: 'rate_limited',
            rate_limited: true,
            retryAfterMs,
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const incoming = this.normalizeEvents(body);

    if (!incoming.length) {
      throw new HttpException('events payload is required', HttpStatus.BAD_REQUEST);
    }

    const accepted = incoming.map((event, index) =>
      this.logStore.append({
        id: uuidv4(),
        deviceId: device.id,
        type: event.type ?? 'unknown',
        sessionId: event.sessionId ?? null,
        functionId: event.functionId ?? null,
        seq: typeof event.seq === 'number' ? event.seq : Date.now() + index,
        ts: event.ts || new Date().toISOString(),
        payload: event.payload ?? null,
      }),
    );

    return {
      accepted: accepted.length,
      deviceId: device.id,
      lastSeq: accepted[accepted.length - 1]?.seq ?? null,
    };
  }

  @Get('logs')
  list(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Query('deviceId') deviceId?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
    @Query('functionId') functionId?: string,
    @Query('q') q?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, [
      'device:read',
      'logs:read',
    ]);

    if (!deviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }

    if (!this.deviceStore.getDevice(deviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const resolvedLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return this.logStore.listByDevice(
      deviceId,
      resolvedLimit,
      this.resolveFilter(type, functionId, q),
    );
  }

  @Get('logs/export')
  @Header('Content-Type', 'application/json; charset=utf-8')
  exportLogs(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Query('deviceId') deviceId?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
    @Query('functionId') functionId?: string,
    @Query('q') q?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, [
      'device:read',
      'logs:export',
    ]);

    if (!deviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }

    if (!this.deviceStore.getDevice(deviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const resolvedLimit = Math.min(Math.max(Number(limit) || 5000, 1), 50000);
    const filterBy = this.resolveFilter(type, functionId, q);
    const logs = this.logStore.listByDevice(deviceId, resolvedLimit, filterBy);
    const fileSafeDeviceId = deviceId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return {
      fileName: `cc-logs-${fileSafeDeviceId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      exportedAt: new Date().toISOString(),
      deviceId,
      filter: filterBy,
      count: logs.length,
      logs,
    };
  }

  @Get('device-summary')
  summary(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Query('deviceId') deviceId?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['device:read']);

    if (!deviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }

    if (!this.deviceStore.getDevice(deviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    return this.logStore.getDeviceRuntimeSummary(deviceId);
  }

  @Get('log-settings')
  settings(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, ['logs:read']);
    return this.logStore.getRetentionSettings();
  }

  @Sse('logs/stream')
  stream(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Query('deviceId') deviceId?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
    @Query('functionId') functionId?: string,
    @Query('q') q?: string,
  ): Observable<MessageEvent> {
    requireAdminAuthorized(auth, cookie, this.adminSessions, this.adminApiTokens, [
      'device:read',
      'logs:read',
    ]);

    if (!deviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }

    if (!this.deviceStore.getDevice(deviceId)) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const resolvedLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const filterBy = this.resolveFilter(type, functionId, q);
    const backlog = this.logStore.listByDevice(deviceId, resolvedLimit, filterBy);
    const backlog$ = from(backlog).pipe(map((event) => this.toSse(event)));
    const live$ = this.logStore
      .streamByDevice(deviceId, filterBy)
      .pipe(map((event) => this.toSse(event)));
    return concat(backlog$, live$);
  }

  private authenticateAgent(auth?: string) {
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException('Agent auth required');
    }
    const token = auth.slice(7);
    const device = this.deviceStore.findDeviceByAgentToken(token);
    if (!device) {
      throw new UnauthorizedException('AGENT_AUTH_FAILED');
    }
    return device;
  }
  private normalizeEvents(body?: LogIngestBody): Array<Partial<TelemetryEvent>> {
    if (!body) {
      return [];
    }
    if (Array.isArray(body.events)) {
      return body.events;
    }
    if (body.type) {
      return [body];
    }
    return [];
  }

  private resolveFilter(type?: string, functionId?: string, q?: string): TelemetryFilter {
    return {
      type: type?.trim() || undefined,
      functionId: functionId?.trim() || undefined,
      q: q?.trim() || undefined,
    };
  }

  private toSse(event: TelemetryEvent): MessageEvent {
    return {
      type: 'telemetry',
      data: event,
    };
  }
}
