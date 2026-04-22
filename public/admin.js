          let selectedDeviceId = null;
          let stream = null;
          let currentDevices = [];
          let onDevicesRefreshed = null; // callback after devices loaded
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
          let deviceSortColumn = 'last-seen';
          let deviceSortDirection = 'desc';
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
          const csrfToken = window.__CC_CSRF_TOKEN__;
          const adminApiScopes = window.__CC_ADMIN_API_SCOPES__;
          const formatBytes = window.AdminFormatters && window.AdminFormatters.formatBytes
            ? window.AdminFormatters.formatBytes
            : function formatBytes(value) {
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
            };

          const formatRate = window.AdminFormatters && window.AdminFormatters.formatRate
            ? window.AdminFormatters.formatRate
            : function formatRate(value) {
              const bytesPerSecond = Number(value);
              if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
                return '-';
              }
              return formatBytes(bytesPerSecond) + '/s';
            };

          const formatEta = window.AdminFormatters && window.AdminFormatters.formatEta
            ? window.AdminFormatters.formatEta
            : function formatEta(value) {
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
            };

          const tokenManager = window.AdminTokenManager && typeof window.AdminTokenManager.createTokenManager === 'function'
            ? window.AdminTokenManager.createTokenManager({
              escapeHtml,
              formatDateTime,
              adminApiScopes,
              csrfToken,
              setCurrentAdminApiTokens: (tokens) => {
                currentAdminApiTokens = tokens;
              },
            })
            : null;
          let dismissedAlertIds = new Set(JSON.parse(localStorage.getItem('dismissedAlerts') || '[]'));
          const alertsManager = window.AdminAlertsManager && typeof window.AdminAlertsManager.createAlertsManager === 'function'
            ? window.AdminAlertsManager.createAlertsManager({
              csrfToken,
              escapeHtml,
              formatDateTime,
              getCurrentDevices: () => currentDevices,
              getDismissedAlertIds: () => dismissedAlertIds,
              setDismissedAlertIds: (next) => {
                dismissedAlertIds = next;
              },
            })
            : null;
          const commandsPanel = window.AdminCommandsPanel && typeof window.AdminCommandsPanel.createCommandsPanel === 'function'
            ? window.AdminCommandsPanel.createCommandsPanel({
              escapeHtml,
              formatDateTime,
              formatPayload: (...args) => formatPayload(...args),
              getSelectedDeviceId: () => selectedDeviceId,
              getCurrentCommands: () => currentCommands,
              setCurrentCommands: (commands) => {
                currentCommands = commands;
              },
              getSelectedCommandId: () => selectedCommandId,
              setSelectedCommandId: (commandId) => {
                selectedCommandId = commandId;
              },
            })
            : null;
          const transfersPanel = window.AdminTransfersPanel && typeof window.AdminTransfersPanel.createTransfersPanel === 'function'
            ? window.AdminTransfersPanel.createTransfersPanel({
              escapeHtml,
              formatDateTime,
              formatBytes,
              formatRate,
              formatEta,
              defaultActionHintForReasonCode,
              humanizeReasonCode,
              getSelectedDeviceId: () => selectedDeviceId,
              getCurrentTransfers: () => currentTransfers,
              setCurrentTransfers: (transfers) => {
                currentTransfers = transfers;
              },
              getFetchJsonOrThrow: () => fetchJsonOrThrow,
            })
            : null;
          const telemetryWidgets = window.AdminTelemetryWidgets && typeof window.AdminTelemetryWidgets.createTelemetryWidgets === 'function'
            ? window.AdminTelemetryWidgets.createTelemetryWidgets({
              escapeHtml,
              getCurrentDevices: () => currentDevices,
              getTelemetryColors: () => TELEMETRY_COLORS,
              getTlmEvents: () => tlmEvents,
              setTlmEvents: (events) => {
                tlmEvents = events;
              },
              getTlmChart: () => tlmChartCtx,
              setTlmChart: (chart) => {
                tlmChartCtx = chart;
              },
            })
            : null;
          const logsStream = window.AdminLogsStream && typeof window.AdminLogsStream.createLogsStream === 'function'
            ? window.AdminLogsStream.createLogsStream({
              getIsPaused: () => isPaused,
              isAutoScrollEnabled,
              getSelectedDeviceId: () => selectedDeviceId,
              setSelectedDeviceId: (deviceId) => {
                selectedDeviceId = deviceId;
              },
              getCurrentDevices: () => currentDevices,
              getDeviceSortColumn: () => deviceSortColumn,
              getDeviceSortDirection: () => deviceSortDirection,
              getStreamConnectVersion: () => streamConnectVersion,
              setStreamConnectVersion: (version) => {
                streamConnectVersion = version;
              },
              getSelectedCommandId: () => selectedCommandId,
              getStream: () => stream,
              setStream: (nextStream) => {
                stream = nextStream;
              },
              getReconnectTimer: () => reconnectTimer,
              setReconnectTimer: (timer) => {
                reconnectTimer = timer;
              },
              clearReconnectTimer,
              closeStream,
              getActiveFilters,
              renderRows,
              sortDevices,
              detachCurrentPty,
              clearPtySelection: (...args) => ptyPanel.clearPtySelection(...args),
              loadDeviceSummary,
              renderSummary,
              refreshCommands: (...args) => refreshCommands(...args),
              startTransferStream,
              loadPtySessions: (...args) => ptyPanel.loadPtySessions(...args),
              setPtyStatus: (...args) => ptyPanel.setPtyStatus(...args),
              renderTransfers: (...args) => renderTransfers(...args),
              closeTransferStream,
            })
            : null;
          const serverBrowser = window.AdminServerBrowser && typeof window.AdminServerBrowser.createServerBrowser === 'function'
            ? window.AdminServerBrowser.createServerBrowser({
              escapeHtml,
              csrfToken,
              getSelectedDeviceId: () => selectedDeviceId,
              getSelectedSummary: () => selectedSummary,
              getSelectedTunnelRestartServerId: () => selectedTunnelRestartServerId,
              setSelectedTunnelRestartServerId: (serverId) => {
                selectedTunnelRestartServerId = serverId;
              },
              getServerPickerAction: () => serverPickerAction,
              setServerPickerAction: (action) => {
                serverPickerAction = action;
              },
              getServerPickerSubmitting: () => serverPickerSubmitting,
              setServerPickerSubmitting: (submitting) => {
                serverPickerSubmitting = submitting;
              },
              getCurrentBrowserSessionId: () => currentBrowserSessionId,
              setCurrentBrowserSessionId: (sessionId) => {
                currentBrowserSessionId = sessionId;
              },
              getCurrentBrowserServerId: () => currentBrowserServerId,
              setCurrentBrowserServerId: (serverId) => {
                currentBrowserServerId = serverId;
              },
              getCurrentBrowserRootPath: () => currentBrowserRootPath,
              setCurrentBrowserRootPath: (path) => {
                currentBrowserRootPath = path;
              },
              getCurrentBrowserCurrentPath: () => currentBrowserCurrentPath,
              setCurrentBrowserCurrentPath: (path) => {
                currentBrowserCurrentPath = path;
              },
              getCurrentBrowserSelectedPath: () => currentBrowserSelectedPath,
              setCurrentBrowserSelectedPath: (path) => {
                currentBrowserSelectedPath = path;
              },
              getCurrentBrowserSelectedEntry: () => currentBrowserSelectedEntry,
              setCurrentBrowserSelectedEntry: (entry) => {
                currentBrowserSelectedEntry = entry;
              },
              getCurrentBrowserEntries: () => currentBrowserEntries,
              setCurrentBrowserEntries: (entries) => {
                currentBrowserEntries = entries;
              },
              fetchJsonOrThrow,
              startTransfer,
              refreshCommandsSoon: (...args) => refreshCommandsSoon(...args),
              describeApiError,
              getTransferLocalPath,
              getTransferRemotePath,
              setTransferRemotePath,
              getTransferOptions,
              setTransferOverwritePolicy,
            })
            : null;
          const ptyPanel = window.AdminPtyPanel && typeof window.AdminPtyPanel.createPtyPanel === 'function'
            ? window.AdminPtyPanel.createPtyPanel({
              getSelectedDeviceId: () => selectedDeviceId,
              getCurrentPtySessions: () => currentPtySessions,
              setCurrentPtySessions: (sessions) => {
                currentPtySessions = sessions;
              },
              getCurrentPtySessionId: () => currentPtySessionId,
              setCurrentPtySessionId: (sessionId) => {
                currentPtySessionId = sessionId;
              },
              setCurrentPtyAttached: (attached) => {
                currentPtyAttached = attached;
              },
              getPtyOutputBuffers: () => ptyOutputBuffers,
              getPtyTerminal: (...args) => getPtyTerminal(...args),
              getExistingPtyTerminal: () => ptyTerminal,
              sanitizePtyDisplayText: (...args) => sanitizePtyDisplayText(...args),
              debugPty: (...args) => debugPty(...args),
              sendPtyMessage: (...args) => sendPtyMessage(...args),
              sortPtySessions: (...args) => sortPtySessions(...args),
              renderPtySessionSelect: (...args) => renderPtySessionSelect(...args),
              renderPtySessionMeta: (...args) => renderPtySessionMeta(...args),
              updatePtyControls: (...args) => updatePtyControls(...args),
              syncPtySizeInputs: (...args) => syncPtySizeInputs(...args),
              applyPtyTerminalSize: (...args) => applyPtyTerminalSize(...args),
              formatDateTime,
            })
            : null;

          function setTopbarPage(page) {
            document.querySelectorAll('.topbar-tab').forEach((button) => {
              button.classList.toggle('active', button.dataset.page === page);
            });
            document.querySelectorAll('.page').forEach((el) => {
              el.classList.toggle('active', el.dataset.page === page);
            });
          }

          function openConfigView() {
            setTopbarPage('config');
          }

          function openDevicesView() {
            setTopbarPage('devices');
          }

          function escapeHtml(value) {
            return String(value)
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;')
              .replaceAll('"', '&quot;')
              .replaceAll("'", '&#39;');
          }

          function osIcon(os) {
            if (os === 'windows') return '🪟';
            if (os === 'macos') return '🍎';
            if (os === 'linux') return '🐧';
            return '';
          }

          function sortDevices(devices, column, direction) {
            const sorted = devices.slice();
            sorted.sort((a, b) => {
              let cmp = 0;
              if (column === 'device') {
                cmp = (a.name || '').localeCompare(b.name || '');
              } else if (column === 'last-seen') {
                const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
                const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
                cmp = aTime - bTime;
              }
              return direction === 'desc' ? -cmp : cmp;
            });
            return sorted;
          }

          function applyDeviceSort() {
            const thead = document.querySelector('.devices-table thead');
            if (!thead) return;
            thead.querySelectorAll('.sortable').forEach((th) => {
              th.classList.remove('asc', 'desc');
              if (th.dataset.sort === deviceSortColumn) {
                th.classList.add(deviceSortDirection);
              }
            });
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
                '<td class="device-os">' + (device.os ? osIcon(device.os) + ' ' + escapeHtml(device.os) : '–') + '</td>',
                '<td class="last-seen">' + formatRelativeTime(device.lastSeenAt) + '</td>',
                '<td><div class="functions-dots">' + fnDots + '</div></td>',
                '<td class="actions-dropdown">',
                '<button type="button" class="actions-btn" data-device="' + escapeHtml(device.id) + '">Actions ▼</button>',
                '<div class="actions-menu" id="actions-' + escapeHtml(device.id) + '">',
                '<button type="button" data-action="logs">View logs</button>',
                '<button type="button" data-action="snapshot">Request snapshot</button>',
                '<button type="button" data-action="config">Config</button>',
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

          function debugPty(message, payload) {
            if (!window.__CC_PTY_DEBUG__) {
              return;
            }
            if (payload === undefined) {
              console.debug('[PTY]', message);
              return;
            }
            console.debug('[PTY]', message, payload);
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

          const renderTokenScopeOptions = tokenManager.renderTokenScopeOptions;
          const showCreatedToken = tokenManager.showCreatedToken;
          const renderAdminApiTokens = tokenManager.renderAdminApiTokens;
          const refreshAdminApiTokens = tokenManager.refreshAdminApiTokens;
          const createAdminApiToken = tokenManager.createAdminApiToken;
          const revokeAdminApiToken = tokenManager.revokeAdminApiToken;
          const toggleTokenReveal = tokenManager.toggleTokenReveal;


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
	                void ptyPanel.sendTerminalData(data);
	              });
	              ptyTerminalInputBound = true;
	            }
	            container.addEventListener('mousedown', () => {
                debugPty('terminal mouse focus', {
                  sessionId: currentPtySessionId,
                  attached: ptyPanel.isAdminSessionAttached(ptyPanel.getSelectedPtySession()),
                });
	              if (ptyPanel.isAdminSessionAttached(ptyPanel.getSelectedPtySession())) {
	                ptyTerminal.focus();
                  debugPty('terminal focused from mouse');
	              }
	            });
	            return ptyTerminal;
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
            const session = ptyPanel.getSelectedPtySession();
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
	            const session = ptyPanel.getSelectedPtySession();
	            const hasSession = !!session;
	            const attachedByAdminSession = ptyPanel.isAdminSessionAttached(session);
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
                const session = ptyPanel.getSelectedPtySession();
                if (session && ptyPanel.isAdminSessionAttached(session)) {
                  await sendPtyMessage('pty_attach', {
                    deviceId: selectedDeviceId,
                    sessionId: session.sessionId,
                  });
                  ptyPanel.setPtyStatus('Reattaching to PTY session ' + session.sessionId + '…');
                } else {
                  ptyPanel.setPtyStatus('PTY websocket reconnected.');
                }
              } catch (error) {
                ptyPanel.setPtyStatus('PTY websocket reconnect failed. Retrying…', true);
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
            ptyPanel.setPtyStatus('Connecting PTY websocket…');

            ptySocket.addEventListener('open', () => {
              clearPtyReconnectTimer();
              suppressNextPtyReconnect = false;
              ptyPanel.setPtyStatus('PTY websocket connected.');
            });
            ptySocket.addEventListener('message', async (event) => {
              try {
                const envelope = JSON.parse(event.data);
                const type = envelope && envelope.type;
                const payload = envelope && typeof envelope.payload === 'object' ? envelope.payload : {};
                if (type === 'pty_state') {
                  if (payload.state === 'connected') {
                    ptyPanel.setPtyStatus('PTY websocket connected.');
                  } else if (payload.warning) {
                    ptyPanel.setPtyStatus(String(payload.warning), true);
                  } else if (payload.consentGranted && payload.sessionId) {
                    const session = currentPtySessions.find((item) => item.sessionId === payload.sessionId);
                    if (session) {
                      session.recordingConsentAt = payload.recordingConsentAt || new Date().toISOString();
                    }
                    ptyPanel.setPtyStatus('Recording consent acknowledged for PTY session ' + payload.sessionId + '.');
                    ptyPanel.syncPtySelectionState();
                    await ptyPanel.loadPtySessions(selectedDeviceId, { preserveSelection: true }).catch(() => {});
                  } else if (payload.sessionId && payload.detached) {
                    ptyPanel.setPtyStatus('Detached from PTY session ' + payload.sessionId + '.');
                    await ptyPanel.loadPtySessions(selectedDeviceId, { preserveSelection: true }).catch(() => {});
                  }
                  return;
                }
	                if (type === 'pty_opened') {
	                  currentPtySessionId = typeof payload.sessionId === 'string' ? payload.sessionId : currentPtySessionId;
	                  if (currentPtySessionId && !ptyOutputBuffers.has(currentPtySessionId)) {
	                    ptyOutputBuffers.set(currentPtySessionId, '');
	                  }
	                  ptyPanel.setPtyStatus('PTY session ' + currentPtySessionId + ' attached.');
	                  await ptyPanel.loadPtySessions(selectedDeviceId, { preserveSelection: true }).catch(() => {});
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
                    ptyPanel.setPtyOutput(sessionId, replayData);
                    if (sessionId === currentPtySessionId) {
                      ptyPanel.setPtyStatus(payload.truncated
                        ? 'Replayed truncated PTY scrollback for ' + sessionId + '.'
                        : 'Replayed recent PTY scrollback for ' + sessionId + '.');
                    }
                  } else {
                    ptyPanel.appendPtyOutput(sessionId, data);
                    if (sessionId === currentPtySessionId) {
                      ptyPanel.setPtyStatus('Streaming PTY output for ' + sessionId + '.');
                    }
                  }
                  return;
                }
                if (type === 'pty_exit') {
                  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
                  const reason = typeof payload.reason === 'string' && payload.reason ? ' (' + payload.reason + ')' : '';
                  const exitCode = payload.exitCode != null ? ' exit=' + payload.exitCode : '';
                  ptyPanel.appendPtyOutput(sessionId, '\\n\\n[PTY exited' + exitCode + reason + ']\\n');
                  if (sessionId === currentPtySessionId) {
                    ptyPanel.setPtyStatus('PTY session ' + sessionId + ' exited' + reason + '.');
                  }
                  await ptyPanel.loadPtySessions(selectedDeviceId, { preserveSelection: true }).catch(() => {});
                  return;
                }
                if (type === 'pty_error') {
                  const code = payload && payload.code ? String(payload.code) : 'PTY_ERROR';
                  const message = payload && payload.message ? String(payload.message) : 'PTY action failed';
                  const retryAfterMs = payload && payload.retryAfterMs != null ? Number(payload.retryAfterMs) : null;
                  const suffix = payload && payload.rate_limited && retryAfterMs != null
                    ? ' Retry after ' + retryAfterMs + 'ms.'
                    : '';
                  ptyPanel.setPtyStatus(code + ': ' + message + suffix, true);
                }
              } catch (error) {
                console.error('Failed to parse PTY websocket message', error);
              }
            });
            ptySocket.addEventListener('close', () => {
              ptySocket = null;
              currentPtyAttached = false;
              updatePtyControls();
              ptyPanel.setPtyStatus('PTY websocket disconnected.', true);
              schedulePtyReconnect();
            });
            ptySocket.addEventListener('error', () => {
              ptyPanel.setPtyStatus('PTY websocket error.', true);
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
            const session = ptyPanel.getSelectedPtySession();
            if (!selectedDeviceId || !session || !ptyPanel.isAdminSessionAttached(session)) {
              return;
            }
            try {
              await sendPtyMessage('pty_detach', {
                deviceId: selectedDeviceId,
                sessionId: session.sessionId,
              });
              if (!silent) {
                ptyPanel.setPtyStatus('Detaching from PTY session ' + session.sessionId + '…');
              }
            } catch (error) {
              if (!silent) {
                ptyPanel.setPtyStatus('Failed to detach PTY session.', true);
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
                '<div class="summary-card ' + (isAlert ? 'alert ' : '') + 'clickable" data-fn-id="' + escapeHtml(fnId) + '" title="Click to scroll to recent logs">' +
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

          const renderCommands = commandsPanel.renderCommands;
          const renderCommandAudit = commandsPanel.renderCommandAudit;
          const loadCommandAudit = commandsPanel.loadCommandAudit;
          const refreshCommands = commandsPanel.refreshCommands;
          const refreshCommandsSoon = commandsPanel.refreshCommandsSoon;

          const summarizeTransfer = transfersPanel.summarizeTransfer;
          const updateTransferToolbarState = transfersPanel.updateTransferToolbarState;
          const renderTransfers = transfersPanel.renderTransfers;
          const upsertTransfer = transfersPanel.upsertTransfer;
          const loadTransfers = transfersPanel.loadTransfers;
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

          async function postTransferAction(path, body, unavailableMessage) {
            if (!selectedDeviceId) {
              throw new Error('No device selected.');
            }
            if (unavailableMessage) {
              throw new Error(unavailableMessage);
            }
            return fetchJsonOrThrow(path, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ csrfToken, deviceId: selectedDeviceId, ...body }),
            });
          }

          async function postDeviceRequest(path, deviceId, body) {
            const response = await fetch('/v1/devices/' + encodeURIComponent(deviceId) + '/' + path, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ csrfToken, ...(body || {}) }),
            });
            if (!response.ok) {
              throw new Error(await response.text());
            }
            return response.json();
          }

          function resumeTransferPayload(record) {
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

          async function requestRestart(path, deviceId, serverId) {
            return postDeviceRequest(path, deviceId, serverId ? { serverId } : undefined);
          }

          async function stopTransfer(record) {
            return postTransferAction(
              '/v1/file-transfers/stop',
              { transferId: String(record.transferId) },
              !transfersPanel.canStopTransfer(record) ? 'Stop is not available for this transfer.' : null,
            );
          }

          async function forceRemoveTransfer(record) {
            return postTransferAction(
              '/v1/file-transfers/force-remove',
              { transferId: String(record.transferId) },
              !transfersPanel.canForceRemoveTransfer(record) ? 'Force remove is not available for this transfer.' : null,
            );
          }

          async function dismissFinishedTransfers() {
            return postTransferAction('/v1/file-transfers/dismiss-finished', {}, null);
          }

          async function dismissTransfer(record) {
            return postTransferAction(
              '/v1/file-transfers/dismiss',
              { transferId: String(record.transferId) },
              !transfersPanel.canDismissTransfer(record) ? 'Dismiss is not available for this transfer.' : null,
            );
          }

          async function resumeTransfer(record) {
            if (!selectedDeviceId) {
              throw new Error('No device selected.');
            }
            if (!transfersPanel.canResumeTransfer(record)) {
              throw new Error('Resume is not available for this transfer.');
            }
            return startTransfer(selectedDeviceId, String(record.direction), resumeTransferPayload(record));
          }

          async function requestStatusSnapshot(deviceId) {
            return postDeviceRequest('request-status-snapshot', deviceId);
          }

          async function requestInventory(deviceId) {
            return postDeviceRequest('request-inventory', deviceId);
          }

          async function requestRecentLogs(deviceId) {
            return postDeviceRequest('request-recent-logs', deviceId);
          }

          async function requestRestartOpenvpn(deviceId) {
            return requestRestart('request-restart-openvpn', deviceId);
          }

          async function requestRestartBoundaryAuth(deviceId) {
            return requestRestart('request-restart-boundary-auth', deviceId);
          }

          async function requestRestartServerTunnel(deviceId, serverId) {
            return requestRestart('request-restart-server-tunnel', deviceId, serverId);
          }

          async function requestRestartServerSsh(deviceId, serverId) {
            return requestRestart('request-restart-server-ssh', deviceId, serverId);
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

          const getRestartTunnelCandidates = serverBrowser.getRestartTunnelCandidates;
          const getRestartSshCandidates = serverBrowser.getRestartSshCandidates;
          const closeServerPicker = serverBrowser.closeServerPicker;
          const renderServerPickerOptions = serverBrowser.renderServerPickerOptions;
          const openServerPicker = serverBrowser.openServerPicker;
          const setRemoteBrowserStatus = serverBrowser.setRemoteBrowserStatus;
          const updateRemoteBrowserActionState = serverBrowser.updateRemoteBrowserActionState;
          const renderRemoteBrowserEntries = serverBrowser.renderRemoteBrowserEntries;
          const createRemoteBrowserDirectory = serverBrowser.createRemoteBrowserDirectory;
          const deleteRemoteBrowserPath = serverBrowser.deleteRemoteBrowserPath;
          const refreshRemoteBrowser = serverBrowser.refreshRemoteBrowser;
          const initiateRemoteTransfer = serverBrowser.initiateRemoteTransfer;
          const showRemoteBrowser = serverBrowser.showRemoteBrowser;
          const closeRemoteBrowserModal = serverBrowser.closeRemoteBrowserModal;

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


          async function refreshDevices() {
            try {
              const response = await fetch('/v1/devices');
              if (!response.ok) {
                return;
              }
              const devices = await response.json();
              currentDevices = devices;
              if (onDevicesRefreshed) onDevicesRefreshed();
              applyDeviceSort();
              const searchFilter = (document.getElementById('devices-search')?.value || '').toLowerCase().trim();
              const filtered = searchFilter 
                ? devices.filter(d => d.id.toLowerCase().includes(searchFilter) || (d.name && d.name.toLowerCase().includes(searchFilter)))
                : devices;
              document.getElementById('devices-tbody').innerHTML = renderRows(sortDevices(filtered, deviceSortColumn, deviceSortDirection));
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
            document.getElementById('devices-tbody').innerHTML = renderRows(sortDevices(filtered, deviceSortColumn, deviceSortDirection));
          });

          document.querySelector('.devices-table thead')?.addEventListener('click', (event) => {
            const th = event.target.closest('th.sortable');
            if (!th) return;
            const column = th.dataset.sort;
            if (deviceSortColumn === column) {
              deviceSortDirection = deviceSortDirection === 'asc' ? 'desc' : 'asc';
            } else {
              deviceSortColumn = column;
              deviceSortDirection = column === 'device' ? 'asc' : 'desc';
            }
            applyDeviceSort();
            const searchFilter = (document.getElementById('devices-search')?.value || '').toLowerCase().trim();
            const filtered = searchFilter
              ? currentDevices.filter(d => d.id.toLowerCase().includes(searchFilter) || (d.name && d.name.toLowerCase().includes(searchFilter)))
              : currentDevices;
            document.getElementById('devices-tbody').innerHTML = renderRows(sortDevices(filtered, deviceSortColumn, deviceSortDirection));
          });

          const appendLog = logsStream.appendLog;
          const formatPayload = logsStream.formatPayload;
          const loadLogHistory = logsStream.loadLogHistory;
          const exportLogs = logsStream.exportLogs;
          const scheduleReconnect = logsStream.scheduleReconnect;
          const startLogStream = logsStream.startLogStream;

          document.getElementById('devices-tbody').addEventListener('click', (event) => {
            const actionButton = event.target.closest('.actions-btn');
            if (actionButton) {
              event.preventDefault();
              event.stopPropagation();
              const menu = actionButton.parentElement?.querySelector('.actions-menu');
              const shouldOpen = menu ? !menu.classList.contains('open') : false;
              Array.from(document.querySelectorAll('.actions-menu.open')).forEach((item) => {
                item.classList.remove('open');
              });
              if (menu && shouldOpen) {
                // Use setTimeout to prevent immediate closing by document click handler
                setTimeout(() => {
                  menu.classList.add('open');
                }, 0);
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
                setTopbarPage('telemetry');
                setTimeout(() => {
                  document.getElementById('logs-output')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 100);
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
            // Don't close if clicking on the actions button itself
            if (event.target.closest('.actions-btn')) {
              return;
            }
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
            const dismissibleCount = currentTransfers.filter((item) => transfersPanel.canDismissTransfer(item)).length;
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
              renderTransfers(currentTransfers.filter((item) => !transfersPanel.canDismissTransfer(item)));
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

          async function handleTransferListAction(action, transferId, record, button) {
            const handlers = {
              'force-remove': {
                canRun: transfersPanel.canForceRemoveTransfer,
                unavailable: 'Force remove is not available for this transfer.',
                pending: 'Removing…',
                run: () => forceRemoveTransfer(record),
                onSuccess: () => {
                  renderTransfers(currentTransfers.filter((item) => item && item.transferId !== transferId));
                  document.getElementById('transfers-meta').textContent =
                    'Force removed transfer ' + transferId + ' at ' + new Date().toISOString() + '.';
                },
                failPrefix: 'Failed to force remove transfer ' + transferId + ': ',
                needsConfirm: true,
                confirmMessage: 'Force remove this transfer history item? This may not stop work on the agent if it is still running.',
              },
              stop: {
                canRun: transfersPanel.canStopTransfer,
                unavailable: 'Stop is not available for this transfer.',
                pending: 'Stopping…',
                run: () => stopTransfer(record),
                onSuccess: () => {
                  document.getElementById('transfers-meta').textContent =
                    'Requested stop for transfer ' + transferId + ' at ' + new Date().toISOString() + '.';
                },
                failPrefix: 'Failed to stop transfer ' + transferId + ': ',
              },
              resume: {
                canRun: transfersPanel.canResumeTransfer,
                unavailable: 'Resume is not available for this transfer.',
                pending: 'Resuming…',
                run: async () => {
                  const result = await resumeTransfer(record);
                  refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
                },
                onSuccess: () => {
                  document.getElementById('transfers-meta').textContent =
                    'Requested resume for transfer ' + transferId + ' at ' + new Date().toISOString() + '.';
                },
                failPrefix: 'Failed to resume transfer ' + transferId + ': ',
              },
              dismiss: {
                canRun: transfersPanel.canDismissTransfer,
                unavailable: 'Dismiss is not available for this transfer.',
                pending: 'Dismissing…',
                run: () => dismissTransfer(record),
                onSuccess: () => {
                  renderTransfers(currentTransfers.filter((item) => item && item.transferId !== transferId));
                  document.getElementById('transfers-meta').textContent =
                    'Dismissed transfer ' + transferId + ' at ' + new Date().toISOString() + '.';
                },
                failPrefix: 'Failed to dismiss transfer ' + transferId + ': ',
              },
            };
            const handler = handlers[action];
            if (!handler) {
              return;
            }
            if (!handler.canRun(record)) {
              document.getElementById('transfers-meta').textContent = handler.unavailable;
              return;
            }
            if (handler.needsConfirm && !window.confirm(handler.confirmMessage)) {
              return;
            }
            const originalLabel = button.textContent || action;
            button.disabled = true;
            button.textContent = handler.pending;
            try {
              await handler.run();
              handler.onSuccess();
            } catch (error) {
              const detail = describeApiError(error);
              document.getElementById('transfers-meta').textContent = handler.failPrefix + detail.message;
            } finally {
              button.disabled = false;
              button.textContent = originalLabel;
            }
          }

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
            await handleTransferListAction(action, transferId, record, button);
          });

          document.getElementById('pty-session-select').addEventListener('change', (event) => {
            currentPtySessionId = event.target.value || null;
            ptyPanel.syncPtySelectionState();
          });

          document.getElementById('pty-refresh-sessions').addEventListener('click', async () => {
            if (!selectedDeviceId) {
              return;
            }
            try {
              await ptyPanel.loadPtySessions(selectedDeviceId, { preserveSelection: true });
              ptyPanel.setPtyStatus('PTY session list refreshed.');
            } catch (error) {
              ptyPanel.setPtyStatus('Failed to load PTY sessions.', true);
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
              ptyPanel.setPtyStatus('Opening and attaching PTY session…');
            } catch (error) {
              ptyPanel.setPtyStatus('Failed to open PTY session.', true);
            }
          });

          document.getElementById('pty-attach').addEventListener('click', async () => {
            const session = ptyPanel.getSelectedPtySession();
            if (!selectedDeviceId || !session) {
              return;
            }
            try {
              await sendPtyMessage('pty_attach', { deviceId: selectedDeviceId, sessionId: session.sessionId });
              ptyPanel.setPtyStatus('Reattaching to PTY session ' + session.sessionId + '…');
            } catch (error) {
              ptyPanel.setPtyStatus('Failed to attach PTY session.', true);
            }
          });

          document.getElementById('pty-resize').addEventListener('click', async () => {
            const session = ptyPanel.getSelectedPtySession();
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
              ptyPanel.setPtyStatus('Resized PTY session ' + session.sessionId + ' to ' + cols + 'x' + rows + '.');
            } catch (error) {
              ptyPanel.setPtyStatus('Failed to resize PTY session.', true);
            }
          });

          document.getElementById('pty-detach').addEventListener('click', async () => {
            await detachCurrentPty();
          });

	          document.getElementById('pty-close').addEventListener('click', async () => {
	            const session = ptyPanel.getSelectedPtySession();
            if (!selectedDeviceId || !session) {
              return;
            }
            try {
              await sendPtyMessage('pty_close', { deviceId: selectedDeviceId, sessionId: session.sessionId });
              ptyPanel.setPtyStatus('Closing PTY session ' + session.sessionId + '…');
            } catch (error) {
              ptyPanel.setPtyStatus('Failed to close PTY session.', true);
            }
          });

          document.getElementById('pty-recording-consent').addEventListener('click', async () => {
            const session = ptyPanel.getSelectedPtySession();
            if (!selectedDeviceId || !session) {
              return;
            }
            try {
              await sendPtyMessage('pty_recording_consent', { deviceId: selectedDeviceId, sessionId: session.sessionId });
              ptyPanel.setPtyStatus('Acknowledging recording consent for ' + session.sessionId + '…');
            } catch (error) {
              ptyPanel.setPtyStatus('Failed to acknowledge PTY recording consent.', true);
            }
          });

	          document.getElementById('pty-send-ctrl-c').addEventListener('click', async () => {
	            try {
	              await ptyPanel.sendTerminalData('\\u0003');
	            } catch (error) {
	              ptyPanel.setPtyStatus('Failed to send Ctrl+C.', true);
	            }
	          });

	          document.getElementById('pty-delete').addEventListener('click', async () => {
	            const session = ptyPanel.getSelectedPtySession();
	            if (!selectedDeviceId || !session) {
	              return;
	            }
	            if (!['closed', 'expired', 'failed'].includes(session.state)) {
	              ptyPanel.setPtyStatus('Only closed, expired, or failed PTY sessions can be deleted.', true);
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
	              await ptyPanel.loadPtySessions(selectedDeviceId, { preserveSelection: true });
	              ptyPanel.setPtyStatus('Deleted PTY session ' + session.sessionId + '.');
	            } catch (error) {
	              ptyPanel.setPtyStatus('Failed to delete PTY session.', true);
	            }
	          });

          document.getElementById('pty-clear-output').addEventListener('click', () => {
            if (currentPtySessionId) {
              ptyPanel.setPtyOutput(currentPtySessionId, '');
            } else {
              ptyPanel.renderPtyOutput();
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

          async function handleRequestAction(runRequest, successText, failureText) {
            if (!selectedDeviceId) {
              return;
            }
            try {
              const result = await runRequest(selectedDeviceId);
              document.getElementById('summary-meta').textContent = successText + new Date().toISOString();
              refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
            } catch (error) {
              document.getElementById('summary-meta').textContent = failureText;
            }
          }

          function openServerPickerForAction(candidates, emptyMessage, options) {
            if (!selectedDeviceId) {
              return;
            }
            if (!candidates.length) {
              document.getElementById('summary-meta').textContent = emptyMessage;
              return;
            }
            openServerPicker(candidates, options);
          }

          document.getElementById('request-status-snapshot').addEventListener('click', async () => {
            await handleRequestAction(
              requestStatusSnapshot,
              'Requested fresh status snapshot at ',
              'Failed to request fresh status snapshot.',
            );
          });

          document.getElementById('request-inventory').addEventListener('click', async () => {
            await handleRequestAction(
              requestInventory,
              'Requested inventory refresh at ',
              'Failed to request inventory refresh.',
            );
          });

          document.getElementById('request-recent-logs').addEventListener('click', async () => {
            await handleRequestAction(
              requestRecentLogs,
              'Requested recent logs at ',
              'Failed to request recent logs.',
            );
          });

          document.getElementById('request-restart-openvpn').addEventListener('click', async () => {
            await handleRequestAction(
              requestRestartOpenvpn,
              'Requested OpenVPN restart at ',
              'Failed to request OpenVPN restart.',
            );
          });

          document.getElementById('request-restart-boundary-auth').addEventListener('click', async () => {
            await handleRequestAction(
              requestRestartBoundaryAuth,
              'Requested Boundary auth restart at ',
              'Failed to request Boundary auth restart.',
            );
          });

          document.getElementById('request-restart-server-tunnel').addEventListener('click', async () => {
            openServerPickerForAction(
              getRestartTunnelCandidates(),
              'No Boundary servers available in inventory. Request inventory first.',
              {
                action: 'restart-server-tunnel',
                title: 'Restart server tunnel',
                note: 'Choose a Boundary-backed server from the selected device inventory.',
                confirmLabel: 'Restart tunnel',
              },
            );
          });

          document.getElementById('request-restart-server-ssh').addEventListener('click', async () => {
            openServerPickerForAction(
              getRestartSshCandidates(),
              'No servers available in inventory. Request inventory first.',
              {
                action: 'restart-server-ssh',
                title: 'Restart server SSH',
                note: 'Choose a server from the selected device inventory.',
                confirmLabel: 'Restart SSH',
              },
            );
          });

          document.getElementById('open-remote-browser').addEventListener('click', async () => {
            openServerPickerForAction(
              getRestartSshCandidates(),
              'No servers available in inventory. Request inventory first.',
              {
                action: 'open-remote-browser',
                title: 'Open remote browser',
                note: 'Choose a server from the selected device inventory to browse remote paths.',
                confirmLabel: 'Open browser',
              },
            );
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
            const serverPickerHandlers = {
              'restart-server-tunnel': {
                run: () => requestRestartServerTunnel(selectedDeviceId, serverId),
                success: 'Requested server tunnel restart for ' + serverId + ' at ' + new Date().toISOString(),
                failure: 'Failed to request server tunnel restart. ',
              },
              'restart-server-ssh': {
                run: () => requestRestartServerSsh(selectedDeviceId, serverId),
                success: 'Requested server SSH restart for ' + serverId + ' at ' + new Date().toISOString(),
                failure: 'Failed to request server SSH restart. ',
              },
              'open-remote-browser': {
                run: async () => {
                  closeServerPicker();
                  await showRemoteBrowser(serverId);
                },
                success: 'Opened remote browser for ' + serverId + ' at ' + new Date().toISOString(),
                failure: 'Failed to open remote browser. ',
                keepOpen: true,
              },
            };
            const handler = serverPickerHandlers[activeAction];
            if (!handler) {
              return;
            }
            try {
              const result = await handler.run();
              document.getElementById('summary-meta').textContent = handler.success;
              if (!handler.keepOpen) {
                refreshCommandsSoon(selectedDeviceId, result && result.command && result.command.commandId);
                closeServerPicker();
              }
            } catch (error) {
              const detail = describeApiError(error);
              document.getElementById('summary-meta').textContent = handler.failure + detail.message;
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

          document.getElementById('topbar-logo-link')?.addEventListener('click', () => {
            openDevicesView();
          });
          document.querySelectorAll('.topbar-tab').forEach((btn) => {
            btn.addEventListener('click', () => {
              setTopbarPage(btn.dataset.page);
            });
          });
          document.getElementById('gear-btn')?.addEventListener('click', () => {
            openConfigView();
          });

          document.getElementById('summary-content')?.addEventListener('click', (e) => {
            const card = e.target.closest('.summary-card.clickable');
            if (!card) return;
            const fnId = card.dataset.fnId;
            if (!fnId) return;
            const commandsEl = document.getElementById('commands-list');
            if (commandsEl) {
              commandsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          });

          document.getElementById('tokens-tbody').addEventListener('click', async (event) => {
            const maskedSpan = event.target.closest('.token-masked');
            if (maskedSpan) {
              toggleTokenReveal(maskedSpan.dataset.tokenFull);
              return;
            }
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
          window.setInterval(() => refreshAlerts(), 30000);

          const alertsBtn = document.getElementById('alerts-btn');
          const alertsPanel = document.getElementById('alerts-panel');
          const alertsBadge = document.getElementById('alerts-badge');
          const alertsPanelList = document.getElementById('alerts-panel-list');
          const alertsDeviceSummary = document.getElementById('device-summary');

          const refreshAlerts = alertsManager && typeof alertsManager.refreshAlerts === 'function'
            ? () => alertsManager.refreshAlerts({
              alertsBadge,
              alertsPanelList,
              alertsDeviceSummary,
            })
            : async function refreshAlerts() {
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
                  item.addEventListener('click', async () => {
                    const id = item.dataset.id;
                    dismissedAlertIds.add(id);
                    localStorage.setItem('dismissedAlerts', JSON.stringify([...dismissedAlertIds]));
                    item.style.opacity = '0.4';
                    try {
                      await fetch('/admin/v1/alerts/dismiss', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ csrfToken, alertId: id }),
                        credentials: 'same-origin',
                      });
                    } catch { /* server dismiss is best-effort */ }
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
            };

          alertsManager.setupHandlers({
            alertsBtn,
            alertsPanel,
            clearAlertsBtn: document.getElementById('clear-alerts'),
          }, refreshAlerts);

          refreshAlerts();
          window.addEventListener('beforeunload', () => {
            if (ptySocket && ptySocket.readyState === WebSocket.OPEN) {
              const session = ptyPanel.getSelectedPtySession();
              if (selectedDeviceId && session && ptyPanel.isAdminSessionAttached(session)) {
                ptySocket.send(JSON.stringify({
                  type: 'pty_detach',
                  payload: { deviceId: selectedDeviceId, sessionId: session.sessionId },
                }));
              }
            }
            closePtySocket({ suppressReconnect: true });
            closeStream();
          });
          ptyPanel.syncPtySelectionState();
          renderTokenScopeOptions();
          refreshDevices();
          refreshRetentionSettings();
          refreshAdminApiTokens();

          /* ── Telemetry page ── */
          const TELEMETRY_COLORS = {
            'function-status': '#3b82f6',
            'pty-output': '#6b7280',
            'pty-exit': '#f59e0b',
            'openvpn-log': '#8b5cf6',
            'inventory': '#10b981',
            'recent_logs': '#ec4899',
          };
          let tlmEvents = [];
          let tlmChartCtx = null;

          const buildTlmDeviceDropdown = telemetryWidgets.buildTlmDeviceDropdown;
          const loadTelemetry = telemetryWidgets.loadTelemetry;
          const exportTlm = telemetryWidgets.exportTlm;

          document.getElementById('tlm-load').addEventListener('click', loadTelemetry);
          document.getElementById('tlm-export-json').addEventListener('click', () => exportTlm('json'));
          document.getElementById('tlm-export-csv').addEventListener('click', () => exportTlm('csv'));

          onDevicesRefreshed = buildTlmDeviceDropdown;

          // Default time range: last 24 hours
          (function setDefaultRange() {
            const to = new Date();
            const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
            document.getElementById('tlm-to').value = to.toISOString().slice(0, 16);
            document.getElementById('tlm-from').value = from.toISOString().slice(0, 16);
          })();
