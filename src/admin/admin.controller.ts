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

@Controller('admin')
export class AdminController {
  constructor(
    private readonly deviceStore: DeviceStore,
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
          .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
          .summary-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: #f9fafb; }
          .summary-card.alert { border-color: #fca5a5; background: #fff1f2; }
          .summary-card h3 { margin: 0 0 6px; font-size: 14px; }
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
        </style>
        <link rel="stylesheet" href="/admin/assets/xterm.min.css" />
      </head>
      <body>
        <h1>CC Admin - Devices</h1>
        <form method="post" action="/admin/logout" class="meta">
          <input type="hidden" name="csrfToken" value="${csrfToken}" />
          <button type="submit" style="border:0;background:none;color:#1d4ed8;cursor:pointer;padding:0;">Log out</button>
        </form>
        <table>
          <thead>
            <tr>
              <th>Device ID</th>
              <th>Name</th>
              <th>Status</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody id="devices-tbody">${rows}</tbody>
        </table>
        <div id="devices-meta" class="meta">${meta}</div>
        <div class="polling">Auto-refresh every 5 seconds.</div>
        <section class="alerts-panel">
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
          let reconnectTimer = null;
          let streamConnectVersion = 0;
          let isPaused = false;
          let retentionSettings = null;
          let selectedSummary = null;
          let currentAdminApiTokens = [];
          let selectedTunnelRestartServerId = null;
          let serverPickerAction = null;
          let selectedCommandId = null;
          let currentCommands = [];
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
              return '<tr><td colspan="4" style="text-align:center;color:#868e96;">No devices enrolled</td></tr>';
            }
            return devices.map((device) => \`
              <tr data-device-id="\${escapeHtml(device.id)}" class="\${selectedDeviceId === device.id ? 'selected' : ''} \${device.status === 'disconnected' || isDeviceStale(device) ? 'alert-row' : ''}">
                <td>\${escapeHtml(device.id)}</td>
                <td>\${escapeHtml(device.name)}</td>
                <td><span class="status-\${escapeHtml(device.status)}">\${escapeHtml(device.status)}</span></td>
                <td>\${escapeHtml(device.lastSeenAt)}</td>
              </tr>
            \`).join('');
          }

          function renderMeta(devices) {
            const connected = devices.filter((device) => device.status === 'connected').length;
            const retention = retentionSettings
              ? \` | Retention: \${retentionSettings.maxEventsPerDevice} events/device, \${retentionSettings.maxAgeDays} day(s)\`
              : '';
            return \`Total devices: \${devices.length} | Connected: \${connected} | Last updated: \${new Date().toISOString()}\${retention}\`;
          }

          function formatDateTime(value) {
            if (!value) {
              return 'Never';
            }
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
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
              '<div class="token-secret">' + escapeHtml(payload.token) + '</div>';
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
	            document.getElementById('pty-send-ctrl-c').disabled = !hasDevice || !hasSession || !attachedByAdminSession;
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
                    setPtyStatus('Recording consent acknowledged for PTY session ' + payload.sessionId + '.');
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
              cards.push(
                '<div class="summary-card ' + ((isAlertState(item.state) || isWarningState(item.state) || isFunctionStale(item)) ? 'alert' : '') + '">' +
                  '<h3>' + escapeHtml(item.functionId || 'unknown') + '</h3>' +
                  '<div class="summary-state ' + escapeHtml(String(item.state || 'unknown')) + '">' + escapeHtml(String(item.state || 'unknown')) + '</div>' +
                  '<div>' + escapeHtml(String(item.message || '')) + '</div>' +
                  '<div class="summary-meta">Observed: ' + escapeHtml(String(item.observedAt || summary.updatedAt || '-')) + '</div>' +
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
            document.getElementById('server-picker-backdrop').classList.remove('open');
            document.getElementById('server-picker-backdrop').setAttribute('aria-hidden', 'true');
            document.getElementById('server-picker-list').innerHTML = '';
            document.getElementById('server-picker-confirm').disabled = true;
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
            document.getElementById('server-picker-confirm').disabled = !selectedTunnelRestartServerId;
          }

          function openServerPicker(servers, options) {
            selectedTunnelRestartServerId = null;
            serverPickerAction = options && options.action ? options.action : null;
            document.getElementById('server-picker-title').textContent = options && options.title ? options.title : 'Restart server action';
            document.getElementById('server-picker-note').textContent = options && options.note ? options.note : 'Choose a server from the selected device inventory.';
            document.getElementById('server-picker-confirm').textContent = options && options.confirmLabel ? options.confirmLabel : 'Restart action';
            renderServerPickerOptions(servers);
            document.getElementById('server-picker-backdrop').classList.add('open');
            document.getElementById('server-picker-backdrop').setAttribute('aria-hidden', 'false');
          }

          async function loadDeviceSummary(deviceId) {
            const params = new URLSearchParams({ deviceId });
            const response = await fetch('/v1/device-summary?' + params.toString());
            if (!response.ok) {
              throw new Error('Failed to load device summary');
            }
            return response.json();
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
              document.getElementById('devices-tbody').innerHTML = renderRows(devices);
              document.getElementById('devices-meta').textContent = renderMeta(devices);
              renderAlerts();
            } catch (error) {
              console.error('Failed to refresh devices', error);
            }
          }

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
            const row = event.target.closest('tr[data-device-id]');
            if (!row) {
              return;
            }
            startLogStream(row.dataset.deviceId);
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
              await refreshCommands(selectedDeviceId, result && result.command && result.command.commandId);
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
              await refreshCommands(selectedDeviceId, result && result.command && result.command.commandId);
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
              await refreshCommands(selectedDeviceId, result && result.command && result.command.commandId);
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
              await refreshCommands(selectedDeviceId, result && result.command && result.command.commandId);
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
              await refreshCommands(selectedDeviceId, result && result.command && result.command.commandId);
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

          document.getElementById('server-picker-list').addEventListener('click', (event) => {
            const button = event.target.closest('[data-server-id]');
            if (!button) {
              return;
            }
            selectedTunnelRestartServerId = button.dataset.serverId || null;
            Array.from(document.querySelectorAll('#server-picker-list .server-picker-item')).forEach((item) => {
              item.classList.toggle('selected', item.dataset.serverId === selectedTunnelRestartServerId);
            });
            document.getElementById('server-picker-confirm').disabled = !selectedTunnelRestartServerId;
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
            if (!selectedDeviceId || !selectedTunnelRestartServerId || !serverPickerAction) {
              return;
            }
            const serverId = selectedTunnelRestartServerId;
            try {
              if (serverPickerAction === 'restart-server-tunnel') {
                const result = await requestRestartServerTunnel(selectedDeviceId, serverId);
                document.getElementById('summary-meta').textContent =
                  'Requested server tunnel restart for ' + serverId + ' at ' + new Date().toISOString();
                await refreshCommands(selectedDeviceId, result && result.command && result.command.commandId);
              } else if (serverPickerAction === 'restart-server-ssh') {
                const result = await requestRestartServerSsh(selectedDeviceId, serverId);
                document.getElementById('summary-meta').textContent =
                  'Requested server SSH restart for ' + serverId + ' at ' + new Date().toISOString();
                await refreshCommands(selectedDeviceId, result && result.command && result.command.commandId);
              }
              closeServerPicker();
            } catch (error) {
              document.getElementById('summary-meta').textContent =
                serverPickerAction === 'restart-server-ssh'
                  ? 'Failed to request server SSH restart.'
                  : 'Failed to request server tunnel restart.';
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
