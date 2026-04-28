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
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { DeviceStore } from '../devices/device.store';
import { verifyAdminPassword } from '../config/auth';
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  ensureCsrfToken,
  parseCookies,
  requireCsrf,
  requireAdminSessionAuthorized,
  authFailureDelay,
} from './admin-auth';
import { AdminSessionService } from './admin-session.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { AdminLockoutService } from './admin-lockout.service';
import { TotpService } from './totp.service';
import { AdminAuditService, AuditEvents } from './admin-audit.service';
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
    private readonly lockoutService: AdminLockoutService,
    private readonly totpService: TotpService,
    private readonly auditService: AdminAuditService,
  ) {}

  @Get()
  @Redirect('/')
  root() {
    return;
  }

  @Get('devices')
  @Redirect('/')
  legacyDevices() {
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

  @Post('login')
  @HttpCode(200)
  async login(
    @Body('password') password: string,
    @Body('csrfToken') csrfToken: string,
    @Headers('cookie') cookie: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-real-ip') realIp?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const clientId = getClientId(forwardedFor, realIp);
    const ip = forwardedFor?.split(',')[0]?.trim() || realIp || req.ip || req.socket?.remoteAddress || null;
    this.rateLimitService.check(
      `login:${clientId}`,
      this.rateLimitService.loginLimit(),
      this.rateLimitService.loginWindowMs(),
    );
    requireCsrf(cookie, csrfToken);

    const lockout = this.lockoutService.checkLockout(clientId);
    if (!lockout.allowed) {
      await authFailureDelay();
      this.auditService.log(AuditEvents.LOGIN_LOCKOUT, ip || clientId, { failureCount: lockout.failureCount });
      if (lockout.lockedOut) {
        return res.redirect(
          `/admin/login?error=Account+locked.+Try+again+in+${Math.ceil(lockout.retryAfterMs / 60000)}+minutes`,
        );
      }
      return res.redirect(`/admin/login?error=Too+many+attempts.+Retry+in+${Math.ceil(lockout.retryAfterMs / 1000)}+seconds`);
    }

    if (!verifyAdminPassword(password)) {
      this.lockoutService.recordFailure(clientId);
      this.auditService.log(AuditEvents.LOGIN_FAILED, ip || clientId, { reason: 'wrong-password' });
      await authFailureDelay();
      return res.redirect('/admin/login?error=Invalid+password');
    }

    this.lockoutService.resetLockout(clientId);

    const secure = process.env.NODE_ENV === 'production';

    if (this.totpService.isEnabled()) {
      const totpToken = crypto.randomUUID();
      res.cookie('cc_admin_totp', totpToken, {
        httpOnly: true,
        sameSite: 'strict',
        secure,
        path: '/',
        maxAge: 2 * 60 * 1000,
      });
      TotpChallenges.set(totpToken, Date.now() + 2 * 60 * 1000);
      return res.redirect('/admin/login/totp');
    }

    const session = this.adminSessions.createSession({ ip, userAgent });
    this.auditService.log(AuditEvents.LOGIN_SUCCESS, ip || clientId, { userAgent });
    res.cookie(ADMIN_SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/',
      maxAge: this.adminSessions.getTtlMs(),
    });
    res.redirect('/');
  }

  @Get('login/totp')
  totpLoginPage(
    @Query('error') error?: string,
    @Headers('cookie') cookie?: string,
    @Res() res?: Response,
  ) {
    const csrfToken = ensureCsrfToken(res!, cookie);
    if (!validateTotpChallenge(cookie)) {
      return res!.redirect('/admin/login?error=TOTP+challenge+expired');
    }
    res!.render('login-totp', { csrfToken, error: error || undefined });
  }

  @Post('login/totp')
  @HttpCode(200)
  async loginTotp(
    @Body('totpCode') totpCode: string,
    @Body('csrfToken') csrfToken: string,
    @Headers('cookie') cookie: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-real-ip') realIp?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const clientId = getClientId(forwardedFor, realIp);
    const ip = forwardedFor?.split(',')[0]?.trim() || realIp || req.ip || req.socket?.remoteAddress || null;
    this.rateLimitService.check(
      `login-totp:${clientId}`,
      5,
      60_000,
    );
    requireCsrf(cookie, csrfToken);

    if (!validateTotpChallenge(cookie)) {
      await authFailureDelay();
      return res.redirect('/admin/login?error=TOTP+challenge+expired');
    }

    if (!this.totpService.verify(totpCode)) {
      this.auditService.log(AuditEvents.LOGIN_TOTP_FAILED, ip || clientId);
      await authFailureDelay();
      return res.redirect('/admin/login/totp?error=Invalid+TOTP+code');
    }

    consumeTotpChallenge(cookie);
    const session = this.adminSessions.createSession({ ip, userAgent });
    this.auditService.log(AuditEvents.LOGIN_SUCCESS, ip || clientId, { userAgent, method: 'totp' });
    const secure = process.env.NODE_ENV === 'production';
    res.clearCookie('cc_admin_totp', { path: '/' });
    res.cookie(ADMIN_SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/',
      maxAge: this.adminSessions.getTtlMs(),
    });
    res.redirect('/');
  }

  @Get('totp/status')
  getTotpStatus(@Headers('cookie') cookie?: string) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    return { enabled: this.totpService.isEnabled() };
  }

  @Post('totp/setup')
  async setupTotp(
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    requireCsrf(cookie, csrfToken);
    return this.totpService.generateSetup();
  }

  @Post('totp/verify-setup')
  verifyTotpSetup(
    @Body('csrfToken') csrfToken: string | undefined,
    @Body('totpCode') totpCode: string | undefined,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    requireCsrf(cookie, csrfToken);
    if (!totpCode || typeof totpCode !== 'string') {
      throw new BadRequestException('totpCode is required');
    }
    const ok = this.totpService.verifyAndEnable(totpCode);
    if (!ok) {
      throw new BadRequestException('Invalid TOTP code');
    }
    this.auditService.log(AuditEvents.TOTP_ENABLED, undefined, { fromSetup: true });
    return { enabled: true };
  }

  @Post('totp/disable')
  disableTotp(
    @Body('csrfToken') csrfToken: string | undefined,
    @Body('totpCode') totpCode: string | undefined,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    requireCsrf(cookie, csrfToken);
    if (!totpCode || typeof totpCode !== 'string') {
      throw new BadRequestException('totpCode is required');
    }
    const ok = this.totpService.disable(totpCode);
    if (!ok) {
      throw new BadRequestException('Invalid TOTP code');
    }
    this.auditService.log(AuditEvents.TOTP_DISABLED);
    return { enabled: false };
  }

  @Get('totp/recovery-codes')
  getRecoveryCodes(
    @Headers('cookie') cookie?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-real-ip') realIp?: string,
  ) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    const clientId = getClientId(forwardedFor, realIp);
    this.rateLimitService.check(`totp-rc:${clientId}`, 2, 60_000);
    return { codes: this.totpService.getRecoveryCodes() };
  }

  @Post('totp/regenerate-recovery-codes')
  regenerateRecoveryCodes(
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('cookie') cookie?: string,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-real-ip') realIp?: string,
  ) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    requireCsrf(cookie, csrfToken);
    const clientId = getClientId(forwardedFor, realIp);
    this.rateLimitService.check(`totp-rc-gen:${clientId}`, 2, 60_000);
    this.auditService.log(AuditEvents.TOTP_RECOVERY_REGENERATED);
    return { codes: this.totpService.regenerateRecoveryCodes() };
  }

  @Post('login/recovery')
  @HttpCode(200)
  async loginRecovery(
    @Body('recoveryCode') recoveryCode: string,
    @Body('csrfToken') csrfToken: string,
    @Headers('cookie') cookie: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-forwarded-for') forwardedFor?: string,
    @Headers('x-real-ip') realIp?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    const clientId = getClientId(forwardedFor, realIp);
    const ip = forwardedFor?.split(',')[0]?.trim() || realIp || req.ip || req.socket?.remoteAddress || null;
    this.rateLimitService.check(`login-recovery:${clientId}`, 5, 60_000);
    requireCsrf(cookie, csrfToken);

    if (!validateTotpChallenge(cookie)) {
      await authFailureDelay();
      return res.redirect('/admin/login?error=Recovery+challenge+expired');
    }

    if (!this.totpService.verifyRecoveryCode(recoveryCode)) {
      await authFailureDelay();
      return res.redirect('/admin/login/totp?error=Invalid+recovery+code');
    }

    consumeTotpChallenge(cookie);
    const session = this.adminSessions.createSession({ ip, userAgent });
    this.auditService.log(AuditEvents.LOGIN_RECOVERY_USED, ip || clientId, { userAgent });
    const secure = process.env.NODE_ENV === 'production';
    res.clearCookie('cc_admin_totp', { path: '/' });
    res.cookie(ADMIN_SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/',
      maxAge: this.adminSessions.getTtlMs(),
    });
    res.redirect('/');
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

    this.auditService.log(AuditEvents.API_TOKEN_CREATED, undefined, { label: token.label, scopes: token.scopes });

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

    this.auditService.log(AuditEvents.API_TOKEN_REVOKED, undefined, { tokenId });

    return {
      tokenId: revoked.tokenId,
      revokedAt: revoked.revokedAt ? new Date(revoked.revokedAt).toISOString() : null,
    };
  }

  @Get('sessions')
  listSessions(@Headers('cookie') cookie?: string) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    return this.adminSessions.listSessions().map((s) => ({
      tokenHash: s.tokenHash,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      ip: s.ip,
      userAgent: s.userAgent,
    }));
  }

  @Post('sessions/revoke')
  revokeSession(
    @Body('csrfToken') csrfToken: string | undefined,
    @Body('tokenHash') tokenHash: string | undefined,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    requireCsrf(cookie, csrfToken);
    if (!tokenHash || typeof tokenHash !== 'string') {
      throw new BadRequestException('tokenHash is required');
    }
    this.adminSessions.revokeSession(tokenHash);
    this.auditService.log(AuditEvents.SESSION_REVOKED, undefined, { tokenHash });
    return { ok: true };
  }

  @Post('sessions/revoke-all')
  revokeAllSessions(
    @Body('csrfToken') csrfToken: string | undefined,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    requireCsrf(cookie, csrfToken);
    const cookies = parseCookies(cookie);
    const currentToken = cookies[ADMIN_SESSION_COOKIE];
    this.adminSessions.revokeAllExcept(currentToken);
    this.auditService.log(AuditEvents.SESSIONS_REVOKED_ALL);
    return { ok: true };
  }

  @Get('audit-log')
  getAuditLog(
    @Query('event') event?: string,
    @Query('actor') actor?: string,
    @Query('limit') limit?: string,
    @Headers('cookie') cookie?: string,
  ) {
    requireAdminSessionAuthorized(cookie, this.adminSessions);
    const parsedLimit = Number(limit);
    return this.auditService.list({
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100,
      event: event as any,
      actor,
    }).map((entry) => ({
      id: entry.id,
      event: entry.event,
      actor: entry.actor,
      details: entry.details,
      createdAt: entry.createdAt.toISOString(),
    }));
  }

}

const TotpChallenges = new Map<string, number>();

function validateTotpChallenge(cookieHeader: string | undefined): boolean {
  const cookies = parseCookies(cookieHeader);
  const token = cookies['cc_admin_totp'];
  if (!token) return false;
  const expiresAt = TotpChallenges.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    TotpChallenges.delete(token);
    return false;
  }
  return true;
}

function consumeTotpChallenge(cookieHeader: string | undefined): void {
  const cookies = parseCookies(cookieHeader);
  const token = cookies['cc_admin_totp'];
  if (token) TotpChallenges.delete(token);
}
