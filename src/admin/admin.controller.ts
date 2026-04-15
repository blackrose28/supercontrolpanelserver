import {
  Body,
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
    @Headers('cookie') cookie: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const csrfToken = ensureCsrfToken(res, cookie);
    return this.renderLoginPage(csrfToken);
  }

  @Get('assets/xterm.min.js')
  xtermScript(@Res() res: Response) {
    return res.sendFile(join(process.cwd(), 'node_modules', 'xterm', 'lib', 'xterm.js'));
  }

  @Get('assets/xterm.min.css')
  xtermStyles(@Res() res: Response) {
    return res.sendFile(join(process.cwd(), 'node_modules', 'xterm', 'css', 'xterm.css'));
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
      return this.renderLoginPage(ensureCsrfToken(res, cookie), 'Invalid password');
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
    @Res({ passthrough: true }) res?: Response,
  ) {
    if (!hasValidAdminSession(cookie, this.adminSessions)) {
      const csrfToken = ensureCsrfToken(res!, cookie);
      return this.renderLoginPage(csrfToken);
    }
    const csrfToken = ensureCsrfToken(res!, cookie);

    const rows = this.renderRows();
    const meta = this.renderMeta();
    
    return `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>CC Admin - Devices</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; margin: 20px; background: #f5f5f5; }
          h1 { color: #333; }
          table { border-collapse: collapse; background: white; width: 100%; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
          th { background: #f8f9fa; font-weight: 600; }
          tbody tr { cursor: pointer; }
          tbody tr:hover td { background: #f8f9fa; }
          tbody tr.selected td { background: #e6fcf5; }
          tbody tr.selected td:first-child { box-shadow: inset 4px 0 0 #12b886; }
          tbody tr.alert-row td { background: #fff5f5; }
          tbody tr.alert-row.selected td { background: #ffe8e8; }
          tbody tr.alert-row.selected td:first-child { box-shadow: inset 4px 0 0 #12b886; }
          .status-connected { color: #12b886; font-weight: 500; }
          .status-disconnected { color: #868e96; }
          .meta { color: #868e96; font-size: 14px; margin-top: 20px; }
          .polling { color: #495057; font-size: 13px; margin-top: 10px; }
          .alerts-panel { margin-top: 24px; background: #fff7ed; color: #7c2d12; border: 1px solid #fdba74; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
          .alerts-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
          .alerts-list { display: grid; gap: 8px; }
          .alert-card { background: #ffffff; border-radius: 8px; padding: 10px 12px; border-left: 4px solid #f97316; }
          .alert-card.critical { border-left-color: #dc2626; }
          .alert-card.warning { border-left-color: #f59e0b; }
          .alert-empty { color: #9a3412; }
.summary-panel { margin-top: 24px; background: white; color: #111827; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
           .summary-title { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
           .summary-meta { color: #6b7280; font-size: 13px; margin-bottom: 12px; }
           .summary-actions { margin-bottom: 12px; }
           .summary-actions button { border: 1px solid #d1d5db; background: #fff; color: #111827; border-radius: 6px; padding: 8px 10px; font-size: 12px; cursor: pointer; }
           .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
           .summary-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; background: #f9fafb; }
           .summary-card.alert { border-color: #fca5a5; background: #fff1f2; }
           .summary-card h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
           .summary-card .summary-state { font-weight: 500; font-size: 11px; display: inline-block; padding: 2px 6px; border-radius: 4px; margin-left: auto; }
           .summary-card .summary-state.running { background: #d1fae5; color: #059669; }
           .summary-card .summary-state.idle { background: #f3f4f6; color: #6b7280; }
           .summary-card .summary-state.error { background: #fee2e2; color: #dc2626; }
           .summary-card .summary-state.starting, .summary-card .summary-state.stopping { background: #fef3c7; color: #d97706; }
           .summary-card .summary-info { font-size: 11px; color: #6b7280; margin-top: 4px; }
           .summary-card .summary-actions { margin-top: 8px; display: flex; gap: 6px; }
           .summary-card .summary-actions button { border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 4px; padding: 4px 8px; font-size: 11px; cursor: pointer; }
           .summary-card .summary-actions button:hover { background: #f9fafb; }
          .summary-state { font-weight: 600; }
          .summary-state.running, .summary-state.connected { color: #059669; }
          .summary-state.stopping, .summary-state.idle { color: #b45309; }
          .summary-state.error, .summary-state.stopped, .summary-state.disconnected { color: #dc2626; }
          .summary-pre { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; margin: 0; }
          .commands-panel { margin-top: 24px; background: white; color: #111827; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .commands-header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
          .commands-title { font-size: 16px; font-weight: 600; }
          .commands-note { color: #6b7280; font-size: 13px; }
          .commands-layout { display: grid; grid-template-columns: minmax(360px, 2fr) minmax(260px, 1fr); gap: 16px; }
          .commands-list { display: grid; gap: 10px; max-height: 420px; overflow: auto; }
          .command-card { border: 1px solid #e5e7eb; border-radius: 10px; background: #f9fafb; padding: 12px; cursor: pointer; }
          .command-card.selected { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.12); background: #eff6ff; }
          .command-card-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; margin-bottom: 6px; }
          .command-card-title { font-weight: 600; font-size: 14px; }
          .command-card-meta { color: #6b7280; font-size: 12px; }
          .command-state { font-weight: 600; font-size: 12px; text-transform: uppercase; }
          .command-state.queued, .command-state.dispatched { color: #1d4ed8; }
          .command-state.executing { color: #b45309; }
          .command-state.succeeded { color: #047857; }
          .command-state.failed, .command-state.canceled { color: #b91c1c; }
          .command-audit { border: 1px solid #e5e7eb; border-radius: 10px; background: #fafafa; padding: 12px; min-height: 220px; }
          .command-audit-title { font-weight: 600; margin-bottom: 8px; }
          .command-audit-list { display: grid; gap: 8px; max-height: 420px; overflow: auto; }
          .command-audit-entry { border-left: 3px solid #cbd5e1; background: #fff; border-radius: 6px; padding: 8px 10px; }
          .command-audit-entry.executing { border-left-color: #f59e0b; }
          .command-audit-entry.succeeded { border-left-color: #10b981; }
          .command-audit-entry.failed, .command-audit-entry.canceled { border-left-color: #ef4444; }
          .command-empty { color: #6b7280; font-size: 13px; border: 1px dashed #d1d5db; border-radius: 10px; padding: 12px; background: #fff; }
          @media (max-width: 960px) {
            .commands-layout { grid-template-columns: 1fr; }
          }
          .logs-panel { margin-top: 24px; background: #111827; color: #e5e7eb; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
          .logs-toolbar { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; }
          .logs-title { font-size: 16px; font-weight: 600; }
          .logs-status { color: #9ca3af; font-size: 13px; }
          .logs-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
          .logs-controls select, .logs-controls input, .logs-controls button { border: 1px solid #374151; background: #111827; color: #e5e7eb; border-radius: 6px; padding: 8px 10px; font-size: 12px; }
          .logs-controls button { cursor: pointer; background: #1f2937; }
          .logs-controls button:hover { background: #374151; }
          .logs-controls label { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: #d1d5db; }
          .logs-output { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.45; max-height: 360px; overflow: auto; background: #030712; border: 1px solid #1f2937; border-radius: 6px; padding: 12px; }
          .logs-empty { color: #9ca3af; }
          .log-entry { padding: 8px 10px; border-radius: 6px; margin-bottom: 8px; background: #0f172a; border-left: 4px solid #334155; }
          .log-entry.log-function-status { border-left-color: #22c55e; }
          .log-entry.log-pty-output { border-left-color: #60a5fa; }
          .log-entry.log-pty-exit { border-left-color: #f59e0b; }
          .log-entry.log-openvpn-log { border-left-color: #a78bfa; }
          .log-entry.log-inventory { border-left-color: #14b8a6; }
          .log-meta { color: #93c5fd; margin-bottom: 4px; }
          .log-payload { color: #e5e7eb; }
          .tokens-panel { margin-top: 24px; background: white; color: #111827; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .tokens-header { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 12px; }
          .tokens-title { font-size: 16px; font-weight: 600; }
          .tokens-note { color: #6b7280; font-size: 13px; }
          .token-form { display: grid; grid-template-columns: minmax(200px, 1.5fr) minmax(120px, 140px) 1fr auto; gap: 12px; align-items: end; margin-bottom: 16px; }
          .token-field label { display: block; font-size: 12px; color: #4b5563; margin-bottom: 6px; }
          .token-field input { width: 100%; box-sizing: border-box; border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
          .token-scopes { display: flex; gap: 8px; flex-wrap: wrap; }
          .token-scopes label { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: #111827; background: #f3f4f6; border-radius: 999px; padding: 6px 10px; }
          .token-actions button, .token-table button { border: 1px solid #d1d5db; background: #111827; color: #fff; border-radius: 6px; padding: 9px 12px; font-size: 12px; cursor: pointer; }
          .token-table button { background: #fff; color: #111827; }
          .token-table button[disabled] { opacity: 0.5; cursor: default; }
          .token-created { margin-bottom: 16px; padding: 12px; border-radius: 8px; background: #ecfeff; border: 1px solid #a5f3fc; }
          .token-created strong { display: block; margin-bottom: 6px; }
          .token-secret { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
          .token-empty { color: #6b7280; font-size: 13px; }
          .token-table { width: 100%; border-collapse: collapse; }
          .token-table th, .token-table td { border: 1px solid #e5e7eb; padding: 10px; font-size: 12px; vertical-align: top; }
          .token-table th { background: #f9fafb; }
          .token-scope-list { display: flex; gap: 6px; flex-wrap: wrap; }
          .token-scope-pill { background: #eef2ff; color: #3730a3; border-radius: 999px; padding: 3px 8px; font-size: 11px; }
          .token-status.revoked { color: #b91c1c; font-weight: 600; }
          .token-status.active { color: #047857; font-weight: 600; }
          .server-picker-backdrop { position: fixed; inset: 0; background: rgba(17, 24, 39, 0.45); display: none; align-items: center; justify-content: center; padding: 24px; z-index: 50; }
          .server-picker-backdrop.open { display: flex; }
          .server-picker-modal { width: min(640px, 100%); background: #fff; color: #111827; border-radius: 12px; box-shadow: 0 20px 45px rgba(0,0,0,0.2); padding: 20px; }
          .server-picker-title { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
          .server-picker-note { color: #6b7280; font-size: 13px; margin-bottom: 16px; }
          .server-picker-list { display: grid; gap: 10px; max-height: 320px; overflow: auto; margin-bottom: 16px; }
          .server-picker-item { border: 1px solid #d1d5db; border-radius: 10px; padding: 12px; cursor: pointer; display: grid; gap: 4px; }
          .server-picker-item.selected { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,0.15); background: #eff6ff; }
          .server-picker-item-title { font-weight: 600; }
          .server-picker-item-meta { color: #4b5563; font-size: 12px; }
          .server-picker-actions { display: flex; justify-content: flex-end; gap: 10px; }
          .server-picker-actions button { border: 1px solid #d1d5db; background: #fff; color: #111827; border-radius: 8px; padding: 9px 12px; cursor: pointer; }
          .server-picker-actions button.primary { background: #111827; color: #fff; }
          .server-picker-actions button[disabled] { opacity: 0.5; cursor: default; }
          .server-picker-empty { color: #6b7280; font-size: 13px; padding: 12px; border: 1px dashed #d1d5db; border-radius: 10px; }
          .remote-browser-backdrop { position: fixed; inset: 0; background: rgba(17, 24, 39, 0.55); display: none; align-items: center; justify-content: center; padding: 24px; z-index: 60; }
          .remote-browser-backdrop.open { display: flex; }
          .remote-browser-modal { width: min(900px, 100%); max-height: 90vh; overflow: hidden; display: grid; grid-template-rows: auto auto auto 1fr auto; gap: 12px; background: #fff; color: #111827; border-radius: 12px; box-shadow: 0 20px 45px rgba(0,0,0,0.25); padding: 20px; }
          .remote-browser-title { font-size: 18px; font-weight: 600; }
          .remote-browser-note { color: #6b7280; font-size: 13px; }
          .remote-browser-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
          .remote-browser-toolbar button, .remote-browser-toolbar input { border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
          .remote-browser-toolbar input { flex: 1 1 280px; min-width: 220px; }
          .remote-browser-status { color: #4b5563; font-size: 12px; min-height: 18px; }
          .remote-browser-status.error { color: #b91c1c; }
          .remote-browser-list { border: 1px solid #e5e7eb; border-radius: 10px; overflow: auto; min-height: 320px; background: #f9fafb; }
          .remote-browser-empty { padding: 16px; color: #6b7280; font-size: 13px; }
          .remote-browser-item { width: 100%; border: 0; border-bottom: 1px solid #e5e7eb; background: transparent; text-align: left; padding: 12px 14px; cursor: pointer; display: grid; gap: 4px; }
          .remote-browser-item:last-child { border-bottom: 0; }
          .remote-browser-item.selected { background: #eff6ff; box-shadow: inset 0 0 0 2px rgba(37,99,235,0.15); }
          .remote-browser-item-name { font-weight: 600; }
          .remote-browser-item-meta { color: #6b7280; font-size: 12px; }
          .remote-browser-actions { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; align-items: center; }
          .remote-browser-actions .group { display: flex; gap: 8px; flex-wrap: wrap; }
          .remote-browser-actions button { border: 1px solid #d1d5db; background: #fff; color: #111827; border-radius: 8px; padding: 9px 12px; cursor: pointer; }
          .remote-browser-actions button.primary { background: #111827; color: #fff; }
          .remote-browser-actions button[disabled] { opacity: 0.5; cursor: default; }
          .remote-browser-transfer { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; background: #f9fafb; display: grid; gap: 10px; }
          .remote-browser-transfer-title { font-size: 14px; font-weight: 600; color: #111827; }
          .remote-browser-transfer-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
          .remote-browser-transfer-field { display: grid; gap: 6px; }
          .remote-browser-transfer-field label { font-size: 12px; color: #374151; }
          .remote-browser-transfer-field input, .remote-browser-transfer-field select { border: 1px solid #d1d5db; border-radius: 8px; padding: 8px 10px; font-size: 13px; width: 100%; box-sizing: border-box; }
          .remote-browser-transfer-options { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: #374151; }
          .remote-browser-transfer-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
          .remote-browser-transfer-buttons button { border: 1px solid #d1d5db; background: #fff; color: #111827; border-radius: 8px; padding: 9px 12px; cursor: pointer; }
          .remote-browser-transfer-buttons button.primary { background: #111827; color: #fff; }
          .remote-browser-transfer-hint { font-size: 12px; color: #6b7280; }
          .transfers-panel { margin-top: 24px; background: white; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .transfers-header { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 12px; }
          .transfers-title { font-size: 16px; font-weight: 600; }
          .transfers-note { color: #6b7280; font-size: 13px; }
          .transfers-list { display: grid; gap: 12px; }
          .transfer-empty { color: #6b7280; font-size: 13px; border: 1px dashed #d1d5db; border-radius: 8px; padding: 16px; background: #f9fafb; }
          .transfer-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: #fff; }
          .transfer-card.running, .transfer-card.starting, .transfer-card.queued { border-color: #bfdbfe; background: #eff6ff; }
          .transfer-card.succeeded { border-color: #bbf7d0; background: #f0fdf4; }
          .transfer-card.failed, .transfer-card.canceled { border-color: #fecaca; background: #fef2f2; }
          .transfer-card-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap; }
          .transfer-card-title { font-weight: 600; color: #111827; }
          .transfer-card-meta { color: #6b7280; font-size: 12px; }
          .transfer-path { margin-top: 8px; font-size: 13px; color: #1f2937; word-break: break-word; }
          .transfer-path code { background: rgba(17,24,39,0.06); padding: 2px 4px; border-radius: 4px; }
          .transfer-progress { margin-top: 10px; height: 8px; border-radius: 999px; background: #dbeafe; overflow: hidden; position: relative; }
          .transfer-progress-bar { height: 100%; background: #2563eb; border-radius: inherit; width: 0%; transition: width 0.2s ease; }
          .transfer-progress.indeterminate .transfer-progress-bar { width: 35%; position: absolute; left: -35%; animation: transfer-indeterminate 1.2s ease-in-out infinite; }
          @keyframes transfer-indeterminate {
            0% { left: -35%; }
            100% { left: 100%; }
          }
          .transfer-facts { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; color: #374151; font-size: 12px; }
          .transfer-reason { margin-top: 8px; color: #991b1b; font-size: 12px; }
          .transfer-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }
          .transfer-actions button { border: 1px solid #d1d5db; background: #fff; color: #111827; border-radius: 8px; padding: 8px 12px; cursor: pointer; font-size: 12px; }
          .transfer-actions button.primary { background: #111827; color: #fff; border-color: #111827; }
          .pty-panel { margin-top: 24px; background: white; color: #111827; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
          .pty-header { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 12px; }
          .pty-title { font-size: 16px; font-weight: 600; }
          .pty-note { color: #6b7280; font-size: 13px; }
          .pty-controls { display: grid; gap: 12px; }
          .pty-toolbar, .pty-input-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
          .pty-toolbar button, .pty-toolbar input, .pty-toolbar select, .pty-input-row button, .pty-input-row input { border: 1px solid #d1d5db; background: #fff; color: #111827; border-radius: 6px; padding: 8px 10px; font-size: 12px; }
          .pty-toolbar button, .pty-input-row button { cursor: pointer; }
          .pty-toolbar button:disabled, .pty-input-row button:disabled, .pty-toolbar input:disabled, .pty-toolbar select:disabled, .pty-input-row input:disabled { opacity: 0.55; cursor: default; }
          .pty-session-meta { color: #6b7280; font-size: 12px; }
          .pty-privacy { font-size: 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; }
          .pty-privacy.hidden { display: none; }
          .pty-status { font-size: 13px; color: #374151; }
          .pty-status.error { color: #b91c1c; }
.pty-output { min-height: 220px; max-height: 420px; overflow: auto; background: #030712; color: #e5e7eb; border: 1px solid #1f2937; border-radius: 8px; padding: 12px; }
	          .pty-output.empty { color: #9ca3af; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.45; }
	          .pty-output.attached { cursor: text; }
           .pty-output .xterm-viewport { overflow-y: auto !important; }
           .pty-input-row input[type="text"] { flex: 1 1 280px; }
           .pty-dim { color: #6b7280; }
           /* Top bar */
           .topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; background: #111827; color: white; margin: -20px -20px 20px -20px; }
           .topbar-logo { font-size: 18px; font-weight: 600; cursor: pointer; }
           .topbar-nav { display: flex; gap: 16px; }
           .topbar-nav button { background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 14px; padding: 6px 10px; border-radius: 6px; }
           .topbar-nav button:hover, .topbar-nav button.active { color: white; background: #374151; }
           .topbar-right { display: flex; align-items: center; gap: 12px; }
           .topbar-status { font-size: 13px; color: #9ca3af; }
           .topbar-btn { background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 14px; padding: 8px; border-radius: 6px; position: relative; }
           .topbar-btn:hover { color: white; background: #374151; }
           .topbar-badge { position: absolute; top: 2px; right: 2px; background: #dc2626; color: white; font-size: 10px; padding: 2px 5px; border-radius: 10px; min-width: 16px; text-align: center; }
           .topbar-user { font-size: 13px; color: #9ca3af; }
           /* Compact devices table */
           .devices-table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
           .devices-table th { background: #f9fafb; font-size: 12px; font-weight: 600; text-transform: uppercase; color: #6b7280; padding: 10px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
           .devices-table td { padding: 10px 12px; border-bottom: 1px solid #f3f4f6; font-size: 13px; }
           .devices-table tr:last-child td { border-bottom: none; }
           .devices-table tr { cursor: pointer; }
           .devices-table tr:hover td { background: #f9fafb; }
           .devices-table tr.selected td { background: #ecfdf5; }
           .devices-table tr.selected td:first-child { border-left: 3px solid #10b981; }
           .devices-table tr.alert-row td { background: #fef2f2; }
           .devices-table tr.alert-row.selected td { background: #fee2e2; }
           .devices-table .device-name { font-weight: 500; color: #111827; }
           .devices-table .device-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
           .devices-table .status-dot { width: 8px; height: 8px; border-radius: 50%; }
           .devices-table .status-dot.connected { background: #10b981; }
           .devices-table .status-dot.disconnected { background: #9ca3af; }
           .devices-table .status-dot.error { background: #ef4444; }
           .devices-table .last-seen { color: #6b7280; font-size: 12px; }
           .devices-table .functions-dots { display: flex; gap: 4px; }
           .devices-table .fn-dot { width: 6px; height: 6px; border-radius: 50%; background: #d1d5db; }
           .devices-table .fn-dot.running { background: #10b981; }
           .devices-table .fn-dot.error { background: #ef4444; }
           .devices-table .actions-dropdown { position: relative; }
           .devices-table .actions-btn { border: 1px solid #d1d5db; background: #fff; color: #374151; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
           .devices-table .actions-btn:hover { background: #f9fafb; }
           .devices-table .actions-menu { display: none; position: absolute; right: 0; top: 100%; background: white; border: 1px solid #e5e7eb; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 100; min-width: 160px; }
           .devices-table .actions-menu.open { display: block; }
           .devices-table .actions-menu button { display: block; width: 100%; border: none; background: none; text-align: left; padding: 10px 14px; font-size: 13px; cursor: pointer; color: #374151; }
           .devices-table .actions-menu button:hover { background: #f9fafb; }
           .devices-search { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; margin-bottom: 12px; box-sizing: border-box; }
           /* Alerts panel */
           .alerts-panel-modal { display: none; position: fixed; top: 56px; right: 20px; width: 360px; max-height: 480px; background: white; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,0.15); z-index: 1000; overflow: hidden; }
           .alerts-panel-modal.open { display: block; }
           .alerts-panel-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #e5e7eb; }
           .alerts-panel-title { font-weight: 600; font-size: 14px; }
           .alerts-panel-clear { font-size: 12px; color: #6b7280; cursor: pointer; }
           .alerts-panel-list { max-height: 400px; overflow-y: auto; }
           .alerts-panel-item { display: flex; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #f3f4f6; cursor: pointer; }
           .alerts-panel-item:hover { background: #f9fafb; }
           .alerts-panel-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-top: 6px; }
           .alerts-panel-dot.critical { background: #dc2626; }
           .alerts-panel-dot.warning { background: #f59e0b; }
           .alerts-panel-content { flex: 1; }
           .alerts-panel-item-title { font-size: 13px; font-weight: 500; }
           .alerts-panel-item-text { font-size: 12px; color: #6b7280; margin-top: 2px; }
           .alerts-panel-item-meta { font-size: 11px; color: #9ca3af; margin-top: 4px; }
           .alerts-empty-panel { padding: 32px; text-align: center; color: #6b7280; font-size: 13px; }
         </style>
         <link rel="stylesheet" href="/admin/assets/xterm.min.css" />
       </head>
       <body>
         <div class="topbar">
           <div class="topbar-logo">SuperControlPanel</div>
           <div class="topbar-nav">
             <button class="active" data-page="devices">Devices</button>
             <button data-page="config">Config</button>
           </div>
           <div class="topbar-right">
             <span class="topbar-status" id="device-summary">-</span>
             <button class="topbar-btn" id="alerts-btn" title="Alerts">
               <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.668 6.668 6 8.009 6 9.5v3.658A2.032 2.032 0 013.405 12.595L2 14v5h5l1.405-1.405A2.032 2.032 0 0111 18.841V15a6.002 6.002 0 014-5.659V5a2 2 0 114 0v.341C16.332 6.668 18 8.009 18 9.5v3.658A2.032 2.032 0 0115.405 12.595L14 14.158V17h1zM9 18.841V15a3 3 0 016 0v3.841"></path></svg>
               <span class="topbar-badge" id="alerts-badge" style="display:none;">0</span>
             </button>
             <form method="post" action="/admin/logout">
               <input type="hidden" name="csrfToken" value="${csrfToken}" />
               <button type="submit" class="topbar-btn" title="Log out">
                 <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path></svg>
               </button>
             </form>
           </div>
         </div>
         <div class="alerts-panel-modal" id="alerts-panel">
           <div class="alerts-panel-header">
             <span class="alerts-panel-title">Alerts</span>
             <span class="alerts-panel-clear" id="clear-alerts">Clear all</span>
           </div>
           <div class="alerts-panel-list" id="alerts-panel-list">
             <div class="alerts-empty-panel">Loading alerts...</div>
           </div>
         </div>
<h1>CC Admin - Devices</h1>
         <input type="text" class="devices-search" id="devices-search" placeholder="Search devices..." />
         <table class="devices-table">
           <thead>
             <tr>
               <th style="width:40px;"></th>
               <th>Device</th>
               <th style="width:100px;">Last Seen</th>
               <th style="width:100px;">Functions</th>
               <th style="width:100px;"></th>
             </tr>
           </thead>
           <tbody id="devices-tbody"><tr><td colspan="6">Loading...</td></tr></tbody>
         </table>
         <div id="devices-meta" class="meta">${meta}</div>
         <section class="alerts-panel" style="display:none;">
           <div class="alerts-title">Alerts</div>
           <div id="alerts-content" class="alerts-list"><div class="alert-empty">No active alerts.</div></div>
         </section>
         <section class="summary-panel">
           <div class="summary-title">Current device state</div>
           <div id="summary-meta" class="summary-meta">Select a device to load the latest persisted runtime summary.</div>
           <div class="summary-actions">
             <button id="request-status-snapshot" type="button">Request fresh status snapshot</button>
             <button id="request-inventory" type="button">Request inventory</button>
             <button id="request-recent-logs" type="button">Request recent logs</button>
             <button id="request-restart-openvpn" type="button">Restart OpenVPN</button>
             <button id="request-restart-boundary-auth" type="button">Restart Boundary auth</button>
             <button id="request-restart-server-tunnel" type="button">Restart server tunnel</button>
             <button id="request-restart-server-ssh" type="button">Restart server SSH</button>
             <button id="open-remote-browser" type="button">Remote browser</button>
           </div>
           <div id="summary-content" class="summary-grid"></div>
         </section>
        <section class="commands-panel">
          <div class="commands-header">
            <div>
              <div class="commands-title">Command history</div>
              <div id="commands-meta" class="commands-note">Select a device to load recent commands and audit trail.</div>
            </div>
          </div>
          <div class="commands-layout">
            <div id="commands-list" class="commands-list">
              <div class="command-empty">No device selected.</div>
            </div>
            <div class="command-audit">
              <div class="command-audit-title">Audit trail</div>
              <div id="command-audit-content" class="command-audit-list">
                <div class="command-empty">Select a command to inspect audit entries.</div>
              </div>
            </div>
          </div>
        </section>
        <section class="transfers-panel">
          <div class="transfers-header">
            <div>
              <div class="transfers-title">File transfer history</div>
              <div id="transfers-meta" class="transfers-note">Select a device to load recent transfer activity.</div>
            </div>
            <div class="summary-actions">
              <button id="clear-finished-transfers" type="button" disabled>Clear finished</button>
            </div>
          </div>
          <div id="transfers-list" class="transfers-list">
            <div class="transfer-empty">No device selected.</div>
          </div>
        </section>
        <section class="pty-panel">
          <div class="pty-header">
            <div>
              <div class="pty-title">Interactive PTY</div>
              <div id="pty-note" class="pty-note">Select a device to inspect or open a PTY session. Open terminal creates and attaches a new PTY; Attach reconnects to the selected session.</div>
            </div>
          </div>
          <div class="pty-controls">
            <div class="pty-toolbar">
              <label>Session
                <select id="pty-session-select" disabled>
                  <option value="">No device selected</option>
                </select>
              </label>
              <button id="pty-refresh-sessions" type="button" disabled>Refresh sessions</button>
              <label>Cols <input id="pty-cols" type="number" min="20" max="400" value="120" /></label>
              <label>Rows <input id="pty-rows" type="number" min="10" max="200" value="32" /></label>
              <label><input id="pty-recording-enabled" type="checkbox" /> Record session</label>
	              <button id="pty-open" type="button" disabled>Open terminal</button>
	              <button id="pty-attach" type="button" disabled>Reattach</button>
	              <button id="pty-resize" type="button" disabled>Resize</button>
	              <button id="pty-detach" type="button" disabled>Detach</button>
	              <button id="pty-close" type="button" disabled>Close</button>
	              <button id="pty-delete" type="button" disabled>Delete session</button>
	            </div>
            <div id="pty-session-meta" class="pty-session-meta">No PTY session selected.</div>
            <div id="pty-privacy" class="pty-privacy hidden">Recording is enabled for this PTY session.</div>
            <div><button id="pty-recording-consent" type="button" disabled>Acknowledge recording</button></div>
	            <div id="pty-status" class="pty-status">PTY websocket idle.</div>
	            <div id="pty-output" class="pty-output empty">No PTY output yet.</div>
	            <div class="pty-input-row">
	              <span class="pty-dim">Click the terminal above and type directly.</span>
	              <button id="pty-send-ctrl-c" type="button" disabled>Ctrl+C</button>
	              <button id="pty-clear-output" type="button">Clear view</button>
	            </div>
          </div>
        </section>
        <section class="tokens-panel">
          <div class="tokens-header">
            <div>
              <div class="tokens-title">Admin API tokens</div>
              <div class="tokens-note">Mint bearer tokens for mobile/admin REST clients. Plaintext is shown only once at creation time.</div>
            </div>
          </div>
          <form id="token-form" class="token-form">
            <div class="token-field">
              <label for="token-label">Label</label>
              <input id="token-label" name="label" type="text" placeholder="iPhone 16 Pro" maxlength="120" required />
            </div>
            <div class="token-field">
              <label for="token-ttl-days">TTL days</label>
              <input id="token-ttl-days" name="ttlDays" type="number" min="1" max="365" value="90" />
            </div>
            <div class="token-field">
              <label>Scopes</label>
              <div id="token-scopes" class="token-scopes"></div>
            </div>
            <div class="token-actions">
              <button type="submit">Create token</button>
            </div>
          </form>
          <div id="token-created" class="token-created" style="display:none;"></div>
          <div id="tokens-empty" class="token-empty">Loading tokens…</div>
          <table id="tokens-table" class="token-table" style="display:none;">
            <thead>
              <tr>
                <th>Label</th>
                <th>Scopes</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Last used</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody id="tokens-tbody"></tbody>
          </table>
        </section>
        <div id="server-picker-backdrop" class="server-picker-backdrop" aria-hidden="true">
          <div class="server-picker-modal" role="dialog" aria-modal="true" aria-labelledby="server-picker-title">
            <div id="server-picker-title" class="server-picker-title">Restart server action</div>
            <div id="server-picker-note" class="server-picker-note">Choose a server from the selected device inventory.</div>
            <div id="server-picker-list" class="server-picker-list"></div>
            <div class="server-picker-actions">
              <button id="server-picker-cancel" type="button">Cancel</button>
              <button id="server-picker-confirm" type="button" class="primary" disabled>Restart action</button>
            </div>
          </div>
        </div>
        <div id="remote-browser-backdrop" class="remote-browser-backdrop" aria-hidden="true">
          <div class="remote-browser-modal" role="dialog" aria-modal="true" aria-labelledby="remote-browser-title">
            <div>
              <div id="remote-browser-title" class="remote-browser-title">Remote browser</div>
              <div id="remote-browser-note" class="remote-browser-note">Browse remote files over CC and choose a path for future upload/download actions.</div>
            </div>
            <div class="remote-browser-toolbar">
              <button id="remote-browser-up" type="button">Up</button>
              <button id="remote-browser-refresh" type="button">Refresh</button>
              <button id="remote-browser-open-folder" type="button">Open selected folder</button>
              <input id="remote-browser-path" type="text" placeholder="/remote/path" />
              <button id="remote-browser-go" type="button">Go</button>
            </div>
            <div id="remote-browser-status" class="remote-browser-status">Choose a server to open the remote browser.</div>
            <div id="remote-browser-list" class="remote-browser-list"><div class="remote-browser-empty">No remote browser session open.</div></div>
            <div class="remote-browser-transfer">
              <div class="remote-browser-transfer-title">Transfer launch</div>
              <div class="remote-browser-transfer-grid">
                <div class="remote-browser-transfer-field">
                  <label for="transfer-local-path">Local path</label>
                  <input id="transfer-local-path" type="text" placeholder="/local/path or C:\\path\\file" />
                </div>
                <div class="remote-browser-transfer-field">
                  <label for="transfer-remote-path">Remote path</label>
                  <input id="transfer-remote-path" type="text" placeholder="/remote/path" />
                </div>
                <div class="remote-browser-transfer-field">
                  <label for="transfer-overwrite-policy">If destination exists</label>
                  <select id="transfer-overwrite-policy">
                    <option value="prompt">Ask / fail with guidance</option>
                    <option value="force">Overwrite existing destination</option>
                    <option value="skip">Skip transfer if destination exists</option>
                  </select>
                </div>
                <div class="remote-browser-transfer-field">
                  <label for="transfer-rate-limit">Rate limit KB/s</label>
                  <input id="transfer-rate-limit" type="number" min="1" step="1" placeholder="optional" />
                </div>
              </div>
              <div class="remote-browser-transfer-options">
                <label><input id="transfer-recursive" type="checkbox" /> Recursive</label>
                <label><input id="transfer-verify-checksum" type="checkbox" /> Verify checksum</label>
                <label><input id="transfer-follow-symlinks" type="checkbox" /> Follow symlinks</label>
                <label><input id="transfer-preserve-mtime" type="checkbox" /> Preserve mtime</label>
                <label><input id="transfer-preserve-mode" type="checkbox" /> Preserve mode</label>
              </div>
              <div class="remote-browser-transfer-buttons">
                <button id="remote-browser-fill-selected" type="button">Use selected for remote path</button>
                <button id="remote-browser-fill-current" type="button">Use current folder for remote path</button>
                <button id="remote-browser-start-upload" type="button" class="primary">Start upload</button>
                <button id="remote-browser-start-download" type="button">Start download</button>
              </div>
              <div class="remote-browser-transfer-hint">You can start a transfer either from the browser selection or by typing paths manually. If the destination already exists, choose how to handle it in “If destination exists”.</div>
            </div>
            <div class="remote-browser-actions">
              <div class="group">
                <button id="remote-browser-new-folder" type="button">New folder</button>
                <button id="remote-browser-delete" type="button">Delete selected</button>
              </div>
              <div class="group">
                <button id="remote-browser-use-current" type="button">Use current folder</button>
                <button id="remote-browser-use-selected" type="button" class="primary">Use selected path</button>
                <button id="remote-browser-close" type="button">Close</button>
              </div>
            </div>
          </div>
        </div>
        <section class="logs-panel">
          <div class="logs-toolbar">
            <div>
              <div class="logs-title">Telemetry</div>
              <div id="logs-status" class="logs-status">Select a device to stream logs.</div>
            </div>
            <div class="logs-controls">
              <select id="logs-type-filter">
                <option value="">All event types</option>
                <option value="function-status">function-status</option>
                <option value="pty-output">pty-output</option>
                <option value="pty-exit">pty-exit</option>
                <option value="openvpn-log">openvpn-log</option>
                <option value="inventory">inventory</option>
                <option value="recent_logs">recent_logs</option>
              </select>
              <input id="logs-function-filter" type="text" placeholder="Function ID" />
              <input id="logs-text-filter" type="text" placeholder="Search text" />
              <button id="logs-apply-filters" type="button">Apply filters</button>
              <button id="logs-export" type="button">Export</button>
              <button id="logs-clear" type="button">Clear</button>
              <button id="logs-pause-toggle" type="button">Pause</button>
              <label><input id="logs-autoscroll-toggle" type="checkbox" checked /> Auto-scroll</label>
            </div>
          </div>
          <div id="logs-output" class="logs-output"><span class="logs-empty">No device selected.</span></div>
        </section>
        <script src="/admin/assets/xterm.min.js"></script>
        <script>
          let selectedDeviceId = null;
          let stream = null;
          let currentDevices = [];
          let deviceSummary = {};
          let reconnectTimer = null;
          let streamConnectVersion = 0;
          let isPaused = false;
          let retentionSettings = null;
          let selectedSummary = null;
          let currentAdminApiTokens = [];
          let selectedTunnelRestartServerId = null;
          let serverPickerAction = null;
          let serverPickerSubmitting = false;
          let currentBrowserSessionId = null;
          let currentBrowserServerId = null;
          let currentBrowserRootPath = null;
          let currentBrowserCurrentPath = null;
          let currentBrowserSelectedPath = null;
          let currentBrowserSelectedEntry = null;
          let currentBrowserEntries = [];
          let selectedCommandId = null;
          let currentCommands = [];
          let currentTransfers = [];
          let transferStream = null;
          let transferStreamDeviceId = null;
          let transferStreamConnectVersion = 0;
          let ptySocket = null;
          let currentPtySessions = [];
          let currentPtySessionId = null;
          let currentPtyAttached = false;
          let ptyReconnectTimer = null;
          let suppressNextPtyReconnect = false;
          const ptyOutputBuffers = new Map();
          let ptyTerminal = null;
          let ptyTerminalInputBound = false;
          const STALE_DEVICE_MS = 2 * 60 * 1000;
          const STALE_FUNCTION_MS = 5 * 60 * 1000;
          const csrfToken = ${JSON.stringify(csrfToken)};
          const adminApiScopes = ${JSON.stringify(ADMIN_API_TOKEN_SCOPES)};

          function debugPty(...args) {
            console.debug('[PTY-debug]', ...args);
          }

          function setTopbarPage(page) {
            Array.from(document.querySelectorAll('.topbar-nav button[data-page]')).forEach((button) => {
              button.classList.toggle('active', button.dataset.page === page);
            });
          }

          function openConfigView() {
            setTopbarPage('config');
            document.getElementById('token-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }

          function openDevicesView() {
            setTopbarPage('devices');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }

          function escapeHtml(value) {
            return String(value)
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;')
              .replaceAll('"', '&quot;')
              .replaceAll("'", '&#39;');
          }

function renderRows(devices) {
            if (!devices.length) {
              return '<tr><td colspan="6" style="text-align:center;color:#868e96;padding:32px;">No devices enrolled</td></tr>';
            }
            return devices.map((device) => {
              const isAlert = device.status === 'disconnected' || isDeviceStale(device);
              const statusClass = isAlert ? 'error' : (device.status === 'connected' ? 'connected' : 'disconnected');
              const summary = deviceSummary[device.id] || {};
              const functions = summary.functions || {};
              const fnDots = ['openvpn-connect', 'boundary-auth', 'server-tunnel', 'server-ssh'].map(fnId => {
                const fn = functions[fnId];
                if (!fn) return '<span class="fn-dot"></span>';
                if (fn.state === 'error') return '<span class="fn-dot error" title="' + fnId + ': error"></span>';
                if (fn.state === 'running') return '<span class="fn-dot running" title="' + fnId + ': running"></span>';
                return '<span class="fn-dot"></span>';
              }).join('');
              const row = [
                '<tr data-device-id="' + escapeHtml(device.id) + '" class="' + (selectedDeviceId === device.id ? 'selected' : '') + ' ' + (isAlert ? 'alert-row' : '') + '">',
                '<td><span class="device-status"><span class="status-dot ' + statusClass + '"></span></span></td>',
                '<td class="device-name">' + escapeHtml(device.name) + '</td>',
                '<td class="last-seen">' + formatRelativeTime(device.lastSeenAt) + '</td>',
                '<td><div class="functions-dots">' + fnDots + '</div></td>',
                '<td class="actions-dropdown">',
                '<button class="actions-btn" data-device="' + escapeHtml(device.id) + '">Actions ▼</button>',
                '<div class="actions-menu" id="actions-' + escapeHtml(device.id) + '">',
                '<button data-action="view">View details</button>',
                '<button data-action="snapshot">Request snapshot</button>',
                '<button data-action="logs">View logs</button>',
                '<button data-action="config">Config</button>',
                '</div>',
                '</td>',
                '</tr>',
              ].join('');
              return row;
            }).join('');
          }

          function renderMeta(devices) {
            const connected = devices.filter((device) => device.status === 'connected').length;
            const retention = retentionSettings
              ? ' | Retention: ' + retentionSettings.maxEventsPerDevice + ' events/device, ' + retentionSettings.maxAgeDays + ' day(s)'
              : '';
            return 'Total devices: ' + devices.length + ' | Connected: ' + connected + ' | Last updated: ' + new Date().toISOString() + retention;
          }

          function formatRelativeTime(value) {
            if (!value) return 'Never';
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return String(value);
            const diffMs = Date.now() - date.getTime();
            const diffMins = Math.floor(diffMs / 60000);
            if (diffMins < 1) return 'just now';
            if (diffMins < 60) return diffMins + 'm ago';
            const diffHours = Math.floor(diffMins / 60);
            if (diffHours < 24) return diffHours + 'h ago';
            const diffDays = Math.floor(diffHours / 24);
            if (diffDays < 7) return diffDays + 'd ago';
            return date.toLocaleDateString();
          }

          function formatDateTime(value) {
            if (!value) {
              return 'Never';
            }
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
          }

          function formatBytes(value) {
            const bytes = Number(value);
            if (!Number.isFinite(bytes) || bytes < 0) {
              return '0 B';
            }
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let unitIndex = 0;
            let current = bytes;
            while (current >= 1024 && unitIndex < units.length - 1) {
              current /= 1024;
              unitIndex += 1;
            }
            return current.toFixed(current >= 10 || unitIndex === 0 ? 0 : 1) + ' ' + units[unitIndex];
          }

          function formatRate(value) {
            const bytesPerSecond = Number(value);
            if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
              return '-';
            }
            return formatBytes(bytesPerSecond) + '/s';
          }

          function formatEta(value) {
            const seconds = Number(value);
            if (!Number.isFinite(seconds) || seconds < 0) {
              return '-';
            }
            if (seconds < 60) {
              return Math.round(seconds) + 's';
            }
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = Math.round(seconds % 60);
            if (minutes < 60) {
              return minutes + 'm ' + remainingSeconds + 's';
            }
            const hours = Math.floor(minutes / 60);
            const remainingMinutes = minutes % 60;
            return hours + 'h ' + remainingMinutes + 'm';
          }

          function formatReasonCode(value) {
            const code = String(value || '').trim();
            if (!code) {
              return 'unknown_error';
            }
            return code;
          }

          function humanizeReasonCode(value) {
            const code = formatReasonCode(value);
            switch (code) {
              case 'tunnel_not_running':
                return 'Boundary tunnel is not running.';
              case 'path_not_found':
                return 'The selected path does not exist.';
              case 'path_already_exists':
                return 'The destination path already exists.';
              case 'overwrite_declined':
                return 'Overwrite was declined.';
              case 'invalid_target_path':
                return 'The target path is invalid.';
              case 'invalid_source_path':
                return 'The source path is invalid.';
              case 'permission_denied':
                return 'Permission was denied.';
              case 'rate_limited':
                return 'The request was rate limited.';
              case 'checksum_mismatch':
                return 'Checksum verification failed.';
              case 'transfer_timeout':
                return 'The transfer timed out.';
              case 'resume_not_supported':
                return 'Resume is not supported for this transfer.';
              case 'browser_session_closed':
                return 'The remote browser session is closed.';
              case 'agent_error':
                return 'The agent reported an internal error.';
              default:
                return code.replaceAll('_', ' ');
            }
          }

          function defaultActionHintForReasonCode(value) {
            const code = formatReasonCode(value);
            switch (code) {
              case 'tunnel_not_running':
                return 'Start the Boundary tunnel on the device, then retry.';
              case 'path_already_exists':
                return 'Choose another destination or confirm overwrite with force.';
              case 'overwrite_declined':
                return 'Retry with overwrite force or choose a different target path.';
              case 'rate_limited':
                return 'Wait briefly, then retry.';
              case 'browser_session_closed':
                return 'Reopen the remote browser session and retry.';
              default:
                return '';
            }
          }

          function parseApiErrorPayload(payload) {
            if (!payload || typeof payload !== 'object') {
              return null;
            }
            if (payload.type === 'nack' && payload.payload && typeof payload.payload === 'object') {
              return payload.payload;
            }
            if ('payload' in payload && payload.payload && typeof payload.payload === 'object') {
              return payload.payload;
            }
            return payload;
          }

          function describeApiError(error) {
            const fallback = {
              code: 'request_failed',
              message: error && error.message ? String(error.message) : 'Request failed.',
              detail: '',
              retryAfterMs: null,
              actionHint: '',
            };
            if (!error || typeof error !== 'object') {
              return fallback;
            }
            const payload = parseApiErrorPayload(error.payload);
            const code = formatReasonCode(
              (payload && (payload.reasonCode || payload.code || payload.error))
              || error.code
              || 'request_failed',
            );
            const retryAfterMs = payload && payload.retryAfterMs != null ? Number(payload.retryAfterMs) : null;
            const actionHint = payload && payload.actionHint
              ? String(payload.actionHint)
              : defaultActionHintForReasonCode(code);
            const detail = payload && payload.message
              ? String(payload.message)
              : payload && payload.reasonDetail
                ? String(payload.reasonDetail)
                : '';
            const retryText = code === 'rate_limited' && Number.isFinite(retryAfterMs)
              ? ' Retry after ' + retryAfterMs + 'ms.'
              : '';
            const detailText = detail ? ' ' + detail : '';
            const hintText = actionHint ? ' ' + actionHint : '';
            return {
              code,
              message: humanizeReasonCode(code) + detailText + retryText + hintText,
              detail,
              retryAfterMs,
              actionHint,
            };
          }

          async function fetchJsonOrThrow(url, options) {
            const timeoutMs = options && Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 35_000;
            const fetchOptions = options ? { ...options } : {};
            delete fetchOptions.timeoutMs;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            if (fetchOptions.signal) {
              fetchOptions.signal.addEventListener('abort', () => controller.abort(), { once: true });
            }
            fetchOptions.signal = controller.signal;
            let response;
            try {
              response = await fetch(url, fetchOptions);
            } catch (error) {
              clearTimeout(timer);
              if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError') {
                throw describeApiError({
                  code: 'request_timeout',
                  message: 'Request timed out after ' + timeoutMs + 'ms',
                  payload: { timeoutMs },
                });
              }
              throw error;
            }
            clearTimeout(timer);
            const raw = await response.text();
            let payload = null;
            if (raw) {
              try {
                payload = JSON.parse(raw);
              } catch (parseError) {
                payload = null;
              }
            }
            if (!response.ok) {
              const described = describeApiError({
                code: payload && typeof payload === 'object' ? payload.code : null,
                payload,
                message: raw || response.statusText,
              });
              throw described;
            }
            return payload;
          }

          function setTransferRemotePath(value) {
            document.getElementById('transfer-remote-path').value = value || '';
          }

          function getTransferRemotePath() {
            return document.getElementById('transfer-remote-path').value.trim();
          }

          function getTransferLocalPath() {
            return document.getElementById('transfer-local-path').value.trim();
          }

          function getTransferOptions() {
            const rateLimitRaw = document.getElementById('transfer-rate-limit').value.trim();
            return {
              overwritePolicy: document.getElementById('transfer-overwrite-policy').value || 'prompt',
              recursive: !!document.getElementById('transfer-recursive').checked,
              verifyChecksum: !!document.getElementById('transfer-verify-checksum').checked,
              followSymlinks: !!document.getElementById('transfer-follow-symlinks').checked,
              preserveMtime: !!document.getElementById('transfer-preserve-mtime').checked,
              preserveMode: !!document.getElementById('transfer-preserve-mode').checked,
              rateLimitKbps: rateLimitRaw ? Number(rateLimitRaw) : null,
            };
          }

          function setTransferOverwritePolicy(value) {
            const select = document.getElementById('transfer-overwrite-policy');
            if (select) {
              select.value = value || 'prompt';
            }
          }

          function renderTokenScopes(scopes) {
            if (!Array.isArray(scopes) || !scopes.length) {
              return '<span class="token-empty">No scopes</span>';
            }
            return '<div class="token-scope-list">' + scopes.map((scope) =>
              '<span class="token-scope-pill">' + escapeHtml(scope) + '</span>'
            ).join('') + '</div>';
          }

          function renderTokenRows(tokens) {
            if (!tokens.length) {
              return '';
            }
            return tokens.map((token) => {
              const revoked = !!token.revokedAt;
              return '<tr>' +
                '<td>' + escapeHtml(token.label) + '<div style="color:#6b7280;margin-top:4px;">' + escapeHtml(token.tokenId) + '</div></td>' +
                '<td>' + renderTokenScopes(token.scopes) + '</td>' +
                '<td>' + escapeHtml(formatDateTime(token.createdAt)) + '</td>' +
                '<td>' + escapeHtml(formatDateTime(token.expiresAt)) + '</td>' +
                '<td>' + escapeHtml(formatDateTime(token.lastUsedAt)) + '</td>' +
                '<td><span class="token-status ' + (revoked ? 'revoked' : 'active') + '">' + (revoked ? 'Revoked' : 'Active') + '</span></td>' +
                '<td><button type="button" data-token-id="' + escapeHtml(token.tokenId) + '"' + (revoked ? ' disabled' : '') + '>Revoke</button></td>' +
              '</tr>';
            }).join('');
          }

          function renderTokenScopeOptions() {
            const container = document.getElementById('token-scopes');
            container.innerHTML = adminApiScopes.map((scope) =>
              '<label><input type="checkbox" name="scope" value="' + escapeHtml(scope) + '"' +
                (scope === 'device:read' || scope === 'device:control' || scope === 'logs:read' ? ' checked' : '') +
              ' /> ' + escapeHtml(scope) + '</label>'
            ).join('');
          }

          function getSelectedTokenScopes() {
            return Array.from(document.querySelectorAll('#token-scopes input[name=\"scope\"]:checked'))
              .map((input) => input.value);
          }

          function showCreatedToken(payload) {
            const container = document.getElementById('token-created');
            container.style.display = 'block';
            container.innerHTML =
              '<strong>Store this token now.</strong>' +
              '<div style="margin-bottom:8px;">Label: ' + escapeHtml(payload.label) + ' | Expires: ' + escapeHtml(formatDateTime(payload.expiresAt)) + '</div>' +
              '<div class="token-secret" id="token-secret-value">' + escapeHtml(payload.token) + '</div>' +
              '<button type="button" id="copy-token-btn" style="margin-top:8px;padding:6px 12px;background:#374151;color:white;border:none;border-radius:4px;cursor:pointer;">Copy token</button>' +
              '<span id="copy-token-msg" style="margin-left:8px;color:#059669;font-size:12px;display:none;">Copied!</span>';
            
            document.getElementById('copy-token-btn').addEventListener('click', async () => {
              try {
                await navigator.clipboard.writeText(payload.token);
                document.getElementById('copy-token-msg').style.display = 'inline';
                setTimeout(() => {
                  document.getElementById('copy-token-msg').style.display = 'none';
                }, 2000);
              } catch (e) {
                console.error('Failed to copy', e);
              }
            });
          }

          function renderAdminApiTokens(tokens) {
            currentAdminApiTokens = tokens;
            const empty = document.getElementById('tokens-empty');
            const table = document.getElementById('tokens-table');
            const body = document.getElementById('tokens-tbody');
            if (!tokens.length) {
              table.style.display = 'none';
              empty.style.display = 'block';
              empty.textContent = 'No admin API tokens have been created yet.';
              body.innerHTML = '';
              return;
            }
            body.innerHTML = renderTokenRows(tokens);
            empty.style.display = 'none';
            table.style.display = 'table';
          }

          async function refreshAdminApiTokens() {
            try {
              const response = await fetch('/admin/api-tokens');
              if (!response.ok) {
                throw new Error('Failed to load tokens');
              }
              renderAdminApiTokens(await response.json());
            } catch (error) {
              document.getElementById('tokens-empty').style.display = 'block';
              document.getElementById('tokens-empty').textContent = 'Failed to load admin API tokens.';
              document.getElementById('tokens-table').style.display = 'none';
            }
          }

          async function createAdminApiToken() {
            const label = document.getElementById('token-label').value.trim();
            const ttlDays = Number(document.getElementById('token-ttl-days').value);
            const scopes = getSelectedTokenScopes();
            const response = await fetch('/admin/api-tokens', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ csrfToken, label, ttlDays, scopes }),
            });
            if (!response.ok) {
              throw new Error(await response.text());
            }
            return response.json();
          }

          async function revokeAdminApiToken(tokenId) {
            const response = await fetch('/admin/api-tokens/' + encodeURIComponent(tokenId) + '/revoke', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ csrfToken }),
            });
            if (!response.ok) {
              throw new Error(await response.text());
            }
            return response.json();
          }

          async function refreshRetentionSettings() {
            try {
              const response = await fetch('/v1/log-settings');
              if (!response.ok) {
                return;
              }
              retentionSettings = await response.json();
              if (currentDevices.length) {
                document.getElementById('devices-meta').textContent = renderMeta(currentDevices);
              }
            } catch (error) {
              console.error('Failed to refresh log settings', error);
            }
          }

          function sortPtySessions(items) {
            return Array.isArray(items)
              ? items.slice().sort((a, b) => parseTimeMs(b && b.openedAt) - parseTimeMs(a && a.openedAt))
              : [];
          }

          function getSelectedPtySession() {
            return currentPtySessions.find((item) => item.sessionId === currentPtySessionId) || null;
          }

          function isAdminSessionAttached(session) {
            return !!session && session.attachedActorType === 'admin_session';
          }

          function setPtyStatus(message, isError = false) {
            const node = document.getElementById('pty-status');
            node.textContent = message;
            node.classList.toggle('error', !!isError);
          }

          function sanitizePtyDisplayText(value) {
            if (value == null) {
              return '';
            }
            const text = String(value);
            const esc = String.fromCharCode(27);
            const bell = String.fromCharCode(7);
            const oscPattern = new RegExp(
              esc + '\\\\][^' + bell + esc + ']*(?:' + bell + '|' + esc + '\\\\\\\\)',
              'g',
            );
            const csiPattern = new RegExp(esc + '\\\\[[0-9;?]*[ -/]*[@-~]', 'g');
            const withoutAnsi = text.replace(oscPattern, '').replace(csiPattern, '');
            let cleaned = '';
            for (const ch of withoutAnsi) {
              const code = ch.charCodeAt(0);
              if ((code >= 0 && code <= 8) || (code >= 11 && code <= 26) || (code >= 28 && code <= 31) || code === 127) {
                continue;
              }
              cleaned += ch;
            }
            return cleaned;
          }

          function getPtyTerminal() {
            if (ptyTerminal || !window.Terminal) {
              debugPty('getPtyTerminal reuse/missing', {
                hasTerminal: !!ptyTerminal,
                windowTerminal: typeof window.Terminal,
              });
              return ptyTerminal;
            }
            const container = document.getElementById('pty-output');
            if (!container) {
              debugPty('getPtyTerminal missing container');
              return null;
            }
	            container.textContent = '';
	            container.classList.remove('empty');
	            container.tabIndex = 0;
	            ptyTerminal = new window.Terminal({
	              convertEol: true,
	              disableStdin: false,
	              cursorBlink: true,
	              cursorStyle: 'block',
	              fontSize: 12,
	              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              theme: {
                background: '#030712',
                foreground: '#e5e7eb',
	              },
	            });
	            ptyTerminal.open(container);
              debugPty('xterm created', {
                sessionId: currentPtySessionId,
                containerClass: container.className,
              });
	            if (!ptyTerminalInputBound) {
	              ptyTerminal.onData((data) => {
                  debugPty('xterm onData', {
                    sessionId: currentPtySessionId,
                    length: typeof data === 'string' ? data.length : null,
                    preview: typeof data === 'string' ? JSON.stringify(data.slice(0, 20)) : null,
                  });
	                void sendTerminalData(data);
	              });
	              ptyTerminalInputBound = true;
	            }
	            container.addEventListener('mousedown', () => {
                debugPty('terminal mouse focus', {
                  sessionId: currentPtySessionId,
                  attached: isAdminSessionAttached(getSelectedPtySession()),
                });
	              if (isAdminSessionAttached(getSelectedPtySession())) {
	                ptyTerminal.focus();
                  debugPty('terminal focused from mouse');
	              }
	            });
	            return ptyTerminal;
	          }

	          async function sendTerminalData(data) {
	            const session = getSelectedPtySession();
	            if (!selectedDeviceId || !session || !isAdminSessionAttached(session) || !data) {
                debugPty('sendTerminalData skipped', {
                  selectedDeviceId,
                  sessionId: session && session.sessionId,
                  attached: isAdminSessionAttached(session),
                  hasData: !!data,
                });
	              return;
	            }
            if (session.recordingEnabled && !session.recordingConsentAt) {
              debugPty('sendTerminalData blocked pending recording consent', {
                sessionId: session.sessionId,
              });
              setPtyStatus('Acknowledge recording before sending PTY input.', true);
              return;
            }
	            try {
                debugPty('sendTerminalData outbound', {
                  deviceId: selectedDeviceId,
                  sessionId: session.sessionId,
                  length: data.length,
                  preview: JSON.stringify(String(data).slice(0, 20)),
                });
	              await sendPtyMessage('pty_write', {
	                deviceId: selectedDeviceId,
	                sessionId: session.sessionId,
	                data,
	              });
	            } catch (error) {
	              setPtyStatus('Failed to write PTY input.', true);
	            }
	          }

          function syncPtySizeInputs(session) {
            const colsInput = document.getElementById('pty-cols');
            const rowsInput = document.getElementById('pty-rows');
            if (!colsInput || !rowsInput || !session) {
              return;
            }
            if (Number.isInteger(session.cols) && session.cols > 0) {
              colsInput.value = String(session.cols);
            }
            if (Number.isInteger(session.rows) && session.rows > 0) {
              rowsInput.value = String(session.rows);
            }
          }

          function applyPtyTerminalSize(session) {
            if (!session) {
              return;
            }
            const terminal = getPtyTerminal();
            if (!terminal) {
              return;
            }
            const cols = Number(session.cols);
            const rows = Number(session.rows);
            if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
              return;
            }
            if (terminal.cols !== cols || terminal.rows !== rows) {
              terminal.resize(cols, rows);
              debugPty('xterm resized', {
                sessionId: session.sessionId,
                cols,
                rows,
              });
            }
          }

          function setPtyOutput(sessionId, text) {
            if (!sessionId) {
              return;
            }
            ptyOutputBuffers.set(sessionId, String(text || ''));
            if (currentPtySessionId === sessionId) {
              renderPtyOutput();
            }
          }

          function appendPtyOutput(sessionId, chunk) {
            if (!sessionId || typeof chunk !== 'string' || !chunk.length) {
              return;
            }
            const nextValue = (ptyOutputBuffers.get(sessionId) || '') + chunk;
            ptyOutputBuffers.set(sessionId, nextValue);
            if (currentPtySessionId === sessionId) {
              const terminal = getPtyTerminal();
              if (terminal) {
                terminal.write(chunk);
              } else {
                renderPtyOutput();
                const output = document.getElementById('pty-output');
                output.scrollTop = output.scrollHeight;
              }
            }
          }

	          function renderPtyOutput() {
	            const output = document.getElementById('pty-output');
	            const value = currentPtySessionId ? (ptyOutputBuffers.get(currentPtySessionId) || '') : '';
              debugPty('renderPtyOutput', {
                sessionId: currentPtySessionId,
                hasValue: !!value,
                valueLength: value.length,
                windowTerminal: typeof window.Terminal,
              });
	            if (!value) {
	              const terminal = currentPtySessionId ? getPtyTerminal() : ptyTerminal;
	              if (terminal) {
	                output.classList.toggle('empty', !currentPtySessionId);
	                terminal.reset();
	                if (!currentPtySessionId) {
	                  terminal.write('No PTY output yet.');
	                }
	                return;
	              }
	              output.textContent = currentPtySessionId ? 'No PTY output yet for this session.' : 'No PTY output yet.';
	              output.classList.toggle('empty', !currentPtySessionId);
	              return;
	            }
            const terminal = getPtyTerminal();
            if (terminal) {
              output.classList.remove('empty');
              terminal.reset();
              terminal.write(value);
              return;
            }
            output.textContent = sanitizePtyDisplayText(value);
            output.classList.remove('empty');
          }

          function renderPtySessionSelect() {
            const select = document.getElementById('pty-session-select');
            if (!selectedDeviceId) {
              select.innerHTML = '<option value="">No device selected</option>';
              select.disabled = true;
              return;
            }
            if (!currentPtySessions.length) {
              select.innerHTML = '<option value="">No PTY sessions yet</option>';
              select.disabled = true;
              return;
            }
            select.innerHTML = '<option value="">Choose a PTY session</option>' + currentPtySessions.map((session) => {
              const selected = session.sessionId === currentPtySessionId ? ' selected' : '';
              const attached = session.attachedActorType ? ' | attached' : '';
              return '<option value="' + escapeHtml(session.sessionId) + '"' + selected + '>' +
                escapeHtml(session.sessionId + ' | ' + session.state + attached + ' | ' + formatDateTime(session.openedAt)) +
              '</option>';
            }).join('');
            select.disabled = false;
          }

          function renderPtySessionMeta() {
            const note = document.getElementById('pty-note');
            const meta = document.getElementById('pty-session-meta');
            const privacy = document.getElementById('pty-privacy');
            if (!selectedDeviceId) {
              note.textContent = 'Select a device to inspect or open a PTY session. Open terminal creates and attaches a new PTY; Attach reconnects to the selected session.';
              meta.textContent = 'No PTY session selected.';
              privacy.textContent = 'Recording is enabled for this PTY session.';
              privacy.classList.add('hidden');
              return;
            }
            note.textContent = 'Live terminal for device ' + selectedDeviceId + '. Open terminal creates and attaches a new PTY; Reattach reconnects to the selected session only.';
            const session = getSelectedPtySession();
            if (!session) {
              meta.textContent = currentPtySessions.length
                ? 'Choose a PTY session to attach or inspect its state.'
                : 'No PTY sessions stored for this device yet.';
              privacy.textContent = 'Recording is enabled for this PTY session.';
              privacy.classList.add('hidden');
              return;
            }
            const attachment = session.attachedActorType
              ? 'attached via ' + session.attachedActorType + (session.attachedActorId ? ' (' + session.attachedActorId + ')' : '')
              : 'detached';
            const recordingText = session.recordingEnabled
              ? ' | Recording: enabled'
              : ' | Recording: off';
            meta.textContent = 'State: ' + session.state + ' | Opened: ' + formatDateTime(session.openedAt) + ' | ' + attachment + recordingText;
            if (session.recordingEnabled) {
              privacy.textContent = session.recordingConsentAt
                ? 'Recording enabled. Consent captured at ' + formatDateTime(session.recordingConsentAt) + '.'
                : 'Recording enabled. Privacy-sensitive PTY activity may be captured for this session.';
              privacy.classList.remove('hidden');
            } else {
              privacy.textContent = 'Recording is enabled for this PTY session.';
              privacy.classList.add('hidden');
            }
          }

	          function updatePtyControls() {
	            const hasDevice = !!selectedDeviceId;
	            const session = getSelectedPtySession();
	            const hasSession = !!session;
	            const attachedByAdminSession = isAdminSessionAttached(session);
	            const deletable = !!session && ['closed', 'expired', 'failed'].includes(session.state);
	            const output = document.getElementById('pty-output');
	            document.getElementById('pty-refresh-sessions').disabled = !hasDevice;
	            document.getElementById('pty-open').disabled = !hasDevice;
	            document.getElementById('pty-attach').disabled = !hasDevice || !hasSession || (session.openedByActorType && session.openedByActorType !== 'admin_session');
	            document.getElementById('pty-resize').disabled = !hasDevice || !hasSession || !attachedByAdminSession;
	            document.getElementById('pty-detach').disabled = !hasDevice || !hasSession || !attachedByAdminSession;
	            document.getElementById('pty-close').disabled = !hasDevice || !hasSession || !attachedByAdminSession;
	            document.getElementById('pty-delete').disabled = !hasDevice || !deletable;
	            document.getElementById('pty-send-ctrl-c').disabled = !hasDevice || !hasSession || !attachedByAdminSession || !!(session && session.recordingEnabled && !session.recordingConsentAt);
	            document.getElementById('pty-recording-consent').disabled = !hasDevice || !hasSession || !attachedByAdminSession || !session.recordingEnabled || !!session.recordingConsentAt;
	            output.classList.toggle('attached', !!attachedByAdminSession);
	          }

          function syncPtySelectionState() {
            const session = getSelectedPtySession();
            currentPtyAttached = isAdminSessionAttached(session);
            renderPtySessionSelect();
            renderPtySessionMeta();
            syncPtySizeInputs(session);
            renderPtyOutput();
            applyPtyTerminalSize(session);
            updatePtyControls();
          }

          async function loadPtySessions(deviceId, options = {}) {
            const { preserveSelection = true } = options;
            if (!deviceId) {
              currentPtySessions = [];
              currentPtySessionId = null;
              currentPtyAttached = false;
              syncPtySelectionState();
              return [];
            }
            const response = await fetch('/v1/devices/' + encodeURIComponent(deviceId) + '/pty-sessions');
            if (!response.ok) {
              throw new Error('Failed to load PTY sessions');
            }
            const payload = await response.json();
            currentPtySessions = sortPtySessions(payload && payload.items);
            if (!preserveSelection || !currentPtySessions.some((item) => item.sessionId === currentPtySessionId)) {
              currentPtySessionId = currentPtySessions.length ? currentPtySessions[0].sessionId : null;
            }
            syncPtySelectionState();
            return currentPtySessions;
          }

          function clearPtySelection() {
            currentPtySessions = [];
            currentPtySessionId = null;
            currentPtyAttached = false;
            syncPtySelectionState();
          }

          function clearPtyReconnectTimer() {
            if (ptyReconnectTimer) {
              window.clearTimeout(ptyReconnectTimer);
              ptyReconnectTimer = null;
            }
          }

          function schedulePtyReconnect() {
            if (suppressNextPtyReconnect || !selectedDeviceId) {
              suppressNextPtyReconnect = false;
              return;
            }
            clearPtyReconnectTimer();
            ptyReconnectTimer = window.setTimeout(async () => {
              try {
                await connectPtySocket();
                const session = getSelectedPtySession();
                if (session && isAdminSessionAttached(session)) {
                  await sendPtyMessage('pty_attach', {
                    deviceId: selectedDeviceId,
                    sessionId: session.sessionId,
                  });
                  setPtyStatus('Reattaching to PTY session ' + session.sessionId + '…');
                } else {
                  setPtyStatus('PTY websocket reconnected.');
                }
              } catch (error) {
                setPtyStatus('PTY websocket reconnect failed. Retrying…', true);
                schedulePtyReconnect();
              }
            }, 1500);
          }

          function closePtySocket(options = {}) {
            const { suppressReconnect = false } = options;
            clearPtyReconnectTimer();
            suppressNextPtyReconnect = suppressReconnect;
            if (ptySocket) {
              try {
                ptySocket.close();
              } catch (error) {
                console.error('Failed to close PTY websocket', error);
              }
              ptySocket = null;
            }
          }

          function buildPtyWebSocketUrl() {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            return protocol + '//' + window.location.host + '/admin/ws/pty';
          }

          async function connectPtySocket() {
            if (ptySocket && (ptySocket.readyState === WebSocket.OPEN || ptySocket.readyState === WebSocket.CONNECTING)) {
              if (ptySocket.readyState === WebSocket.OPEN) {
                return ptySocket;
              }
              await new Promise((resolve, reject) => {
                const onOpen = () => {
                  ptySocket.removeEventListener('open', onOpen);
                  ptySocket.removeEventListener('error', onError);
                  resolve();
                };
                const onError = () => {
                  ptySocket.removeEventListener('open', onOpen);
                  ptySocket.removeEventListener('error', onError);
                  reject(new Error('Failed to connect PTY websocket'));
                };
                ptySocket.addEventListener('open', onOpen, { once: true });
                ptySocket.addEventListener('error', onError, { once: true });
              });
              return ptySocket;
            }

            ptySocket = new WebSocket(buildPtyWebSocketUrl());
            setPtyStatus('Connecting PTY websocket…');

            ptySocket.addEventListener('open', () => {
              clearPtyReconnectTimer();
              suppressNextPtyReconnect = false;
              setPtyStatus('PTY websocket connected.');
            });
            ptySocket.addEventListener('message', async (event) => {
              try {
                const envelope = JSON.parse(event.data);
                const type = envelope && envelope.type;
                const payload = envelope && typeof envelope.payload === 'object' ? envelope.payload : {};
                if (type === 'pty_state') {
                  if (payload.state === 'connected') {
                    setPtyStatus('PTY websocket connected.');
                  } else if (payload.warning) {
                    setPtyStatus(String(payload.warning), true);
                  } else if (payload.consentGranted && payload.sessionId) {
                    const session = currentPtySessions.find((item) => item.sessionId === payload.sessionId);
                    if (session) {
                      session.recordingConsentAt = payload.recordingConsentAt || new Date().toISOString();
                    }
                    setPtyStatus('Recording consent acknowledged for PTY session ' + payload.sessionId + '.');
                    syncPtySelectionState();
                    await loadPtySessions(selectedDeviceId, { preserveSelection: true }).catch(() => {});
                  } else if (payload.sessionId && payload.detached) {
                    setPtyStatus('Detached from PTY session ' + payload.sessionId + '.');
                    await loadPtySessions(selectedDeviceId, { preserveSelection: true }).catch(() => {});
                  }
                  return;
                }
	                if (type === 'pty_opened') {
	                  currentPtySessionId = typeof payload.sessionId === 'string' ? payload.sessionId : currentPtySessionId;
	                  if (currentPtySessionId && !ptyOutputBuffers.has(currentPtySessionId)) {
	                    ptyOutputBuffers.set(currentPtySessionId, '');
	                  }
	                  setPtyStatus('PTY session ' + currentPtySessionId + ' attached.');
	                  await loadPtySessions(selectedDeviceId, { preserveSelection: true }).catch(() => {});
	                  const terminal = getPtyTerminal();
	                  if (terminal) {
	                    terminal.focus();
	                  }
	                  return;
	                }
                if (type === 'pty_output') {
                  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
                  const data = typeof payload.data === 'string' ? payload.data : '';
                  if (payload.replay) {
                    const replayData = payload.truncated
                      ? '[scrollback truncated to recent output]\\n' + data
                      : data;
                    setPtyOutput(sessionId, replayData);
                    if (sessionId === currentPtySessionId) {
                      setPtyStatus(payload.truncated
                        ? 'Replayed truncated PTY scrollback for ' + sessionId + '.'
                        : 'Replayed recent PTY scrollback for ' + sessionId + '.');
                    }
                  } else {
                    appendPtyOutput(sessionId, data);
                    if (sessionId === currentPtySessionId) {
                      setPtyStatus('Streaming PTY output for ' + sessionId + '.');
                    }
                  }
                  return;
                }
                if (type === 'pty_exit') {
                  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
                  const reason = typeof payload.reason === 'string' && payload.reason ? ' (' + payload.reason + ')' : '';
                  const exitCode = payload.exitCode != null ? ' exit=' + payload.exitCode : '';
                  appendPtyOutput(sessionId, '\\n\\n[PTY exited' + exitCode + reason + ']\\n');
                  if (sessionId === currentPtySessionId) {
                    setPtyStatus('PTY session ' + sessionId + ' exited' + reason + '.');
                  }
                  await loadPtySessions(selectedDeviceId, { preserveSelection: true }).catch(() => {});
                  return;
                }
                if (type === 'pty_error') {
                  const code = payload && payload.code ? String(payload.code) : 'PTY_ERROR';
                  const message = payload && payload.message ? String(payload.message) : 'PTY action failed';
                  const retryAfterMs = payload && payload.retryAfterMs != null ? Number(payload.retryAfterMs) : null;
                  const suffix = payload && payload.rate_limited && retryAfterMs != null
                    ? ' Retry after ' + retryAfterMs + 'ms.'
                    : '';
                  setPtyStatus(code + ': ' + message + suffix, true);
                }
              } catch (error) {
                console.error('Failed to parse PTY websocket message', error);
              }
            });
            ptySocket.addEventListener('close', () => {
              ptySocket = null;
              currentPtyAttached = false;
              updatePtyControls();
              setPtyStatus('PTY websocket disconnected.', true);
              schedulePtyReconnect();
            });
            ptySocket.addEventListener('error', () => {
              setPtyStatus('PTY websocket error.', true);
            });

            await new Promise((resolve, reject) => {
              const socket = ptySocket;
              const onOpen = () => {
                socket.removeEventListener('open', onOpen);
                socket.removeEventListener('error', onError);
                resolve();
              };
              const onError = () => {
                socket.removeEventListener('open', onOpen);
                socket.removeEventListener('error', onError);
                reject(new Error('Failed to connect PTY websocket'));
              };
              socket.addEventListener('open', onOpen, { once: true });
              socket.addEventListener('error', onError, { once: true });
            });
            return ptySocket;
          }

          async function sendPtyMessage(type, payload) {
            const socket = await connectPtySocket();
            socket.send(JSON.stringify({ type, payload }));
          }

          async function detachCurrentPty(options = {}) {
            const { silent = false } = options;
            const session = getSelectedPtySession();
            if (!selectedDeviceId || !session || !isAdminSessionAttached(session)) {
              return;
            }
            try {
              await sendPtyMessage('pty_detach', {
                deviceId: selectedDeviceId,
                sessionId: session.sessionId,
              });
              if (!silent) {
                setPtyStatus('Detaching from PTY session ' + session.sessionId + '…');
              }
            } catch (error) {
              if (!silent) {
                setPtyStatus('Failed to detach PTY session.', true);
              }
            }
          }

          function getActiveFilters() {
            return {
              type: document.getElementById('logs-type-filter').value.trim(),
              functionId: document.getElementById('logs-function-filter').value.trim(),
              q: document.getElementById('logs-text-filter').value.trim(),
            };
          }

          function isAutoScrollEnabled() {
            return document.getElementById('logs-autoscroll-toggle').checked;
          }

          function clearReconnectTimer() {
            if (reconnectTimer) {
              window.clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
          }

          function closeStream() {
            clearReconnectTimer();
            if (stream) {
              stream.close();
              stream = null;
            }
          }

          function isAlertState(state) {
            return ['error', 'stopped', 'disconnected'].includes(String(state || '').toLowerCase());
          }

          function isWarningState(state) {
            return ['stopping'].includes(String(state || '').toLowerCase());
          }

          function parseTimeMs(value) {
            if (!value) {
              return null;
            }
            const time = Date.parse(String(value));
            return Number.isFinite(time) ? time : null;
          }

          function formatAge(ms) {
            if (ms == null || ms < 0) {
              return 'unknown age';
            }
            const totalSeconds = Math.floor(ms / 1000);
            if (totalSeconds < 60) {
              return totalSeconds + 's';
            }
            const totalMinutes = Math.floor(totalSeconds / 60);
            if (totalMinutes < 60) {
              return totalMinutes + 'm';
            }
            const totalHours = Math.floor(totalMinutes / 60);
            return totalHours + 'h';
          }

          function isDeviceStale(device) {
            const lastSeenMs = parseTimeMs(device && device.lastSeenAt);
            return lastSeenMs != null && (Date.now() - lastSeenMs) > STALE_DEVICE_MS;
          }

          function isFunctionStale(item) {
            const observedMs = parseTimeMs(item && item.observedAt);
            return observedMs != null && (Date.now() - observedMs) > STALE_FUNCTION_MS;
          }

          function renderAlerts() {
            const alerts = [];
            for (const device of currentDevices) {
              if (device.status === 'disconnected') {
                alerts.push({
                  severity: 'critical',
                  title: device.name || device.id,
                  text: 'Device is disconnected',
                });
              } else if (isDeviceStale(device)) {
                alerts.push({
                  severity: 'warning',
                  title: device.name || device.id,
                  text: 'Device has not updated for ' + formatAge(Date.now() - parseTimeMs(device.lastSeenAt)),
                });
              }
            }

            if (selectedSummary && selectedSummary.functions) {
              for (const item of Object.values(selectedSummary.functions)) {
                if (isAlertState(item.state)) {
                  alerts.push({
                    severity: 'critical',
                    title: item.functionId || 'unknown',
                    text: (item.message || item.state || 'Unhealthy state') + ' (selected device)',
                  });
                } else if (isFunctionStale(item)) {
                  alerts.push({
                    severity: 'warning',
                    title: item.functionId || 'unknown',
                    text: 'No update for ' + formatAge(Date.now() - parseTimeMs(item.observedAt)) + ' (selected device)',
                  });
                } else if (isWarningState(item.state)) {
                  alerts.push({
                    severity: 'warning',
                    title: item.functionId || 'unknown',
                    text: (item.message || item.state || 'Attention needed') + ' (selected device)',
                  });
                }
              }
            }

            const container = document.getElementById('alerts-content');
            container.innerHTML = alerts.length
              ? alerts.map((alert) =>
                  '<div class="alert-card ' + escapeHtml(alert.severity) + '">' +
                    '<strong>' + escapeHtml(alert.title) + '</strong><div>' + escapeHtml(alert.text) + '</div>' +
                  '</div>'
                ).join('')
              : '<div class="alert-empty">No active alerts.</div>';
          }

          function renderSummary(summary) {
            selectedSummary = summary;
            const meta = document.getElementById('summary-meta');
            const content = document.getElementById('summary-content');
            const functions = summary && summary.functions ? Object.values(summary.functions) : [];
            const inventory = summary ? summary.inventory : null;

            meta.textContent = summary && summary.updatedAt
              ? 'Last summary update: ' + summary.updatedAt
              : 'No persisted runtime summary yet.';

            const cards = [];
            if (inventory != null) {
              cards.push(
                '<div class="summary-card">' +
                  '<h3>Inventory</h3>' +
                  '<pre class="summary-pre">' + escapeHtml(formatPayload(inventory)) + '</pre>' +
                '</div>'
              );
            }

            for (const item of functions) {
              const fnId = item.functionId || 'unknown';
              const state = item.state || 'unknown';
              const message = item.message || '';
              const isAlert = isAlertState(state) || isWarningState(state) || isFunctionStale(item);
              cards.push(
                '<div class="summary-card ' + (isAlert ? 'alert' : '') + '">' +
                  '<h3>' + escapeHtml(fnId) + '<span class="summary-state ' + escapeHtml(state) + '">' + escapeHtml(state) + '</span></h3>' +
                  (message ? '<div class="summary-info">' + escapeHtml(message.substring(0, 60) + (message.length > 60 ? '...' : '')) + '</div>' : '') +
                  '<div class="summary-info">Observed: ' + escapeHtml(String(item.observedAt || summary.updatedAt || '-').substring(11, 19)) + '</div>' +
                '</div>'
              );
            }

            content.innerHTML = cards.length
              ? cards.join('')
              : '<div class="summary-card">No function-status or inventory summary has been stored yet.</div>';
            renderAlerts();
          }

          function formatActor(command) {
            if (!command) {
              return '-';
            }
            if (command.actorType === 'admin_api_token') {
              return command.actorId ? 'API token ' + command.actorId : 'API token';
            }
            if (command.actorType === 'admin_env_token') {
              return 'Env token';
            }
            if (command.actorType === 'admin_session') {
              return 'Admin UI';
            }
            return command.actorType || '-';
          }

          function renderCommands(commands) {
            currentCommands = Array.isArray(commands) ? commands : [];
            const list = document.getElementById('commands-list');
            const meta = document.getElementById('commands-meta');
            meta.textContent = selectedDeviceId
              ? 'Showing recent commands for ' + selectedDeviceId + ' (' + currentCommands.length + ' loaded)'
              : 'Select a device to load recent commands and audit trail.';

            if (!selectedDeviceId) {
              list.innerHTML = '<div class="command-empty">No device selected.</div>';
              return;
            }

            if (!currentCommands.length) {
              list.innerHTML = '<div class="command-empty">No commands have been stored for this device yet.</div>';
              renderCommandAudit(null, []);
              return;
            }

            if (!selectedCommandId || !currentCommands.some((item) => item.commandId === selectedCommandId)) {
              selectedCommandId = currentCommands[0].commandId;
            }

            list.innerHTML = currentCommands.map((command) => {
              const selected = command.commandId === selectedCommandId;
              const finished = command.finishedAt ? 'Finished: ' + escapeHtml(formatDateTime(command.finishedAt)) : 'In progress';
              const reason = command.reasonCode || command.outcome || '';
              return '<button type="button" class="command-card ' + (selected ? 'selected' : '') + '" data-command-id="' + escapeHtml(command.commandId) + '">' +
                '<div class="command-card-head">' +
                  '<div class="command-card-title">' + escapeHtml(command.commandType) + '</div>' +
                  '<div class="command-state ' + escapeHtml(command.state) + '">' + escapeHtml(command.state) + '</div>' +
                '</div>' +
                '<div class="command-card-meta">Submitted: ' + escapeHtml(formatDateTime(command.submittedAt)) + '</div>' +
                '<div class="command-card-meta">Actor: ' + escapeHtml(formatActor(command)) + '</div>' +
                '<div class="command-card-meta">Summary: ' + escapeHtml(command.payloadSummary || '-') + '</div>' +
                '<div class="command-card-meta">' + finished + (reason ? ' | Result: ' + escapeHtml(reason) : '') + '</div>' +
              '</button>';
            }).join('');
          }

          function renderCommandAudit(command, items) {
            const container = document.getElementById('command-audit-content');
            if (!command) {
              container.innerHTML = '<div class="command-empty">Select a command to inspect audit entries.</div>';
              return;
            }
            if (!Array.isArray(items) || !items.length) {
              container.innerHTML =
                '<div class="command-empty">No audit entries stored yet for ' + escapeHtml(command.commandType) + '.</div>';
              return;
            }
            container.innerHTML = items.map((item) => {
              const klass = ['failed', 'succeeded', 'executing', 'canceled'].includes(String(item.eventType || ''))
                ? escapeHtml(String(item.eventType))
                : '';
              return '<div class="command-audit-entry ' + klass + '">' +
                '<div class="command-card-head">' +
                  '<div class="command-card-title">' + escapeHtml(item.eventType || 'event') + '</div>' +
                  '<div class="command-card-meta">' + escapeHtml(formatDateTime(item.ts)) + '</div>' +
                '</div>' +
                '<div class="command-card-meta">' + escapeHtml(item.summary || '-') + '</div>' +
                '<pre class="summary-pre" style="margin-top:8px;">' + escapeHtml(formatPayload(item.details)) + '</pre>' +
              '</div>';
            }).join('');
          }

          async function loadCommands(deviceId) {
            const params = new URLSearchParams({ deviceId, limit: '20' });
            const response = await fetch('/v1/commands?' + params.toString());
            if (!response.ok) {
              throw new Error('Failed to load commands');
            }
            const payload = await response.json();
            return Array.isArray(payload && payload.items) ? payload.items : [];
          }

          async function loadCommandAudit(commandId) {
            const response = await fetch('/v1/commands/' + encodeURIComponent(commandId) + '/audit');
            if (!response.ok) {
              throw new Error('Failed to load command audit');
            }
            const payload = await response.json();
            return Array.isArray(payload && payload.items) ? payload.items : [];
          }

          async function refreshCommands(deviceId, preferredCommandId) {
            if (!deviceId) {
              selectedCommandId = null;
              renderCommands([]);
              renderCommandAudit(null, []);
              return;
            }
            try {
              const commands = await loadCommands(deviceId);
              if (preferredCommandId) {
                selectedCommandId = preferredCommandId;
              }
              renderCommands(commands);
              const selectedCommand = currentCommands.find((item) => item.commandId === selectedCommandId) || currentCommands[0];
              if (!selectedCommand) {
                renderCommandAudit(null, []);
                return;
              }
              selectedCommandId = selectedCommand.commandId;
              const audit = await loadCommandAudit(selectedCommandId);
              renderCommandAudit(selectedCommand, audit);
            } catch (error) {
              document.getElementById('commands-meta').textContent = 'Failed to load command history.';
              document.getElementById('commands-list').innerHTML = '<div class="command-empty">Failed to load command history.</div>';
              renderCommandAudit(null, []);
            }
          }

          function refreshCommandsSoon(deviceId, preferredCommandId) {
            Promise.resolve()
              .then(() => refreshCommands(deviceId, preferredCommandId))
              .catch((error) => {
                console.error('Failed to refresh command history', error);
              });
          }

          function summarizeTransfer(record) {
            const direction = String(record && record.direction || 'transfer');
            const serverId = record && record.serverId ? String(record.serverId) : '-';
            const state = String(record && record.state || 'queued');
            const localPath = record && record.localPath ? String(record.localPath) : '-';
            const remotePath = record && record.remotePath ? String(record.remotePath) : '-';
            const percent = Number(record && record.percent);
            const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
            const title = direction === 'upload'
              ? 'Upload → ' + serverId
              : 'Download ← ' + serverId;
            const facts = [
              'State: ' + state,
              'Updated: ' + formatDateTime(record && record.updatedAt),
            ];
            if (record && record.phase) {
              facts.push('Phase: ' + String(record.phase));
            }
            if (safePercent != null) {
              facts.push('Progress: ' + safePercent.toFixed(safePercent >= 10 ? 0 : 1) + '%');
            } else if (record && record.bytesTransferred) {
              facts.push('Transferred: ' + formatBytes(record.bytesTransferred));
            }
            if (record && record.throughputBps) {
              facts.push('Rate: ' + formatRate(record.throughputBps));
            }
            if (record && record.etaSec != null) {
              facts.push('ETA: ' + formatEta(record.etaSec));
            }
            const transferredBytes = record ? Number(record.bytesTransferred || 0) : 0;
            const hasVisibleProgress = safePercent != null || transferredBytes > 0;
            let progressLabel;
            if (safePercent != null) {
              progressLabel = safePercent.toFixed(safePercent >= 10 ? 0 : 1) + '%';
            } else if (record && record.bytesTotal) {
              progressLabel = formatBytes(transferredBytes) + ' / ' + formatBytes(record.bytesTotal);
            } else if (state === 'running') {
              progressLabel = 'Live progress...';
            } else {
              progressLabel = formatBytes(transferredBytes);
            }
            const progressWidth = safePercent != null ? safePercent : 0;
            const progressClass = !hasVisibleProgress && state === 'running'
              ? 'transfer-progress indeterminate'
              : 'transfer-progress';
            const message = record && record.message ? String(record.message) : '';
            const reasonCode = record && record.reasonCode ? String(record.reasonCode) : '';
            const actionHint = defaultActionHintForReasonCode(reasonCode);
            const reason = reasonCode
              ? humanizeReasonCode(reasonCode)
                + (record.reasonDetail ? ' ' + String(record.reasonDetail) : '')
                + (actionHint ? ' ' + actionHint : '')
              : '';
            const actionButtons = [];
            if (canStopTransfer(record)) {
              actionButtons.push('<button type="button" data-transfer-action="stop" data-transfer-id="' + escapeHtml(record.transferId) + '">Stop</button>');
            } else if (canForceRemoveTransfer(record)) {
              actionButtons.push('<button type="button" data-transfer-action="force-remove" data-transfer-id="' + escapeHtml(record.transferId) + '">Force remove</button>');
            }
            if (canResumeTransfer(record)) {
              actionButtons.push('<button type="button" class="primary" data-transfer-action="resume" data-transfer-id="' + escapeHtml(record.transferId) + '">Resume</button>');
            }
            if (canDismissTransfer(record)) {
              actionButtons.push('<button type="button" data-transfer-action="dismiss" data-transfer-id="' + escapeHtml(record.transferId) + '">Dismiss</button>');
            }
            const actions = actionButtons.length
              ? '<div class="transfer-actions">' + actionButtons.join('') + '</div>'
              : '';
            return '<div class="transfer-card ' + escapeHtml(state) + '">' +
              '<div class="transfer-card-head">' +
                '<div class="transfer-card-title">' + escapeHtml(title) + '</div>' +
                '<div class="transfer-card-meta">' + escapeHtml(progressLabel) + '</div>' +
              '</div>' +
              '<div class="transfer-path">Local <code>' + escapeHtml(localPath) + '</code></div>' +
              '<div class="transfer-path">Remote <code>' + escapeHtml(remotePath) + '</code></div>' +
              '<div class="' + progressClass + '"><div class="transfer-progress-bar" style="width:' + progressWidth + '%;"></div></div>' +
              '<div class="transfer-facts">' + facts.map((item) => '<span>' + escapeHtml(item) + '</span>').join('') + '</div>' +
              (message ? '<div class="transfer-card-meta" style="margin-top:8px;">' + escapeHtml(message) + '</div>' : '') +
              (reason ? '<div class="transfer-reason">' + escapeHtml(reason) + ' <span class="transfer-card-meta">(' + escapeHtml(reasonCode) + ')</span></div>' : '') +
              actions +
            '</div>';
          }

          function updateTransferToolbarState() {
            const button = document.getElementById('clear-finished-transfers');
            if (!button) {
              return;
            }
            const hasDismissible = currentTransfers.some((item) => canDismissTransfer(item));
            button.disabled = !selectedDeviceId || !hasDismissible;
          }

          function renderTransfers(items) {
            currentTransfers = Array.isArray(items)
              ? items.slice().sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
              : [];
            const meta = document.getElementById('transfers-meta');
            const list = document.getElementById('transfers-list');
            if (!selectedDeviceId) {
              meta.textContent = 'Select a device to load recent transfer activity.';
              list.innerHTML = '<div class="transfer-empty">No device selected.</div>';
              return;
            }
            meta.textContent = currentTransfers.length
              ? 'Showing ' + currentTransfers.length + ' recent transfer(s) for ' + selectedDeviceId + '.'
              : 'No transfer activity recorded yet for ' + selectedDeviceId + '.';
            list.innerHTML = currentTransfers.length
              ? currentTransfers.map((item) => summarizeTransfer(item)).join('')
              : '<div class="transfer-empty">No transfer activity recorded yet for this device.</div>';
            updateTransferToolbarState();
          }

          function upsertTransfer(record) {
            if (!record || !record.transferId) {
              return;
            }
            const next = currentTransfers.filter((item) => item.transferId !== record.transferId);
            next.unshift(record);
            renderTransfers(next.slice(0, 50));
          }

          async function loadTransfers(deviceId) {
            const params = new URLSearchParams({ deviceId, limit: '50' });
            return fetchJsonOrThrow('/v1/file-transfers?' + params.toString());
          }

          async function startTransfer(deviceId, direction, payload) {
            return fetchJsonOrThrow('/v1/commands', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                csrfToken,
                deviceId,
                commandType: direction === 'upload' ? 'start_scp_upload' : 'start_scp_download',
                payload,
              }),
            });
          }

          function canStopTransfer(record) {
            const state = String(record && record.state || '');
            return !!(
              record
              && record.transferId
              && record.sessionId
              && (state === 'queued' || state === 'starting' || state === 'running')
            );
          }

          function canForceRemoveTransfer(record) {
            const state = String(record && record.state || '');
            return !!(
              record
              && record.transferId
              && !record.sessionId
              && (state === 'queued' || state === 'starting' || state === 'running')
            );
          }

          function canDismissTransfer(record) {
            const state = String(record && record.state || '');
            return !!(
              record
              && record.transferId
              && (state === 'succeeded' || state === 'failed' || state === 'canceled')
            );
          }

          function canResumeTransfer(record) {
            const state = String(record && record.state || '');
            return !!(
              record
              && (state === 'failed' || state === 'canceled')
              && record.resumeSupported === true
              && typeof record.resumeToken === 'string'
              && record.resumeToken.trim()
              && Number.isFinite(Number(record.resumeOffsetBytes))
              && Number(record.resumeOffsetBytes) > 0
              && typeof record.tempPathHint === 'string'
              && record.tempPathHint.trim()
              && (record.direction === 'upload' || record.direction === 'download')
            );
          }

          function buildResumeTransferPayload(record) {
            return {
              transferId: String(record.transferId),
              serverId: String(record.serverId),
              browserSessionId: record.browserSessionId ? String(record.browserSessionId) : null,
              localPath: String(record.localPath || ''),
              remotePath: String(record.remotePath || ''),
              recursive: !!record.recursive,
              overwritePolicy: record.overwritePolicy ? String(record.overwritePolicy) : 'prompt',
              followSymlinks: !!record.followSymlinks,
              rateLimitKbps: Number.isFinite(Number(record.rateLimitKbps)) && Number(record.rateLimitKbps) > 0
                ? Number(record.rateLimitKbps)
                : null,
              verifyChecksum: !!record.verifyChecksum,
              preserveMtime: !!record.preserveMtime,
              preserveMode: !!record.preserveMode,
              resumeToken: String(record.resumeToken),
              resumeOffsetBytes: Number(record.resumeOffsetBytes),
              tempPathHint: String(record.tempPathHint),
            };
          }

          async function stopTransfer(record) {
            if (!selectedDeviceId) {
              throw new Error('No device selected.');
            }
            if (!canStopTransfer(record)) {
              throw new Error('Stop is not available for this transfer.');
            }
            return fetchJsonOrThrow('/v1/file-transfers/stop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                csrfToken,
                deviceId: selectedDeviceId,
                transferId: String(record.transferId),
              }),
            });
          }

          async function forceRemoveTransfer(record) {
            if (!selectedDeviceId) {
              throw new Error('No device selected.');
            }
            if (!canForceRemoveTransfer(record)) {
              throw new Error('Force remove is not available for this transfer.');
            }
            return fetchJsonOrThrow('/v1/file-transfers/force-remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                csrfToken,
                deviceId: selectedDeviceId,
                transferId: String(record.transferId),
              }),
            });
          }

          async function dismissFinishedTransfers() {
            if (!selectedDeviceId) {
              throw new Error('No device selected.');
            }
            return fetchJsonOrThrow('/v1/file-transfers/dismiss-finished', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                csrfToken,
                deviceId: selectedDeviceId,
              }),
            });
          }

          async function dismissTransfer(record) {
            if (!selectedDeviceId) {
              throw new Error('No device selected.');
            }
            if (!canDismissTransfer(record)) {
              throw new Error('Dismiss is not available for this transfer.');
            }
            return fetchJsonOrThrow('/v1/file-transfers/dismiss', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                csrfToken,
                deviceId: selectedDeviceId,
                transferId: String(record.transferId),
              }),
            });
          }

          async function resumeTransfer(record) {
            if (!selectedDeviceId) {
              throw new Error('No device selected.');
            }
            if (!canResumeTransfer(record)) {
              throw new Error('Resume is not available for this transfer.');
            }
            return startTransfer(selectedDeviceId, String(record.direction), buildResumeTransferPayload(record));
          }

          function closeTransferStream() {
            transferStreamConnectVersion += 1;
            if (transferStream) {
              transferStream.close();
              transferStream = null;
            }
            transferStreamDeviceId = null;
          }

          async function startTransferStream(deviceId) {
            if (!deviceId) {
              closeTransferStream();
              renderTransfers([]);
              return;
            }

            const connectVersion = ++transferStreamConnectVersion;
            if (transferStream) {
              transferStream.close();
              transferStream = null;
            }
            transferStreamDeviceId = deviceId;
            document.getElementById('transfers-meta').textContent = 'Loading transfer history…';

            try {
              const history = await loadTransfers(deviceId);
              if (connectVersion !== transferStreamConnectVersion || transferStreamDeviceId !== deviceId) {
                return;
              }
              renderTransfers(Array.isArray(history) ? history : []);
            } catch (error) {
              if (connectVersion !== transferStreamConnectVersion || transferStreamDeviceId !== deviceId) {
                return;
              }
              document.getElementById('transfers-meta').textContent = 'Failed to load transfer history.';
              document.getElementById('transfers-list').innerHTML =
                '<div class="transfer-empty">Failed to load transfer history.</div>';
              return;
            }

            if (connectVersion !== transferStreamConnectVersion || transferStreamDeviceId !== deviceId) {
              return;
            }

            transferStream = new EventSource('/v1/file-transfers/stream?' + new URLSearchParams({
              deviceId,
              limit: '50',
            }).toString());
            transferStream.onopen = () => {
              if (connectVersion !== transferStreamConnectVersion || transferStreamDeviceId !== deviceId) {
                return;
              }
              document.getElementById('transfers-meta').textContent =
                currentTransfers.length
                  ? 'Streaming live transfer updates for ' + deviceId + '.'
                  : 'Streaming live transfer updates for ' + deviceId + ' (no transfers yet).';
            };
            transferStream.addEventListener('file_transfer', (message) => {
              if (connectVersion !== transferStreamConnectVersion || transferStreamDeviceId !== deviceId) {
                return;
              }
              try {
                upsertTransfer(JSON.parse(message.data));
              } catch (error) {
                console.error('Failed to parse file transfer event', error);
              }
            });
            transferStream.onerror = () => {
              if (connectVersion !== transferStreamConnectVersion || transferStreamDeviceId !== deviceId) {
                return;
              }
              document.getElementById('transfers-meta').textContent =
                'Transfer stream disconnected. Reload the device to reconnect.';
            };
          }


          function getInventoryServers() {
            return Array.isArray(selectedSummary && selectedSummary.inventory && selectedSummary.inventory.servers)
              ? selectedSummary.inventory.servers
              : [];
          }

          function getRestartTunnelCandidates() {
            return getInventoryServers().filter((server) => String(server.connectionMethod || '').toLowerCase() === 'boundary');
          }

          function getRestartSshCandidates() {
            return getInventoryServers();
          }

          function closeServerPicker() {
            selectedTunnelRestartServerId = null;
            serverPickerAction = null;
            serverPickerSubmitting = false;
            document.getElementById('server-picker-backdrop').classList.remove('open');
            document.getElementById('server-picker-backdrop').setAttribute('aria-hidden', 'true');
            document.getElementById('server-picker-list').innerHTML = '';
            document.getElementById('server-picker-confirm').disabled = true;
            document.getElementById('server-picker-confirm').textContent = 'Confirm';
          }

          function renderServerPickerOptions(servers) {
            const list = document.getElementById('server-picker-list');
            if (!servers.length) {
              list.innerHTML = '<div class="server-picker-empty">No Boundary servers are available in the selected device inventory yet. Request inventory first.</div>';
              document.getElementById('server-picker-confirm').disabled = true;
              return;
            }
            list.innerHTML = servers.map((server) => {
              const title = escapeHtml(server.name || server.id || 'Unnamed server');
              const id = escapeHtml(server.id || '');
              const host = escapeHtml(server.host || '');
              const os = escapeHtml(server.os || 'unknown');
              const sshUser = escapeHtml(server.sshUser || '');
              return '<button type="button" class="server-picker-item" data-server-id="' + id + '">' +
                '<div class="server-picker-item-title">' + title + '</div>' +
                '<div class="server-picker-item-meta">ID: ' + id + '</div>' +
                '<div class="server-picker-item-meta">Host: ' + host + ' | OS: ' + os + (sshUser ? ' | SSH user: ' + sshUser : '') + '</div>' +
              '</button>';
            }).join('');
            document.getElementById('server-picker-confirm').disabled =
              !selectedTunnelRestartServerId || serverPickerSubmitting;
          }

          function openServerPicker(servers, options) {
            selectedTunnelRestartServerId = null;
            serverPickerAction = options && options.action ? options.action : null;
            serverPickerSubmitting = false;
            document.getElementById('server-picker-title').textContent = options && options.title ? options.title : 'Restart server action';
            document.getElementById('server-picker-note').textContent = options && options.note ? options.note : 'Choose a server from the selected device inventory.';
            document.getElementById('server-picker-confirm').textContent = options && options.confirmLabel ? options.confirmLabel : 'Restart action';
            renderServerPickerOptions(servers);
            document.getElementById('server-picker-backdrop').classList.add('open');
            document.getElementById('server-picker-backdrop').setAttribute('aria-hidden', 'false');
          }

          function setRemoteBrowserStatus(message, isError) {
            const el = document.getElementById('remote-browser-status');
            el.textContent = message || '';
            el.classList.toggle('error', !!isError);
          }

          function updateRemoteBrowserActionState() {
            const selected = currentBrowserEntries.find((entry) => entry.path === currentBrowserSelectedPath) || null;
            currentBrowserSelectedEntry = selected;
            document.getElementById('remote-browser-open-folder').disabled = !(selected && selected.kind === 'directory');
            document.getElementById('remote-browser-delete').disabled = !selected;
            document.getElementById('remote-browser-use-selected').disabled = !selected;
            document.getElementById('remote-browser-use-current').disabled = !currentBrowserCurrentPath;
          }

          function renderRemoteBrowserEntries(entries) {
            currentBrowserEntries = Array.isArray(entries) ? entries : [];
            const list = document.getElementById('remote-browser-list');
            document.getElementById('remote-browser-path').value = currentBrowserCurrentPath || '';
            if (!currentBrowserEntries.length) {
              list.innerHTML = '<div class="remote-browser-empty">This folder is empty.</div>';
              updateRemoteBrowserActionState();
              return;
            }
            list.innerHTML = currentBrowserEntries.map((entry) => {
              const selected = entry.path === currentBrowserSelectedPath;
              const kind = String(entry.kind || 'other');
              return '<button type="button" class="remote-browser-item ' + (selected ? 'selected' : '') + '" data-path="' + escapeHtml(entry.path || '') + '" data-kind="' + escapeHtml(kind) + '">' +
                '<div class="remote-browser-item-name">' + escapeHtml(entry.name || entry.path || '-') + '</div>' +
                '<div class="remote-browser-item-meta">' + escapeHtml(kind) + ' • ' + escapeHtml(entry.path || '') + '</div>' +
              '</button>';
            }).join('');
            updateRemoteBrowserActionState();
          }

          async function openRemoteBrowserSession(deviceId, serverId) {
            return fetchJsonOrThrow('/v1/file-ops/remote-browser/open', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ csrfToken, deviceId, serverId }),
            });
          }

          async function listRemoteBrowserChildren(deviceId, browserSessionId, path) {
            return fetchJsonOrThrow('/v1/file-ops/remote-browser/list', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ csrfToken, deviceId, browserSessionId, path }),
            });
          }

          async function createRemoteBrowserDirectory(deviceId, browserSessionId, path) {
            return fetchJsonOrThrow('/v1/file-ops/remote-browser/mkdir', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ csrfToken, deviceId, browserSessionId, path }),
            });
          }

          async function deleteRemoteBrowserPath(deviceId, browserSessionId, path, recursive) {
            return fetchJsonOrThrow('/v1/file-ops/remote-browser/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ csrfToken, deviceId, browserSessionId, path, recursive }),
            });
          }

          async function closeRemoteBrowserSession(deviceId, browserSessionId) {
            return fetchJsonOrThrow('/v1/file-ops/remote-browser/close', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ csrfToken, deviceId, browserSessionId }),
            });
          }

          async function refreshRemoteBrowser(path) {
            if (!selectedDeviceId || !currentBrowserSessionId) {
              return;
            }
            const targetPath = (path || currentBrowserCurrentPath || currentBrowserRootPath || '').trim();
            if (!targetPath) {
              return;
            }
            setRemoteBrowserStatus('Loading ' + targetPath + '…');
            const payload = await listRemoteBrowserChildren(selectedDeviceId, currentBrowserSessionId, targetPath);
            currentBrowserCurrentPath = typeof payload.path === 'string' && payload.path ? payload.path : targetPath;
            currentBrowserSelectedPath = null;
            currentBrowserSelectedEntry = null;
            renderRemoteBrowserEntries(Array.isArray(payload.entries) ? payload.entries : []);
            setRemoteBrowserStatus('Browsing ' + currentBrowserCurrentPath);
          }

          async function initiateRemoteTransfer(direction) {
            if (!selectedDeviceId || !currentBrowserServerId) {
              return;
            }
            const localPath = getTransferLocalPath();
            const remotePath = getTransferRemotePath();
            if (!localPath) {
              setRemoteBrowserStatus('Local path is required.', true);
              return;
            }
            if (!remotePath) {
              setRemoteBrowserStatus('Remote path is required.', true);
              return;
            }
            const options = getTransferOptions();
            if (options.overwritePolicy === 'prompt' && direction === 'upload' && currentBrowserSelectedEntry && currentBrowserSelectedEntry.kind !== 'directory' && currentBrowserSelectedEntry.path === remotePath) {
              const confirmed = window.confirm(
                'The selected remote path already exists. Start upload anyway and let the agent prompt/decline overwrite as needed?',
              );
              if (!confirmed) {
                setRemoteBrowserStatus('Upload canceled before overwrite-sensitive start.', false);
                return;
              }
            }
            const payload = {
              serverId: currentBrowserServerId,
              browserSessionId: currentBrowserSessionId,
              localPath,
              remotePath,
              overwritePolicy: options.overwritePolicy,
              recursive: options.recursive,
              verifyChecksum: options.verifyChecksum,
              followSymlinks: options.followSymlinks,
              preserveMtime: options.preserveMtime,
              preserveMode: options.preserveMode,
              rateLimitKbps: Number.isFinite(options.rateLimitKbps) && options.rateLimitKbps > 0 ? options.rateLimitKbps : null,
            };
            try {
              setRemoteBrowserStatus('Starting ' + direction + ' transfer…');
              const result = await startTransfer(selectedDeviceId, direction, payload);
              refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
              const transferId = result && result.command && result.command.payload && result.command.payload.transferId
                ? String(result.command.payload.transferId)
                : null;
              document.getElementById('summary-meta').textContent =
                'Started ' + direction + ' transfer' + (transferId ? ' ' + transferId : '') + ' at ' + new Date().toISOString();
              setRemoteBrowserStatus(
                'Started ' + direction + ' transfer' + (transferId ? ' (' + transferId + ')' : '') + '. Monitor progress in File transfer history.',
                false,
              );
            } catch (error) {
              const detail = describeApiError(error);
              if (detail && detail.code === 'path_already_exists') {
                setTransferOverwritePolicy('force');
                setRemoteBrowserStatus(
                  detail.message + ' Switched “If destination exists” to Overwrite existing destination so you can retry immediately, or change it to Skip.',
                  true,
                );
                document.getElementById('transfer-overwrite-policy').focus();
                return;
              }
              setRemoteBrowserStatus(detail.message, true);
            }
          }

          async function showRemoteBrowser(serverId) {
            currentBrowserServerId = serverId;
            currentBrowserSelectedPath = null;
            currentBrowserSelectedEntry = null;
            document.getElementById('remote-browser-backdrop').classList.add('open');
            document.getElementById('remote-browser-backdrop').setAttribute('aria-hidden', 'false');
            document.getElementById('remote-browser-list').innerHTML = '<div class="remote-browser-empty">Opening remote browser…</div>';
            setRemoteBrowserStatus('Opening remote browser…');
            try {
              const payload = await openRemoteBrowserSession(selectedDeviceId, serverId);
              currentBrowserSessionId = typeof payload.browserSessionId === 'string' ? payload.browserSessionId : null;
              currentBrowserRootPath = typeof payload.rootPath === 'string' ? payload.rootPath : '/';
              currentBrowserCurrentPath = currentBrowserRootPath;
              setTransferRemotePath(currentBrowserRootPath || '');
              await refreshRemoteBrowser(currentBrowserRootPath);
            } catch (error) {
              await closeRemoteBrowserModal();
              throw error;
            }
          }

          async function closeRemoteBrowserModal() {
            const browserSessionId = currentBrowserSessionId;
            currentBrowserSessionId = null;
            currentBrowserServerId = null;
            currentBrowserRootPath = null;
            currentBrowserCurrentPath = null;
            currentBrowserSelectedPath = null;
            currentBrowserSelectedEntry = null;
            currentBrowserEntries = [];
            document.getElementById('remote-browser-backdrop').classList.remove('open');
            document.getElementById('remote-browser-backdrop').setAttribute('aria-hidden', 'true');
            document.getElementById('remote-browser-list').innerHTML = '<div class="remote-browser-empty">No remote browser session open.</div>';
            document.getElementById('remote-browser-path').value = '';
            setTransferRemotePath('');
            setRemoteBrowserStatus('Choose a server to open the remote browser.');
            updateRemoteBrowserActionState();
            if (selectedDeviceId && browserSessionId) {
              try {
                await closeRemoteBrowserSession(selectedDeviceId, browserSessionId);
              } catch (error) {
                console.error('Failed to close remote browser session', error);
              }
            }
          }

          async function loadDeviceSummary(deviceId) {
            const params = new URLSearchParams({ deviceId });
            const response = await fetch('/v1/device-summary?' + params.toString());
            if (!response.ok) {
              throw new Error('Failed to load device summary');
            }
            const summary = await response.json();
            if (deviceId) {
              deviceSummary[deviceId] = summary || {};
            }
            return summary;
          }

          async function requestStatusSnapshot(deviceId) {
            const response = await fetch('/v1/devices/' + encodeURIComponent(deviceId) + '/request-status-snapshot', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ csrfToken }),
            });
            if (!response.ok) {
              throw new Error(await response.text());
            }
            return response.json();
          }

          async function requestInventory(deviceId) {
            const response = await fetch('/v1/devices/' + encodeURIComponent(deviceId) + '/request-inventory', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ csrfToken }),
            });
            if (!response.ok) {
              throw new Error(await response.text());
            }
            return response.json();
          }

          async function requestRecentLogs(deviceId) {
            const response = await fetch('/v1/devices/' + encodeURIComponent(deviceId) + '/request-recent-logs', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ csrfToken }),
            });
            if (!response.ok) {
              throw new Error(await response.text());
            }
            return response.json();
          }

          async function requestRestartOpenvpn(deviceId) {
            const response = await fetch('/v1/devices/' + encodeURIComponent(deviceId) + '/request-restart-openvpn', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ csrfToken }),
            });
            if (!response.ok) {
              throw new Error(await response.text());
            }
            return response.json();
          }


          async function requestRestartBoundaryAuth(deviceId) {
            const response = await fetch('/v1/devices/' + encodeURIComponent(deviceId) + '/request-restart-boundary-auth', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ csrfToken }),
            });
            if (!response.ok) {
              throw new Error(await response.text());
            }
            return response.json();
          }


          async function requestRestartServerTunnel(deviceId, serverId) {
            const response = await fetch('/v1/devices/' + encodeURIComponent(deviceId) + '/request-restart-server-tunnel', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ csrfToken, serverId }),
            });
            if (!response.ok) {
              throw new Error(await response.text());
            }
            return response.json();
          }


          async function requestRestartServerSsh(deviceId, serverId) {
            const response = await fetch('/v1/devices/' + encodeURIComponent(deviceId) + '/request-restart-server-ssh', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ csrfToken, serverId }),
            });
            if (!response.ok) {
              throw new Error(await response.text());
            }
            return response.json();
          }

          async function refreshDevices() {
            try {
              const response = await fetch('/v1/devices');
              if (!response.ok) {
                return;
              }
              const devices = await response.json();
              currentDevices = devices;
              const searchFilter = (document.getElementById('devices-search')?.value || '').toLowerCase().trim();
              const filtered = searchFilter 
                ? devices.filter(d => d.id.toLowerCase().includes(searchFilter) || (d.name && d.name.toLowerCase().includes(searchFilter)))
                : devices;
              document.getElementById('devices-tbody').innerHTML = renderRows(filtered);
              document.getElementById('devices-meta').textContent = renderMeta(devices);
              renderAlerts();
            } catch (error) {
              console.error('Failed to refresh devices', error);
            }
          }

          document.getElementById('devices-search')?.addEventListener('input', () => {
            const searchFilter = (document.getElementById('devices-search').value || '').toLowerCase().trim();
            const filtered = searchFilter 
              ? currentDevices.filter(d => d.id.toLowerCase().includes(searchFilter) || (d.name && d.name.toLowerCase().includes(searchFilter)))
              : currentDevices;
            document.getElementById('devices-tbody').innerHTML = renderRows(filtered);
          });

          function appendLog(event) {
            const output = document.getElementById('logs-output');
            if (isPaused) {
              return;
            }
            const atBottom =
              output.scrollHeight - output.scrollTop - output.clientHeight < 8;
            const next = document.createElement('div');
            next.className = 'log-entry log-' + String(event.type || 'unknown').replace(/[^a-z0-9_-]/gi, '-');

            const meta = document.createElement('div');
            meta.className = 'log-meta';
            meta.textContent = [
              event.ts,
              event.type,
              event.functionId || '-',
              event.sessionId || '-',
            ].join(' | ');

            const payload = document.createElement('pre');
            payload.className = 'log-payload';
            payload.textContent = formatPayload(event.payload);

            next.appendChild(meta);
            next.appendChild(payload);
            output.appendChild(next);
            if (isAutoScrollEnabled() && atBottom) {
              output.scrollTop = output.scrollHeight;
            }
          }

          function formatPayload(payload) {
            if (payload == null) {
              return 'null';
            }
            if (typeof payload === 'string') {
              return payload;
            }
            try {
              return JSON.stringify(payload, null, 2);
            } catch {
              return String(payload);
            }
          }

          async function loadLogHistory(deviceId, filters) {
            const params = new URLSearchParams({
              deviceId,
              limit: '100',
            });
            if (filters.type) {
              params.set('type', filters.type);
            }
            if (filters.functionId) {
              params.set('functionId', filters.functionId);
            }
            if (filters.q) {
              params.set('q', filters.q);
            }
            const response = await fetch('/v1/logs?' + params.toString());
            if (!response.ok) {
              throw new Error('Failed to load log history');
            }
            return response.json();
          }

          async function exportLogs(deviceId, filters) {
            const params = new URLSearchParams({
              deviceId,
              limit: '5000',
            });
            if (filters.type) {
              params.set('type', filters.type);
            }
            if (filters.functionId) {
              params.set('functionId', filters.functionId);
            }
            if (filters.q) {
              params.set('q', filters.q);
            }
            const response = await fetch('/v1/logs/export?' + params.toString());
            if (!response.ok) {
              throw new Error('Failed to export logs');
            }
            return response.json();
          }

          function scheduleReconnect(deviceId) {
            if (!selectedDeviceId || selectedDeviceId !== deviceId) {
              return;
            }
            clearReconnectTimer();
            reconnectTimer = window.setTimeout(() => {
              startLogStream(deviceId, { skipHistory: true });
            }, 2000);
          }

          async function startLogStream(deviceId, options = {}) {
            const { skipHistory = false } = options;
            const previousDeviceId = selectedDeviceId;
            const connectVersion = ++streamConnectVersion;
            if (previousDeviceId && previousDeviceId !== deviceId) {
              await detachCurrentPty({ silent: true });
              clearPtySelection();
            }
            selectedDeviceId = deviceId;
            document.getElementById('devices-tbody').innerHTML = renderRows(currentDevices);

            closeStream();

            const output = document.getElementById('logs-output');
            const filters = getActiveFilters();
            if (!skipHistory) {
              output.textContent = '';
              document.getElementById('logs-status').textContent =
                'Loading telemetry history…';

              try {
                const summary = await loadDeviceSummary(deviceId);
                renderSummary(summary);
                await refreshCommands(deviceId);
                await startTransferStream(deviceId);
                try {
                  await loadPtySessions(deviceId, { preserveSelection: false });
                } catch (error) {
                  clearPtySelection();
                  setPtyStatus('Failed to load PTY sessions.', true);
                }
                const history = await loadLogHistory(deviceId, filters);
                if (connectVersion !== streamConnectVersion) {
                  return;
                }
                output.textContent = '';
                if (!history.length) {
                  output.innerHTML = '<span class="logs-empty">No telemetry matched the current filters.</span>';
                } else {
                  for (const event of history) {
                    appendLog(event);
                  }
                }
              } catch (error) {
                if (connectVersion !== streamConnectVersion) {
                  return;
                }
                renderSummary(null);
                renderTransfers([]);
                closeTransferStream();
                clearPtySelection();
                output.innerHTML = '<span class="logs-empty">Failed to load telemetry history.</span>';
                document.getElementById('logs-status').textContent =
                  'Failed to load telemetry history.';
                return;
              }
            }

            if (connectVersion !== streamConnectVersion) {
              return;
            }
            document.getElementById('logs-status').textContent =
              'Connecting to telemetry stream…';

            const params = new URLSearchParams({
              deviceId,
              limit: '100',
            });
            if (filters.type) {
              params.set('type', filters.type);
            }
            if (filters.functionId) {
              params.set('functionId', filters.functionId);
            }
            if (filters.q) {
              params.set('q', filters.q);
            }
            stream = new EventSource('/v1/logs/stream?' + params.toString());
            stream.onopen = () => {
              if (connectVersion !== streamConnectVersion) {
                return;
              }
              clearReconnectTimer();
              document.getElementById('logs-status').textContent =
                'Streaming telemetry for ' + deviceId + (filters.type || filters.functionId || filters.q ? ' with filters applied' : '');
            };
            stream.addEventListener('telemetry', (message) => {
              if (connectVersion !== streamConnectVersion) {
                return;
              }
              const payload = JSON.parse(message.data);
              if (output.querySelector('.logs-empty')) {
                output.textContent = '';
              }
              appendLog(payload);
              if (payload.type === 'function-status' || payload.type === 'inventory') {
                loadDeviceSummary(deviceId)
                  .then((summary) => renderSummary(summary))
                  .catch(() => {});
                refreshCommands(deviceId, selectedCommandId).catch(() => {});
              }
            });
            stream.onerror = () => {
              if (connectVersion !== streamConnectVersion) {
                return;
              }
              document.getElementById('logs-status').textContent =
                'Telemetry stream disconnected. Reconnecting in 2 seconds…';
              closeStream();
              scheduleReconnect(deviceId);
            };
          }

          document.getElementById('devices-tbody').addEventListener('click', (event) => {
            const actionButton = event.target.closest('.actions-btn');
            if (actionButton) {
              event.stopPropagation();
              const menu = actionButton.parentElement?.querySelector('.actions-menu');
              const shouldOpen = menu ? !menu.classList.contains('open') : false;
              Array.from(document.querySelectorAll('.actions-menu.open')).forEach((item) => {
                item.classList.remove('open');
              });
              if (menu && shouldOpen) {
                menu.classList.add('open');
              }
              return;
            }

            const actionItem = event.target.closest('.actions-menu button[data-action]');
            if (actionItem) {
              event.stopPropagation();
              const menu = actionItem.closest('.actions-menu');
              const row = actionItem.closest('tr[data-device-id]');
              const deviceId = row?.dataset.deviceId || null;
              const action = actionItem.dataset.action || '';
              if (menu) {
                menu.classList.remove('open');
              }
              if (!deviceId) {
                return;
              }
              if (action === 'view') {
                startLogStream(deviceId);
                return;
              }
              if (action === 'snapshot') {
                requestStatusSnapshot(deviceId)
                  .then((result) => {
                    document.getElementById('summary-meta').textContent =
                      'Requested fresh status snapshot at ' + new Date().toISOString();
                    refreshCommandsSoon(deviceId, result && result.command && result.command.commandId);
                  })
                  .catch(() => {
                    document.getElementById('summary-meta').textContent =
                      'Failed to request fresh status snapshot.';
                  });
                return;
              }
              if (action === 'logs') {
                startLogStream(deviceId);
                document.getElementById('logs-output')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                return;
              }
              if (action === 'config') {
                openConfigView();
              }
              return;
            }

            const row = event.target.closest('tr[data-device-id]');
            if (!row) {
              return;
            }
            startLogStream(row.dataset.deviceId);
          });

          document.addEventListener('click', (event) => {
            if (!event.target.closest('.actions-dropdown')) {
              Array.from(document.querySelectorAll('.actions-menu.open')).forEach((item) => {
                item.classList.remove('open');
              });
            }
          });

          document.getElementById('commands-list').addEventListener('click', async (event) => {
            const button = event.target.closest('[data-command-id]');
            if (!button) {
              return;
            }
            selectedCommandId = button.dataset.commandId || null;
            renderCommands(currentCommands);
            const command = currentCommands.find((item) => item.commandId === selectedCommandId) || null;
            if (!command) {
              renderCommandAudit(null, []);
              return;
            }
            try {
              const audit = await loadCommandAudit(selectedCommandId);
              renderCommandAudit(command, audit);
            } catch (error) {
              renderCommandAudit(command, []);
            }
          });

          document.getElementById('clear-finished-transfers').addEventListener('click', async (event) => {
            if (!selectedDeviceId) {
              return;
            }
            const dismissibleCount = currentTransfers.filter((item) => canDismissTransfer(item)).length;
            if (!dismissibleCount) {
              document.getElementById('transfers-meta').textContent = 'No finished transfers to clear.';
              updateTransferToolbarState();
              return;
            }
            if (!window.confirm('Clear ' + dismissibleCount + ' finished transfer history item(s)?')) {
              return;
            }
            const button = event.currentTarget;
            const originalLabel = button.textContent || 'Clear finished';
            button.disabled = true;
            button.textContent = 'Clearing…';
            try {
              const result = await dismissFinishedTransfers();
              renderTransfers(currentTransfers.filter((item) => !canDismissTransfer(item)));
              document.getElementById('transfers-meta').textContent =
                'Cleared ' + Number(result && result.deletedCount || 0) + ' finished transfer(s) at ' + new Date().toISOString() + '.';
            } catch (error) {
              const detail = describeApiError(error);
              document.getElementById('transfers-meta').textContent =
                'Failed to clear finished transfers: ' + detail.message;
            } finally {
              button.textContent = originalLabel;
              updateTransferToolbarState();
            }
          });

          document.getElementById('transfers-list').addEventListener('click', async (event) => {
            const button = event.target.closest('[data-transfer-action][data-transfer-id]');
            if (!button) {
              return;
            }
            const action = button.dataset.transferAction || '';
            const transferId = button.dataset.transferId || '';
            const record = currentTransfers.find((item) => item && item.transferId === transferId);
            if (!record) {
              document.getElementById('transfers-meta').textContent = 'Transfer not found. Reload transfer history and try again.';
              return;
            }
            if (action === 'force-remove') {
              if (!canForceRemoveTransfer(record)) {
                document.getElementById('transfers-meta').textContent = 'Force remove is not available for this transfer.';
                return;
              }
              const confirmed = window.confirm('Force remove this transfer history item? This may not stop work on the agent if it is still running.');
              if (!confirmed) {
                return;
              }
              const originalLabel = button.textContent || 'Force remove';
              button.disabled = true;
              button.textContent = 'Removing…';
              try {
                await forceRemoveTransfer(record);
                renderTransfers(currentTransfers.filter((item) => item && item.transferId !== transferId));
                document.getElementById('transfers-meta').textContent =
                  'Force removed transfer ' + transferId + ' at ' + new Date().toISOString() + '.';
              } catch (error) {
                const detail = describeApiError(error);
                document.getElementById('transfers-meta').textContent =
                  'Failed to force remove transfer ' + transferId + ': ' + detail.message;
                button.disabled = false;
                button.textContent = originalLabel;
              }
              return;
            }
            if (action === 'stop') {
              if (!canStopTransfer(record)) {
                document.getElementById('transfers-meta').textContent = 'Stop is not available for this transfer.';
                return;
              }
              const originalLabel = button.textContent || 'Stop';
              button.disabled = true;
              button.textContent = 'Stopping…';
              try {
                await stopTransfer(record);
                document.getElementById('transfers-meta').textContent =
                  'Requested stop for transfer ' + transferId + ' at ' + new Date().toISOString() + '.';
              } catch (error) {
                const detail = describeApiError(error);
                document.getElementById('transfers-meta').textContent =
                  'Failed to stop transfer ' + transferId + ': ' + detail.message;
                button.disabled = false;
                button.textContent = originalLabel;
              }
              return;
            }
            if (action === 'resume') {
              if (!canResumeTransfer(record)) {
                document.getElementById('transfers-meta').textContent = 'Resume is not available for this transfer.';
                return;
              }
              const originalLabel = button.textContent || 'Resume';
              button.disabled = true;
              button.textContent = 'Resuming…';
              try {
                const result = await resumeTransfer(record);
                refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
                document.getElementById('transfers-meta').textContent =
                  'Requested resume for transfer ' + transferId + ' at ' + new Date().toISOString() + '.';
              } catch (error) {
                const detail = describeApiError(error);
                document.getElementById('transfers-meta').textContent =
                  'Failed to resume transfer ' + transferId + ': ' + detail.message;
              } finally {
                button.disabled = false;
                button.textContent = originalLabel;
              }
              return;
            }
            if (action === 'dismiss') {
              if (!canDismissTransfer(record)) {
                document.getElementById('transfers-meta').textContent = 'Dismiss is not available for this transfer.';
                return;
              }
              const originalLabel = button.textContent || 'Dismiss';
              button.disabled = true;
              button.textContent = 'Dismissing…';
              try {
                await dismissTransfer(record);
                renderTransfers(currentTransfers.filter((item) => item && item.transferId !== transferId));
                document.getElementById('transfers-meta').textContent =
                  'Dismissed transfer ' + transferId + ' at ' + new Date().toISOString() + '.';
              } catch (error) {
                const detail = describeApiError(error);
                document.getElementById('transfers-meta').textContent =
                  'Failed to dismiss transfer ' + transferId + ': ' + detail.message;
                button.disabled = false;
                button.textContent = originalLabel;
              }
            }
          });

          document.getElementById('pty-session-select').addEventListener('change', (event) => {
            currentPtySessionId = event.target.value || null;
            syncPtySelectionState();
          });

          document.getElementById('pty-refresh-sessions').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            try {
              await loadPtySessions(selectedDeviceId, { preserveSelection: true });
              setPtyStatus('PTY session list refreshed.');
            } catch (error) {
              setPtyStatus('Failed to load PTY sessions.', true);
            }
          });

          document.getElementById('pty-open').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            try {
              const cols = Number(document.getElementById('pty-cols').value) || 120;
              const rows = Number(document.getElementById('pty-rows').value) || 32;
              const recording = document.getElementById('pty-recording-enabled').checked;
              await sendPtyMessage('pty_open', { deviceId: selectedDeviceId, cols, rows, recording });
              setPtyStatus('Opening and attaching PTY session…');
            } catch (error) {
              setPtyStatus('Failed to open PTY session.', true);
            }
          });

          document.getElementById('pty-attach').addEventListener('click', async () => {
            const session = getSelectedPtySession();
            if (!selectedDeviceId || !session) {
              return;
            }
            try {
              await sendPtyMessage('pty_attach', { deviceId: selectedDeviceId, sessionId: session.sessionId });
              setPtyStatus('Reattaching to PTY session ' + session.sessionId + '…');
            } catch (error) {
              setPtyStatus('Failed to attach PTY session.', true);
            }
          });

          document.getElementById('pty-resize').addEventListener('click', async () => {
            const session = getSelectedPtySession();
            if (!selectedDeviceId || !session) {
              return;
            }
            try {
              const cols = Number(document.getElementById('pty-cols').value) || 120;
              const rows = Number(document.getElementById('pty-rows').value) || 32;
              await sendPtyMessage('pty_resize', { deviceId: selectedDeviceId, sessionId: session.sessionId, cols, rows });
              session.cols = cols;
              session.rows = rows;
              syncPtySizeInputs(session);
              applyPtyTerminalSize(session);
              setPtyStatus('Resized PTY session ' + session.sessionId + ' to ' + cols + 'x' + rows + '.');
            } catch (error) {
              setPtyStatus('Failed to resize PTY session.', true);
            }
          });

          document.getElementById('pty-detach').addEventListener('click', async () => {
            await detachCurrentPty();
          });

	          document.getElementById('pty-close').addEventListener('click', async () => {
	            const session = getSelectedPtySession();
            if (!selectedDeviceId || !session) {
              return;
            }
            try {
              await sendPtyMessage('pty_close', { deviceId: selectedDeviceId, sessionId: session.sessionId });
              setPtyStatus('Closing PTY session ' + session.sessionId + '…');
            } catch (error) {
              setPtyStatus('Failed to close PTY session.', true);
            }
          });

	          async function sendPtyInput(data) {
	            await sendTerminalData(data);
	          }


          document.getElementById('pty-recording-consent').addEventListener('click', async () => {
            const session = getSelectedPtySession();
            if (!selectedDeviceId || !session) {
              return;
            }
            try {
              await sendPtyMessage('pty_recording_consent', { deviceId: selectedDeviceId, sessionId: session.sessionId });
              setPtyStatus('Acknowledging recording consent for ' + session.sessionId + '…');
            } catch (error) {
              setPtyStatus('Failed to acknowledge PTY recording consent.', true);
            }
          });

	          document.getElementById('pty-send-ctrl-c').addEventListener('click', async () => {
	            try {
	              await sendTerminalData('\\u0003');
	            } catch (error) {
	              setPtyStatus('Failed to send Ctrl+C.', true);
	            }
	          });

	          document.getElementById('pty-delete').addEventListener('click', async () => {
	            const session = getSelectedPtySession();
	            if (!selectedDeviceId || !session) {
	              return;
	            }
	            if (!['closed', 'expired', 'failed'].includes(session.state)) {
	              setPtyStatus('Only closed, expired, or failed PTY sessions can be deleted.', true);
	              return;
	            }
	            if (!window.confirm('Delete PTY session ' + session.sessionId + ' from the stored session list? Audit entries will remain.')) {
	              return;
	            }
	            try {
	              await fetch('/v1/devices/' + encodeURIComponent(selectedDeviceId) + '/pty/delete', {
	                method: 'POST',
	                headers: { 'Content-Type': 'application/json' },
	                body: JSON.stringify({ csrfToken, sessionId: session.sessionId }),
	              }).then(async (response) => {
	                if (!response.ok) {
	                  throw new Error(await response.text());
	                }
	                return response.json();
	              });
	              ptyOutputBuffers.delete(session.sessionId);
	              if (currentPtySessionId === session.sessionId) {
	                currentPtySessionId = null;
	              }
	              await loadPtySessions(selectedDeviceId, { preserveSelection: true });
	              setPtyStatus('Deleted PTY session ' + session.sessionId + '.');
	            } catch (error) {
	              setPtyStatus('Failed to delete PTY session.', true);
	            }
	          });

          document.getElementById('pty-clear-output').addEventListener('click', () => {
            if (currentPtySessionId) {
              setPtyOutput(currentPtySessionId, '');
            } else {
              renderPtyOutput();
            }
          });

          document.getElementById('logs-apply-filters').addEventListener('click', () => {
            if (selectedDeviceId) {
              startLogStream(selectedDeviceId);
            }
          });

          document.getElementById('logs-export').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            try {
              const payload = await exportLogs(selectedDeviceId, getActiveFilters());
              const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = payload.fileName || 'cc-logs-export.json';
              document.body.appendChild(link);
              link.click();
              link.remove();
              URL.revokeObjectURL(url);
            } catch (error) {
              console.error('Failed to export logs', error);
            }
          });

          document.getElementById('request-status-snapshot').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            try {
              const result = await requestStatusSnapshot(selectedDeviceId);
              document.getElementById('summary-meta').textContent =
                'Requested fresh status snapshot at ' + new Date().toISOString();
              refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
            } catch (error) {
              document.getElementById('summary-meta').textContent =
                'Failed to request fresh status snapshot.';
            }
          });

          document.getElementById('request-inventory').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            try {
              const result = await requestInventory(selectedDeviceId);
              document.getElementById('summary-meta').textContent =
                'Requested inventory refresh at ' + new Date().toISOString();
              refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
            } catch (error) {
              document.getElementById('summary-meta').textContent =
                'Failed to request inventory refresh.';
            }
          });

          document.getElementById('request-recent-logs').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            try {
              const result = await requestRecentLogs(selectedDeviceId);
              document.getElementById('summary-meta').textContent =
                'Requested recent logs at ' + new Date().toISOString();
              refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
            } catch (error) {
              document.getElementById('summary-meta').textContent =
                'Failed to request recent logs.';
            }
          });

          document.getElementById('request-restart-openvpn').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            try {
              const result = await requestRestartOpenvpn(selectedDeviceId);
              document.getElementById('summary-meta').textContent =
                'Requested OpenVPN restart at ' + new Date().toISOString();
              refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
            } catch (error) {
              document.getElementById('summary-meta').textContent =
                'Failed to request OpenVPN restart.';
            }
          });


          document.getElementById('request-restart-boundary-auth').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            try {
              const result = await requestRestartBoundaryAuth(selectedDeviceId);
              document.getElementById('summary-meta').textContent =
                'Requested Boundary auth restart at ' + new Date().toISOString();
              refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
            } catch (error) {
              document.getElementById('summary-meta').textContent =
                'Failed to request Boundary auth restart.';
            }
          });


          document.getElementById('request-restart-server-tunnel').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            const candidates = getRestartTunnelCandidates();
            if (!candidates.length) {
              document.getElementById('summary-meta').textContent =
                'No Boundary servers available in inventory. Request inventory first.';
              return;
            }
            openServerPicker(candidates, {
              action: 'restart-server-tunnel',
              title: 'Restart server tunnel',
              note: 'Choose a Boundary-backed server from the selected device inventory.',
              confirmLabel: 'Restart tunnel',
            });
          });

          document.getElementById('request-restart-server-ssh').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            const candidates = getRestartSshCandidates();
            if (!candidates.length) {
              document.getElementById('summary-meta').textContent =
                'No servers available in inventory. Request inventory first.';
              return;
            }
            openServerPicker(candidates, {
              action: 'restart-server-ssh',
              title: 'Restart server SSH',
              note: 'Choose a server from the selected device inventory.',
              confirmLabel: 'Restart SSH',
            });
          });

          document.getElementById('open-remote-browser').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            const candidates = getRestartSshCandidates();
            if (!candidates.length) {
              document.getElementById('summary-meta').textContent =
                'No servers available in inventory. Request inventory first.';
              return;
            }
            openServerPicker(candidates, {
              action: 'open-remote-browser',
              title: 'Open remote browser',
              note: 'Choose a server from the selected device inventory to browse remote paths.',
              confirmLabel: 'Open browser',
            });
          });

          document.getElementById('server-picker-list').addEventListener('click', (event) => {
            const button = event.target.closest('[data-server-id]');
            if (!button) {
              return;
            }
            selectedTunnelRestartServerId = button.dataset.serverId || null;
            Array.from(document.querySelectorAll('#server-picker-list .server-picker-item')).forEach((item) => {
              item.classList.toggle('selected', item.dataset.serverId === selectedTunnelRestartServerId);
            });
            document.getElementById('server-picker-confirm').disabled =
              !selectedTunnelRestartServerId || serverPickerSubmitting;
          });

          document.getElementById('server-picker-cancel').addEventListener('click', () => {
            closeServerPicker();
          });

          document.getElementById('server-picker-backdrop').addEventListener('click', (event) => {
            if (event.target.id === 'server-picker-backdrop') {
              closeServerPicker();
            }
          });

          document.getElementById('server-picker-confirm').addEventListener('click', async () => {
            if (!selectedDeviceId || !selectedTunnelRestartServerId || !serverPickerAction || serverPickerSubmitting) {
              return;
            }
            const confirmButton = document.getElementById('server-picker-confirm');
            const activeAction = serverPickerAction;
            const originalConfirmLabel = confirmButton.textContent || 'Confirm';
            serverPickerSubmitting = true;
            confirmButton.disabled = true;
            confirmButton.textContent = 'Working…';
            const serverId = selectedTunnelRestartServerId;
            try {
              if (serverPickerAction === 'restart-server-tunnel') {
                const result = await requestRestartServerTunnel(selectedDeviceId, serverId);
                document.getElementById('summary-meta').textContent =
                  'Requested server tunnel restart for ' + serverId + ' at ' + new Date().toISOString();
                refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
              } else if (serverPickerAction === 'restart-server-ssh') {
                const result = await requestRestartServerSsh(selectedDeviceId, serverId);
                document.getElementById('summary-meta').textContent =
                  'Requested server SSH restart for ' + serverId + ' at ' + new Date().toISOString();
                refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
              } else if (serverPickerAction === 'open-remote-browser') {
                closeServerPicker();
                await showRemoteBrowser(serverId);
                document.getElementById('summary-meta').textContent =
                  'Opened remote browser for ' + serverId + ' at ' + new Date().toISOString();
                return;
              }
              closeServerPicker();
            } catch (error) {
              const detail = describeApiError(error);
              document.getElementById('summary-meta').textContent =
                activeAction === 'restart-server-ssh'
                  ? 'Failed to request server SSH restart. ' + detail.message
                  : activeAction === 'open-remote-browser'
                    ? 'Failed to open remote browser. ' + detail.message
                    : 'Failed to request server tunnel restart. ' + detail.message;
            } finally {
              if (serverPickerAction === activeAction) {
                serverPickerSubmitting = false;
                confirmButton.disabled = !selectedTunnelRestartServerId;
                confirmButton.textContent = originalConfirmLabel;
              }
            }
          });

          document.getElementById('remote-browser-list').addEventListener('click', (event) => {
            const button = event.target.closest('[data-path]');
            if (!button) {
              return;
            }
            currentBrowserSelectedPath = button.dataset.path || null;
            Array.from(document.querySelectorAll('#remote-browser-list .remote-browser-item')).forEach((item) => {
              item.classList.toggle('selected', item.dataset.path === currentBrowserSelectedPath);
            });
            updateRemoteBrowserActionState();
          });

          document.getElementById('remote-browser-list').addEventListener('dblclick', async (event) => {
            const button = event.target.closest('[data-path][data-kind="directory"]');
            if (!button || !button.dataset.path) {
              return;
            }
            try {
              await refreshRemoteBrowser(button.dataset.path);
            } catch (error) {
              setRemoteBrowserStatus(describeApiError(error).message, true);
            }
          });

          document.getElementById('remote-browser-up').addEventListener('click', async () => {
            if (!currentBrowserCurrentPath) {
              return;
            }
            const parts = String(currentBrowserCurrentPath).split('/').filter(Boolean);
            const nextPath = parts.length ? '/' + parts.slice(0, -1).join('/') : (currentBrowserRootPath || '/');
            try {
              await refreshRemoteBrowser(nextPath || '/');
            } catch (error) {
              setRemoteBrowserStatus(describeApiError(error).message, true);
            }
          });

          document.getElementById('remote-browser-refresh').addEventListener('click', async () => {
            try {
              await refreshRemoteBrowser();
            } catch (error) {
              setRemoteBrowserStatus(describeApiError(error).message, true);
            }
          });

          document.getElementById('remote-browser-open-folder').addEventListener('click', async () => {
            const selected = currentBrowserEntries.find((entry) => entry.path === currentBrowserSelectedPath);
            if (!selected || selected.kind !== 'directory') {
              return;
            }
            try {
              await refreshRemoteBrowser(selected.path);
            } catch (error) {
              setRemoteBrowserStatus(describeApiError(error).message, true);
            }
          });

          document.getElementById('remote-browser-go').addEventListener('click', async () => {
            const targetPath = document.getElementById('remote-browser-path').value.trim();
            if (!targetPath) {
              return;
            }
            try {
              await refreshRemoteBrowser(targetPath);
            } catch (error) {
              setRemoteBrowserStatus(describeApiError(error).message, true);
            }
          });

          document.getElementById('remote-browser-new-folder').addEventListener('click', async () => {
            if (!selectedDeviceId || !currentBrowserSessionId || !currentBrowserCurrentPath) {
              return;
            }
            const name = window.prompt('New folder name');
            if (!name || !name.trim()) {
              return;
            }
            const base = currentBrowserCurrentPath === '/' ? '' : currentBrowserCurrentPath.replace(/\\\/$/, '');
            const nextPath = (base || '') + '/' + name.trim().replace(/^\\\/+/, '');
            try {
              await createRemoteBrowserDirectory(selectedDeviceId, currentBrowserSessionId, nextPath);
              await refreshRemoteBrowser(currentBrowserCurrentPath);
              setRemoteBrowserStatus('Created folder ' + nextPath);
            } catch (error) {
              setRemoteBrowserStatus(describeApiError(error).message, true);
            }
          });

          document.getElementById('remote-browser-delete').addEventListener('click', async () => {
            if (!selectedDeviceId || !currentBrowserSessionId || !currentBrowserSelectedPath) {
              return;
            }
            const selected = currentBrowserEntries.find((entry) => entry.path === currentBrowserSelectedPath);
            if (!selected) {
              return;
            }
            const recursive = selected.kind === 'directory';
            if (!window.confirm('Delete ' + currentBrowserSelectedPath + '?')) {
              return;
            }
            try {
              await deleteRemoteBrowserPath(selectedDeviceId, currentBrowserSessionId, currentBrowserSelectedPath, recursive);
              await refreshRemoteBrowser(currentBrowserCurrentPath || currentBrowserRootPath || '/');
              setRemoteBrowserStatus('Deleted ' + currentBrowserSelectedPath);
            } catch (error) {
              setRemoteBrowserStatus(describeApiError(error).message, true);
            }
          });

          document.getElementById('remote-browser-use-current').addEventListener('click', () => {
            if (!currentBrowserCurrentPath) {
              return;
            }
            setTransferRemotePath(currentBrowserCurrentPath);
            document.getElementById('summary-meta').textContent =
              'Chosen remote folder: ' + currentBrowserCurrentPath;
            setRemoteBrowserStatus('Selected current folder for future transfer actions.');
          });

          document.getElementById('remote-browser-use-selected').addEventListener('click', () => {
            if (!currentBrowserSelectedPath) {
              return;
            }
            if (currentBrowserSelectedEntry && currentBrowserSelectedEntry.kind !== 'directory') {
              const confirmed = window.confirm(
                'The selected path already exists. Future uploads to this exact path may require overwrite confirmation. Use it anyway?',
              );
              if (!confirmed) {
                setRemoteBrowserStatus('Overwrite-sensitive path selection canceled.', false);
                return;
              }
            }
            setTransferRemotePath(currentBrowserSelectedPath);
            document.getElementById('summary-meta').textContent =
              'Chosen remote path: ' + currentBrowserSelectedPath;
            setRemoteBrowserStatus(
              currentBrowserSelectedEntry && currentBrowserSelectedEntry.kind !== 'directory'
                ? 'Selected existing path. Future uploads should confirm overwrite unless force/skip is chosen.'
                : 'Selected remote path for future transfer actions.',
            );
          });

          document.getElementById('remote-browser-fill-selected').addEventListener('click', () => {
            if (!currentBrowserSelectedPath) {
              return;
            }
            setTransferRemotePath(currentBrowserSelectedPath);
            setRemoteBrowserStatus('Filled remote path from the current selection.');
          });

          document.getElementById('remote-browser-fill-current').addEventListener('click', () => {
            if (!currentBrowserCurrentPath) {
              return;
            }
            setTransferRemotePath(currentBrowserCurrentPath);
            setRemoteBrowserStatus('Filled remote path from the current folder.');
          });

          document.getElementById('remote-browser-start-upload').addEventListener('click', async () => {
            await initiateRemoteTransfer('upload');
          });

          document.getElementById('remote-browser-start-download').addEventListener('click', async () => {
            await initiateRemoteTransfer('download');
          });

          document.getElementById('remote-browser-close').addEventListener('click', async () => {
            await closeRemoteBrowserModal();
          });

          document.getElementById('remote-browser-backdrop').addEventListener('click', async (event) => {
            if (event.target.id === 'remote-browser-backdrop') {
              await closeRemoteBrowserModal();
            }
          });

          document.getElementById('logs-clear').addEventListener('click', () => {
            const output = document.getElementById('logs-output');
            output.innerHTML = '<span class="logs-empty">Logs cleared in the viewer.</span>';
          });

          document.getElementById('logs-pause-toggle').addEventListener('click', (event) => {
            isPaused = !isPaused;
            event.target.textContent = isPaused ? 'Resume' : 'Pause';
            if (selectedDeviceId) {
              document.getElementById('logs-status').textContent = isPaused
                ? 'Telemetry stream paused visually. Live data is still connected.'
                : 'Streaming telemetry for ' + selectedDeviceId;
            }
          });

          document.getElementById('token-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            try {
              const payload = await createAdminApiToken();
              showCreatedToken(payload);
              event.target.reset();
              document.getElementById('token-ttl-days').value = '90';
              renderTokenScopeOptions();
              await refreshAdminApiTokens();
            } catch (error) {
              document.getElementById('token-created').style.display = 'block';
              document.getElementById('token-created').innerHTML =
                '<strong>Failed to create token.</strong><div>' + escapeHtml(String(error)) + '</div>';
            }
          });

          document.querySelector('.topbar-logo')?.addEventListener('click', () => {
            openDevicesView();
          });
          document.querySelector('.topbar-nav button[data-page="devices"]')?.addEventListener('click', () => {
            openDevicesView();
          });
          document.querySelector('.topbar-nav button[data-page="config"]')?.addEventListener('click', () => {
            openConfigView();
          });

          document.getElementById('tokens-tbody').addEventListener('click', async (event) => {
            const button = event.target.closest('button[data-token-id]');
            if (!button || button.disabled) {
              return;
            }
            try {
              await revokeAdminApiToken(button.dataset.tokenId);
              await refreshAdminApiTokens();
            } catch (error) {
              console.error('Failed to revoke admin API token', error);
            }
          });

          window.setInterval(refreshDevices, 5000);
          window.setInterval(refreshRetentionSettings, 30000);
          window.setInterval(refreshAdminApiTokens, 30000);
          window.setInterval(refreshAlerts, 30000);

          const alertsBtn = document.getElementById('alerts-btn');
          const alertsPanel = document.getElementById('alerts-panel');
          const alertsBadge = document.getElementById('alerts-badge');
          const alertsPanelList = document.getElementById('alerts-panel-list');
          const alertsDeviceSummary = document.getElementById('device-summary');

          let dismissedAlertIds = new Set(JSON.parse(localStorage.getItem('dismissedAlerts') || '[]'));

          async function refreshAlerts() {
            try {
              const resp = await fetch('/admin/v1/alerts', { credentials: 'same-origin' });
              if (!resp.ok) return;
              const data = await resp.json();
              const alerts = (data.alerts || []).filter(a => !dismissedAlertIds.has(a.id));
              
              alertsBadge.textContent = alerts.length;
              alertsBadge.style.display = alerts.length > 0 ? 'block' : 'none';
              
              const connected = currentDevices.filter(d => d.status === 'connected').length;
              const errors = alerts.filter(a => a.severity === 'critical').length;
              alertsDeviceSummary.textContent = errors > 0 
                ? '\u{1F534} ' + errors + ' ' + (errors === 1 ? 'error' : 'errors') + ', ' + connected + ' connected'
                : '\u{1F7E2} ' + connected + ' connected';
              
              if (alerts.length === 0) {
                alertsPanelList.innerHTML = '<div class="alerts-empty-panel">No active alerts.</div>';
                return;
              }
              alertsPanelList.innerHTML = alerts.map(a => {
                return '<div class="alerts-panel-item" data-id="' + a.id + '">' +
                  '<div class="alerts-panel-dot ' + a.severity + '"></div>' +
                  '<div class="alerts-panel-content">' +
                    '<div class="alerts-panel-item-title">' + escapeHtml(a.title) + '</div>' +
                    '<div class="alerts-panel-item-text">' + escapeHtml(a.text) + '</div>' +
                    '<div class="alerts-panel-item-meta">' + escapeHtml(a.deviceId) + ' · ' + formatDateTime(a.ts) + '</div>' +
                  '</div>' +
                '</div>';
              }).join('');
              
              alertsPanelList.querySelectorAll('.alerts-panel-item').forEach(item => {
                item.addEventListener('click', () => {
                  const id = item.dataset.id;
                  dismissedAlertIds.add(id);
                  localStorage.setItem('dismissedAlerts', JSON.stringify([...dismissedAlertIds]));
                  item.remove();
                  const remaining = alertsPanelList.querySelectorAll('.alerts-panel-item').length;
                  alertsBadge.textContent = remaining;
                  alertsBadge.style.display = remaining > 0 ? 'block' : 'none';
                  if (remaining === 0) {
                    alertsPanelList.innerHTML = '<div class="alerts-empty-panel">No active alerts.</div>';
                  }
                });
              });
            } catch (e) {
              console.error('Failed to load alerts', e);
            }
          }

          document.getElementById('clear-alerts')?.addEventListener('click', () => {
            dismissedAlertIds = new Set();
            localStorage.removeItem('dismissedAlerts');
            refreshAlerts();
          });

          alertsBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            alertsPanel.classList.toggle('open');
          });

          document.addEventListener('click', (e) => {
            if (!alertsPanel.contains(e.target) && e.target !== alertsBtn) {
              alertsPanel.classList.remove('open');
            }
          });

          refreshAlerts();
          window.addEventListener('beforeunload', () => {
            if (ptySocket && ptySocket.readyState === WebSocket.OPEN) {
              const session = getSelectedPtySession();
              if (selectedDeviceId && session && isAdminSessionAttached(session)) {
                ptySocket.send(JSON.stringify({
                  type: 'pty_detach',
                  payload: { deviceId: selectedDeviceId, sessionId: session.sessionId },
                }));
              }
            }
            closePtySocket({ suppressReconnect: true });
            closeStream();
          });
          syncPtySelectionState();
          renderTokenScopeOptions();
          refreshDevices();
          refreshRetentionSettings();
          refreshAdminApiTokens();
        </script>
      </body>
      </html>
    `;
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

  private renderLoginPage(csrfToken: string, error?: string) {
    const errorHtml = error
      ? `<div style="color:#dc2626;margin-bottom:12px;">${error}</div>`
      : '';
    return `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>CC Admin Login</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #f5f5f5; display:flex; min-height:100vh; align-items:center; justify-content:center; }
          .card { width: 360px; background:white; padding:24px; border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.08); }
          h1 { margin-top:0; font-size:22px; }
          input, button { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px; font-size:14px; }
          input { border:1px solid #d1d5db; margin-bottom:12px; }
          button { border:0; background:#111827; color:white; cursor:pointer; }
        </style>
      </head>
      <body>
        <form class="card" method="post" action="/admin/login">
          <h1>CC Admin Login</h1>
          ${errorHtml}
          <input name="csrfToken" type="hidden" value="${csrfToken}" />
          <input name="password" type="password" placeholder="Admin password" autocomplete="current-password" />
          <button type="submit">Sign in</button>
        </form>
      </body>
      </html>
    `;
  }

  private renderRows() {
    const devices = this.deviceStore.getAllDevices();
    if (!devices.length) {
      return '<tr><td colspan="4" style="text-align:center;color:#868e96;">No devices enrolled</td></tr>';
    }
    return devices
      .map(
        (d) => `<tr>
        <td>${d.id}</td>
        <td>${d.name}</td>
        <td><span class="status-${d.status}">${d.status}</span></td>
        <td>${d.lastSeenAt}</td>
      </tr>`,
      )
      .join('');
  }

  private renderMeta() {
    const devices = this.deviceStore.getAllDevices();
    return `Total devices: ${devices.length} | Connected: ${
      devices.filter((d) => d.status === 'connected').length
    } | Last updated: ${new Date().toISOString()}`;
  }
}
