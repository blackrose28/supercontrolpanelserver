// Barrel re-exports — all modules are available from this entry point so that
// existing tests and Cloudflare Worker bindings continue to work unchanged.

export type { WorkerEnv, AdminPrincipal, DurableObjectNamespaceLike, DurableObjectStateLike, WorkerExecutionContext } from './types';
export { nowMs, makeUuid, requireD1 } from './env-helpers';
export {
  applySecurityHeaders, jsonResponse, redirectResponse,
  parseCookies, appendCookie, parseRequestFields, parseJsonBody,
  getClientId, clampNumber, sseFrame, sseStreamResponse, streamPollMs,
  decompressGzipBody, ADMIN_SESSION_COOKIE, ADMIN_CSRF_COOKIE,
} from './http';
export {
  getBearerToken, hasValidStaticAdminBearer, csrfTokenFromBody,
  requireCsrfForCookieMutation, hasScopes, authenticateAdmin,
  requireAdminAuth, isAdminAuthorized, requireAdmin, requireAdminBody,
  requireAdminAndDevice, requireAdminDeviceFromBody, authenticateAgentRequest,
  adminActorType, adminActorId, adminSessionStore, totpStore, makeCsrfToken,
} from './auth';
export {
  appendAgentTelemetry, handleAgentRunObservation, sendAgentAck,
  updateCommandFromAgentResponse, updateCommandFromAgentStatus,
  markPtySessionOpenForAgentAck, failPtySessionForMissingAgentPty,
  handleAgentSocketMessage,
} from './agent-socket';
export {
  publicCommand, agentDurableObjectStub, agentEnvelopeTypeForCommand,
  makeCommandEnvelope, safeWebSocketSend, websocketSend,
  notifyAgentDurableObject, handleAgentWebSocket, handleAgentProtocolProbe,
  handleAgentPolling, handleAgentLongPoll, handleAgentSSE,
  handleAdminPtyWebSocket, sendAgentRequest,
} from './agent-transport';
export { relayPtyToAdminSubscribers, handleAdminPtyUpgrade } from './admin-pty-routes';
export {
  publicDevice, handleListDevices, handleGetDevice, handleDeleteDevice,
  handleRevokeDevice, handleDevicesStream, handleDeviceSummary,
} from './routes/devices';
export {
  handleListCommands, handleGetCommand, handleListCommandAudit,
  handleCommandsStream, dispatchGenericAgentCommand,
  handleStartServerSshCommand, handleAttachServerSshCommand,
} from './routes/commands';
export {
  resolveLogFilter, normalizeIngestEvents,
  handleListLogs, handleExportLogs, handleLogSettings,
  handleTelemetry, handleTelemetryStream, handleIngestLogs,
  handleListPtySessions, handleTunnelLogs,
} from './routes/logs';
export {
  isFinishedTransferState, remoteBrowserCommandByPath,
  handleListFileTransfers, handleDismissFileTransfer,
  handleForceRemoveFileTransfer, handleStopFileTransfer,
  handleDismissFinishedFileTransfers, handleTransfersStream,
  handleOpenRemoteBrowser, handleRemoteBrowserCommand,
  handleStartScpTransfer,
} from './routes/file-transfers';
export {
  handleListApiTokens, handleCreateApiToken, handleRevokeApiToken,
  handleTotpStatus, handleTotpSetup, handleTotpVerifySetup,
  handleTotpDisable, handleTotpRecoveryCodes, handleTotpRegenerateRecoveryCodes,
  handleAdminLogin, handleAdminLogout, handleListAdminSessions,
  handleListAdminAudit, handleEnroll,
} from './routes/admin-auth';
export { AgentConnectionDurableObject } from './durable-objects/agent-connection';
export { AdminPtyHubDurableObject } from './durable-objects/admin-pty-hub';

// Re-export stream-dedupe for tests that may need it
export { BoundedSeenIds } from './stream-dedupe';

// ---------------------------------------------------------------------------
// Router — the main fetch() handler that dispatches requests to route modules
// ---------------------------------------------------------------------------

import type { WorkerEnv, WorkerExecutionContext } from './types';
import { jsonResponse } from './http';
import { handleAgentWebSocket, handleAgentProtocolProbe, handleAgentLongPoll } from './agent-transport';
import { handleAdminPtyUpgrade } from './admin-pty-routes';
import {
  handleListApiTokens, handleCreateApiToken, handleRevokeApiToken,
  handleTotpStatus, handleTotpSetup, handleTotpVerifySetup,
  handleTotpDisable, handleTotpRecoveryCodes, handleTotpRegenerateRecoveryCodes,
  handleAdminLogin, handleAdminLogout, handleListAdminSessions,
  handleListAdminAudit, handleEnroll,
} from './routes/admin-auth';
import {
  handleListDevices, handleGetDevice, handleDeleteDevice,
  handleRevokeDevice, handleDevicesStream, handleDeviceSummary,
} from './routes/devices';
import {
  handleListCommands, handleGetCommand, handleListCommandAudit,
  handleCommandsStream, dispatchGenericAgentCommand,
  handleStartServerSshCommand, handleAttachServerSshCommand,
} from './routes/commands';
import {
  handleListLogs, handleExportLogs, handleLogSettings,
  handleTelemetry, handleTelemetryStream, handleIngestLogs,
  handleListPtySessions, handleTunnelLogs,
} from './routes/logs';
import {
  remoteBrowserCommandByPath,
  handleListFileTransfers, handleDismissFileTransfer,
  handleForceRemoveFileTransfer, handleStopFileTransfer,
  handleDismissFinishedFileTransfers, handleTransfersStream,
  handleOpenRemoteBrowser, handleRemoteBrowserCommand,
  handleStartScpTransfer,
} from './routes/file-transfers';

async function safeFetch(request: Request, env: WorkerEnv = {}, ctx?: WorkerExecutionContext): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const requestId = request.headers.get('x-request-id')
    || request.headers.get('cf-ray')
    || `req-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const baseLog = {
    requestId,
    method: request.method,
    path: url.pathname,
  };

  console.info('Worker request started', baseLog);

  const slowLogMs = Math.max(100, Number(env.requestSlowLogMs) || 5000);
  const slowTimer = setTimeout(() => {
    console.warn('Worker request still running', {
      ...baseLog,
      elapsedMs: Date.now() - startedAt,
      query: url.search || undefined,
    });
  }, slowLogMs);

  try {
    const response = await routingFetch(request, env, ctx);
    try {
      response.headers.set('x-request-id', requestId);
    } catch {
      // Some runtime-created upgrade responses may have immutable headers.
    }
    console.info('Worker request completed', {
      ...baseLog,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
    });
    return response;
  } catch (err) {
    console.error('Worker request failed', {
      ...baseLog,
      elapsedMs: Date.now() - startedAt,
      error: String(err),
    });
    return jsonResponse(
      { error: 'INTERNAL_ERROR', details: String(err), requestId },
      { status: 500, headers: { 'x-request-id': requestId } },
    );
  } finally {
    clearTimeout(slowTimer);
  }
}

async function routingFetch(request: Request, env: WorkerEnv, _ctx?: WorkerExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/agent/protocol') {
    return handleAgentProtocolProbe(request, env);
  }

  if (url.pathname === '/agent') {
    // WebSocket upgrades must be handled before GET long-poll fallback.
    if ((request.headers.get('upgrade') || '').toLowerCase() === 'websocket') {
      return handleAgentWebSocket(request, env);
    }
    if (request.headers.get('accept')?.includes('text/event-stream')) {
      return handleAgentWebSocket(request, env);
    }
    // Long-polling GET remains as a compatibility fallback for older agents.
    if (request.method === 'GET') {
      return handleAgentLongPoll(request, env);
    }
    // POST heartbeat/telemetry polling compatibility path.
    return handleAgentWebSocket(request, env);
  }

  if (url.pathname === '/admin/ws/pty') {
    return handleAdminPtyUpgrade(request, env);
  }

  if (request.method === 'POST' && url.pathname === '/internal/pty-fanout') {
    if (!env.CC_ADMIN_PTY_HUB) {
      return jsonResponse({ error: 'ADMIN_PTY_HUB_UNAVAILABLE' }, { status: 503 });
    }
    const id = env.CC_ADMIN_PTY_HUB.idFromName('admin-pty-hub-singleton');
    const stub = env.CC_ADMIN_PTY_HUB.get(id);
    return stub.fetch(new Request('https://admin-pty-hub.internal/fanout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: await request.text(),
    }));
  }

  if (request.method === 'GET' && url.pathname === '/admin/api-tokens') {
    return handleListApiTokens(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/api-tokens') {
    return handleCreateApiToken(request, env);
  }
  const apiTokenRevokeMatch = url.pathname.match(/^\/admin\/api-tokens\/([^/]+)\/revoke$/);
  if (apiTokenRevokeMatch && request.method === 'POST') {
    return handleRevokeApiToken(request, env, decodeURIComponent(apiTokenRevokeMatch[1]));
  }

  if (request.method === 'GET' && url.pathname === '/admin/totp/status') {
    return handleTotpStatus(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/totp/setup') {
    return handleTotpSetup(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/totp/verify-setup') {
    return handleTotpVerifySetup(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/totp/disable') {
    return handleTotpDisable(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/admin/totp/recovery-codes') {
    return handleTotpRecoveryCodes(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/totp/regenerate-recovery-codes') {
    return handleTotpRegenerateRecoveryCodes(request, env);
  }

  if (request.method === 'POST' && url.pathname === '/admin/login') {
    return handleAdminLogin(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/admin/logout') {
    return handleAdminLogout(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/admin/sessions') {
    return handleListAdminSessions(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/admin/audit-log') {
    return handleListAdminAudit(request, env, url);
  }

  if (request.method === 'GET' && url.pathname === '/v1/health') {
    return jsonResponse({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  }

  if (request.method === 'GET' && url.pathname === '/v1/file-transfers/stream') {
    return handleTransfersStream(request, env, url);
  }
  if (request.method === 'GET' && url.pathname === '/v1/file-transfers') {
    return handleListFileTransfers(request, env, url);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/dismiss') {
    return handleDismissFileTransfer(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/stop') {
    return handleStopFileTransfer(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/force-remove') {
    return handleForceRemoveFileTransfer(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/dismiss-finished') {
    return handleDismissFinishedFileTransfers(request, env);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-ops/remote-browser/open') {
    return handleOpenRemoteBrowser(request, env);
  }
  if (request.method === 'POST' && remoteBrowserCommandByPath[url.pathname]) {
    return handleRemoteBrowserCommand(request, env, url.pathname);
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/upload') {
    return handleStartScpTransfer(request, env, 'upload');
  }
  if (request.method === 'POST' && url.pathname === '/v1/file-transfers/download') {
    return handleStartScpTransfer(request, env, 'download');
  }

  if (request.method === 'GET' && url.pathname === '/v1/commands') {
    return handleListCommands(request, env, url);
  }
  if (request.method === 'GET' && url.pathname === '/v1/commands/stream') {
    return handleCommandsStream(request, env, url);
  }

  const commandAuditMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)\/audit$/);
  if (commandAuditMatch && request.method === 'GET') {
    return handleListCommandAudit(request, env, decodeURIComponent(commandAuditMatch[1]));
  }

  const commandMatch = url.pathname.match(/^\/v1\/commands\/([^/]+)$/);
  if (commandMatch && request.method === 'GET') {
    return handleGetCommand(request, env, decodeURIComponent(commandMatch[1]));
  }

  if (request.method === 'GET' && url.pathname === '/v1/logs/stream') {
    return handleTelemetryStream(request, env, url);
  }
  if (request.method === 'POST' && url.pathname === '/v1/logs') {
    return handleIngestLogs(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/v1/logs') {
    return handleListLogs(request, env, url);
  }
  if (request.method === 'GET' && url.pathname === '/v1/logs/export') {
    return handleExportLogs(request, env, url);
  }
  if (request.method === 'GET' && url.pathname === '/v1/device-summary') {
    return handleDeviceSummary(request, env, url);
  }
  if (request.method === 'GET' && url.pathname === '/v1/log-settings') {
    return handleLogSettings(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/v1/telemetry') {
    return handleTelemetry(request, env, url);
  }

  const ptySessionsMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/pty-sessions$/);
  if (ptySessionsMatch && request.method === 'GET') {
    return handleListPtySessions(request, env, decodeURIComponent(ptySessionsMatch[1]), url);
  }
  const tunnelLogsMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/tunnels\/([^/]+)\/logs$/);
  if (tunnelLogsMatch && request.method === 'GET') {
    return handleTunnelLogs(
      request,
      env,
      decodeURIComponent(tunnelLogsMatch[1]),
      decodeURIComponent(tunnelLogsMatch[2]),
      url,
    );
  }

  const genericDeviceCommandMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/(request-status-snapshot|request-inventory|request-recent-logs|request-restart-boundary-auth|request-start-server-tunnel|request-restart-server-tunnel)$/);
  if (genericDeviceCommandMatch && request.method === 'POST') {
    const commandTypeByPath: Record<string, string> = {
      'request-status-snapshot': 'request_status_snapshot',
      'request-inventory': 'request_inventory',
      'request-recent-logs': 'request_recent_logs',
      'request-restart-boundary-auth': 'restart_boundary_auth',
      'request-start-server-tunnel': 'start_server_tunnel',
      'request-restart-server-tunnel': 'restart_server_tunnel',
    };
    return dispatchGenericAgentCommand(request, env, decodeURIComponent(genericDeviceCommandMatch[1]), commandTypeByPath[genericDeviceCommandMatch[2]]);
  }

  if (request.method === 'GET' && url.pathname === '/v1/devices/stream') {
    return handleDevicesStream(request, env);
  }
  if (request.method === 'GET' && url.pathname === '/v1/devices') {
    return handleListDevices(request, env);
  }

  const deviceMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)$/);
  if (deviceMatch && request.method === 'GET') {
    return handleGetDevice(request, env, decodeURIComponent(deviceMatch[1]));
  }
  if (deviceMatch && request.method === 'DELETE') {
    return handleDeleteDevice(request, env, decodeURIComponent(deviceMatch[1]));
  }

  const startServerSshMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/request-start-server-ssh$/);
  if (startServerSshMatch && request.method === 'POST') {
    return handleStartServerSshCommand(request, env, decodeURIComponent(startServerSshMatch[1]));
  }
  const attachServerSshMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/request-attach-server-ssh$/);
  if (attachServerSshMatch && request.method === 'POST') {
    return handleAttachServerSshCommand(request, env, decodeURIComponent(attachServerSshMatch[1]));
  }

  if (request.method === 'POST' && url.pathname === '/v1/revoke') {
    return handleRevokeDevice(request, env);
  }

  if (request.method === 'POST' && url.pathname === '/v1/enroll') {
    return handleEnroll(request, env);
  }

  return jsonResponse({ error: 'Not Found' }, { status: 404 });
}

export default { fetch: safeFetch };
