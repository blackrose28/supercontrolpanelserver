import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Redirect,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { join } from 'path';
import { DeviceStore } from '../devices/device.store';
import { getAdminPassword } from '../config/auth';
import { Response } from 'express';
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  ensureCsrfToken,
  hasValidAdminSession,
  parseCookies,
  requireCsrf,
  requireAdminSessionAuthorized,
} from './admin-auth';
import { AdminSessionService } from './admin-session.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { getClientId } from '../rate-limit/client-id';
import {
  ADMIN_API_TOKEN_SCOPES,
  AdminApiTokenScope,
  AdminApiTokenService,
} from './admin-api-token.service';
import { LogStore } from '../logs/log.store';
import { FileTransferStore } from '../file-ops/file-transfer.store';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly deviceStore: DeviceStore,
    private readonly logStore: LogStore,
    private readonly fileTransferStore: FileTransferStore,
    private readonly adminSessions: AdminSessionService,
    private readonly adminApiTokens: AdminApiTokenService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  @Get()
  @Redirect('/admin/devices')
  root() {
    return;
  }

  @Get('login')
  loginPage(
    @Query('error') error?: string,
    @Headers('cookie') cookie?: string,
    @Res() res?: Response,
  ) {
    const csrfToken = ensureCsrfToken(res!, cookie);
    res!.render('login', { csrfToken, error: error || undefined });
  }

  @Get('assets/xterm.min.js')
  xtermScript(@Res() res: Response) {
    return res.sendFile(join(process.cwd(), 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'));
  }

  @Get('assets/xterm.min.css')
  xtermStyles(@Res() res: Response) {
    return res.sendFile(join(process.cwd(), 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'));
  }

  @Get('assets/chart.min.js')
  chartScript(@Res() res: Response) {
    return res.sendFile(join(process.cwd(), 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
  }

  @Post('login')
  @HttpCode(200)
  login(
    @Body('password') password: string,
    @Body('csrfToken') csrfToken: string,
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-real-ip') realIp?: string,
  ) {
    const clientId = getClientId(forwardedFor, realIp);
    this.rateLimitService.check(
      `login:${clientId}`,
      this.rateLimitService.loginLimit(),
      this.rateLimitService.loginWindowMs(),
    );
    requireCsrf(cookie, csrfToken);

    if (password !== getAdminPassword()) {
      return res.redirect('/admin/login?error=Invalid+password');
    }

    const session = this.adminSessions.createSession();
    const secure = process.env.NODE_ENV === 'production';
    res.cookie(ADMIN_SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/',
      maxAge: this.adminSessions.getTtlMs(),
    });
    res.redirect('/admin/devices');
  }

  @Post('logout')
  @HttpCode(200)
  logout(
    @Body('csrfToken') csrfToken: string,
    @Headers('cookie') cookie?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    requireCsrf(cookie, csrfToken);
    const cookies = parseCookies(cookie);
    this.adminSessions.clear(cookies[ADMIN_SESSION_COOKIE]);
    res?.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
    res?.redirect('/admin/login');
  }

  @Get('devices')
  html(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Res() res?: Response,
  ) {
    if (!hasValidAdminSession(cookie, this.adminSessions)) {
      const csrfToken = ensureCsrfToken(res!, cookie);
      res!.redirect('/admin/login');
      return;
    }
    const csrfToken = ensureCsrfToken(res!, cookie);
    const meta = this.renderMeta();
    res!.render('devices', {
      csrfToken,
      adminApiScopes: ADMIN_API_TOKEN_SCOPES,
      meta,
    });
  }

  @Get('api-tokens')
  listApiTokens(@Headers('cookie') cookie?: string) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    return this.adminApiTokens.listTokens().map((token) => ({
      ...token,
      createdAt: new Date(token.createdAt).toISOString(),
      expiresAt: new Date(token.expiresAt).toISOString(),
      lastUsedAt: token.lastUsedAt ? new Date(token.lastUsedAt).toISOString() : null,
      revokedAt: token.revokedAt ? new Date(token.revokedAt).toISOString() : null,
    }));
  }

  @Get('v1/alerts')
  getAlerts(@Headers('cookie') cookie?: string) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    const alerts: Array<{
      id: string;
      severity: string;
      title: string;
      text: string;
      deviceId: string;
      ts: string;
    }> = [];

    const devices = this.deviceStore.getAllDevices();
    const now = Date.now();
    const staleMs = 5 * 60 * 1000;

    for (const device of devices) {
      if (device.status === 'disconnected') {
        alerts.push({
          id: `disconnected-${device.id}`,
          severity: 'critical',
          title: 'Device disconnected',
          text: `${device.id} has not sent a heartbeat in over 5 minutes`,
          deviceId: device.id,
          ts: device.lastSeenAt || new Date().toISOString(),
        });
      } else if (device.lastSeenAt) {
        const lastSeenMs = new Date(device.lastSeenAt).getTime();
        if (now - lastSeenMs > staleMs) {
          alerts.push({
            id: `stale-${device.id}`,
            severity: 'warning',
            title: 'Device may be stale',
            text: `${device.id} last seen ${Math.round((now - lastSeenMs) / 60000)} minutes ago`,
            deviceId: device.id,
            ts: device.lastSeenAt,
          });
        }
      }
    }

    const runtimeSummaries = this.logStore.getAllRuntimeSummaries();
    for (const summary of runtimeSummaries) {
      for (const [functionId, fn] of Object.entries(summary.functions || {})) {
        if (fn.state === 'error') {
          alerts.push({
            id: `function-error-${summary.deviceId}-${functionId}`,
            severity: fn.state === 'error' ? 'critical' : 'warning',
            title: `Function error: ${functionId}`,
            text: fn.message || `${functionId} is in error state`,
            deviceId: summary.deviceId,
            ts: fn.observedAt || new Date().toISOString(),
          });
        }
      }
    }

    const transfers = this.fileTransferStore.listActive();
    for (const transfer of transfers) {
      if (transfer.state === 'failed') {
        alerts.push({
          id: `transfer-failed-${transfer.transferId}`,
          severity: 'critical',
          title: `Transfer failed: ${transfer.direction}`,
          text: transfer.reasonCode || 'Transfer failed',
          deviceId: transfer.deviceId,
          ts: transfer.updatedAt || new Date().toISOString(),
        });
      }
    }

    return {
      alerts: alerts.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()),
      unreadCount: alerts.length,
    };
  }

  @Post('v1/alerts/dismiss')
  dismissAlert(
    @Body('csrfToken') csrfToken: string | undefined,
    @Body('alertId') alertId: string | undefined,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    requireCsrf(cookie, csrfToken);
    if (!alertId || typeof alertId !== 'string') {
      throw new BadRequestException('alertId is required');
    }
    return { ok: true, dismissed: alertId };
  }

  @Post('api-tokens')
  createApiToken(
    @Body('csrfToken') csrfToken: string | undefined,
    @Body('label') label: string | undefined,
    @Body('ttlDays') ttlDays: number | string | undefined,
    @Body('scopes') scopes: unknown,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    requireCsrf(cookie, csrfToken);

    const normalizedLabel = String(label || '').trim();
    if (!normalizedLabel) {
      throw new HttpException('label is required', HttpStatus.BAD_REQUEST);
    }

    const scopeList = Array.isArray(scopes)
      ? scopes
      : typeof scopes === 'string'
        ? [scopes]
        : [];
    const token = this.adminApiTokens.createToken({
      label: normalizedLabel,
      ttlDays: Number(ttlDays),
      scopes: scopeList as AdminApiTokenScope[],
    });

    return {
      tokenId: token.tokenId,
      token: token.token,
      label: token.label,
      scopes: token.scopes,
      createdAt: new Date(token.createdAt).toISOString(),
      expiresAt: new Date(token.expiresAt).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
  }

  @Post('api-tokens/:tokenId/revoke')
  revokeApiToken(
    @Param('tokenId') tokenId: string,
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    requireCsrf(cookie, csrfToken);

    const revoked = this.adminApiTokens.revokeToken(tokenId);
    if (!revoked) {
      throw new HttpException('Token not found', HttpStatus.NOT_FOUND);
    }

    return {
      tokenId: revoked.tokenId,
      revokedAt: revoked.revokedAt ? new Date(revoked.revokedAt).toISOString() : null,
    };
  }

  private renderMeta() {
    const devices = this.deviceStore.getAllDevices();
    return `Total devices: ${devices.length} | Connected: ${
      devices.filter((d) => d.status === 'connected').length
    } | Last updated: ${new Date().toISOString()}`;
  }
}
