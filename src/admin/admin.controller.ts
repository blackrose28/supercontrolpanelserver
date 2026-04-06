import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Redirect,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { DeviceStore } from '../devices/device.store';
import { getAdminPassword } from '../config/auth';
import { Response } from 'express';
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_SESSION_COOKIE,
  ensureCsrfToken,
  isAdminAuthorized,
  parseCookies,
  requireCsrf,
} from './admin-auth';
import { AdminSessionService } from './admin-session.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { getClientId } from '../rate-limit/client-id';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly deviceStore: DeviceStore,
    private readonly adminSessions: AdminSessionService,
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
    if (!isAdminAuthorized(auth, cookie, this.adminSessions)) {
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
          tbody tr:hover { background: #f8f9fa; }
          tbody tr.selected { outline: 2px solid #12b886; outline-offset: -2px; }
          tbody tr.alert-row { background: #fff5f5; }
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
        </style>
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
          </div>
          <div id="summary-content" class="summary-grid"></div>
        </section>
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
        <script>
          let selectedDeviceId = null;
          let stream = null;
          let currentDevices = [];
          let reconnectTimer = null;
          let streamConnectVersion = 0;
          let isPaused = false;
          let retentionSettings = null;
          let selectedSummary = null;
          const STALE_DEVICE_MS = 2 * 60 * 1000;
          const STALE_FUNCTION_MS = 5 * 60 * 1000;
          const csrfToken = ${JSON.stringify(csrfToken)};

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
            const connectVersion = ++streamConnectVersion;
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
              await requestStatusSnapshot(selectedDeviceId);
              document.getElementById('summary-meta').textContent =
                'Requested fresh status snapshot at ' + new Date().toISOString();
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
              await requestInventory(selectedDeviceId);
              document.getElementById('summary-meta').textContent =
                'Requested inventory refresh at ' + new Date().toISOString();
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
              await requestRecentLogs(selectedDeviceId);
              document.getElementById('summary-meta').textContent =
                'Requested recent logs at ' + new Date().toISOString();
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
              await requestRestartOpenvpn(selectedDeviceId);
              document.getElementById('summary-meta').textContent =
                'Requested OpenVPN restart at ' + new Date().toISOString();
            } catch (error) {
              document.getElementById('summary-meta').textContent =
                'Failed to request OpenVPN restart.';
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

          window.setInterval(refreshDevices, 5000);
          window.setInterval(refreshRetentionSettings, 30000);
          window.addEventListener('beforeunload', () => {
            closeStream();
          });
          refreshDevices();
          refreshRetentionSettings();
        </script>
      </body>
      </html>
    `;
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
