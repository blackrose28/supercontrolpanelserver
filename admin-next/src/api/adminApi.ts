import type { DeviceSummary } from '../types/device';

export type RuntimeSummary = {
  deviceId?: string;
  updatedAt?: string;
  functions?: Record<string, { state?: string; message?: string; sessionId?: string | null }>;
  inventory?: {
    servers?: InventoryServer[];
  };
};

export type InventoryServer = {
  id?: string;
  name?: string;
  connectionMethod?: string;
  host?: string;
  os?: string;
  sshUser?: string;
};

export type RecentLogEntry = {
  id?: string;
  ts?: string;
  type?: string;
  functionId?: string;
  payload?: unknown;
};

export type TunnelLogEntry = {
  ts?: string;
  sessionId?: string | null;
  data?: string;
};

export type TunnelLogsResponse = {
  entries: TunnelLogEntry[];
  total: number;
};

export type CommandHistoryEntry = {
  commandId: string;
  commandType?: string;
  state?: string;
  submittedAt?: string;
  finishedAt?: string | null;
  actorType?: string;
  actorId?: string | null;
  payloadSummary?: string | null;
  reasonCode?: string | null;
  outcome?: string | null;
};

export type CommandAuditEntry = {
  eventType?: string;
  ts?: string;
  summary?: string;
  details?: unknown;
};

export type DeviceCommandResponse = {
  ok?: boolean;
  command?: {
    commandId?: string;
    commandType?: string;
  };
};

export type PtyOpenResponse = {
  ok?: boolean;
  deviceId?: string;
  serverId?: string;
  sessionId?: string;
  reqSeq?: number;
  requestedAt?: string;
  agentAck?: {
    localSessionId?: string;
    sessionId?: string;
  } | null;
};

export type PtySessionEntry = {
  sessionId?: string;
  deviceId?: string;
  state?: string;
};

type PtySessionsResponse = {
  items?: PtySessionEntry[];
};

type CommandHistoryResponse = {
  items?: CommandHistoryEntry[];
};

type CommandAuditResponse = {
  items?: CommandAuditEntry[];
};

export type TransferEntry = {
  transferId: string;
  direction?: string;
  state?: string;
  updatedAt?: string;
  serverId?: string;
  localPath?: string;
  remotePath?: string;
  sessionId?: string | null;
  phase?: string;
  percent?: number;
  bytesTransferred?: number;
  bytesTotal?: number;
  throughputBps?: number;
  etaSec?: number;
  reasonCode?: string;
  reasonDetail?: string;
  message?: string;
  resumeSupported?: boolean;
  resumeToken?: string;
  resumeOffsetBytes?: number;
  tempPathHint?: string;
};

type TransferMutationResponse = {
  ok?: boolean;
  transferId?: string;
};

export type ScpTransferDirection = 'upload' | 'download';

export type ScpTransferPayload = {
  serverId: string;
  localPath: string;
  remotePath: string;
  recursive?: boolean;
  overwritePolicy?: 'prompt' | 'force' | 'skip';
  verifyChecksum?: boolean;
  followSymlinks?: boolean;
  preserveMtime?: boolean;
  preserveMode?: boolean;
  rateLimitKbps?: number | null;
};

type TransferAction = 'stop' | 'dismiss' | 'force-remove' | 'dismiss-finished';

const ADMIN_LOGIN_PATH = '/admin/login';

function redirectToAdminLogin() {
  if (typeof window === 'undefined') {
    return;
  }

  window.location.assign(ADMIN_LOGIN_PATH);
}

function redirectIfUnauthorized(response: Response): boolean {
  if (response.status !== 401 && response.status !== 403) {
    return false;
  }

  redirectToAdminLogin();
  return true;
}

export function getAdminCsrfToken(): string {
  const fromMeta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')?.trim();
  if (fromMeta) {
    return fromMeta;
  }

  const cookieEntry = document.cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('cc_admin_csrf='));

  if (cookieEntry) {
    return decodeURIComponent(cookieEntry.slice('cc_admin_csrf='.length));
  }

  throw new Error('Missing CSRF token');
}

async function postTransferAction(deviceId: string, transferId: string | null, action: TransferAction): Promise<TransferMutationResponse> {
  const csrfToken = getAdminCsrfToken();
  const body: Record<string, unknown> = transferId
    ? {
      deviceId,
      transferId,
      csrfToken,
    }
    : {
      deviceId,
      csrfToken,
    };

  const response = await fetch(`/v1/file-transfers/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to ${action} transfer`);
  }

  return parseJsonOrThrow<TransferMutationResponse>(response, `Failed to parse ${action} transfer response`);
}

async function postDeviceRequest(
  deviceId: string,
  path: string,
  failureMessage: string,
  extraBody?: Record<string, unknown>,
): Promise<DeviceCommandResponse> {
  const csrfToken = getAdminCsrfToken();
  const response = await fetch(`/v1/devices/${encodeURIComponent(deviceId)}/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      csrfToken,
      ...(extraBody || {}),
    }),
  });

  if (redirectIfUnauthorized(response)) {
    throw new Error('Redirecting to admin login');
  }

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, failureMessage));
  }

  return parseJsonOrThrow<DeviceCommandResponse>(response, `Failed to parse ${path} response`);
}

export type TelemetryEntry = {
  id?: string;
  ts?: string;
  type?: string;
  functionId?: string;
  payload?: unknown;
};

type TransferResponse = {
  items?: TransferEntry[];
};

type TelemetryResponse = {
  events?: TelemetryEntry[];
};

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fallback;
  }

  const bodyRecord = isRecord(body) ? body : null;
  const payload = isRecord(bodyRecord?.payload) ? bodyRecord.payload : null;
  const agentError = isRecord(bodyRecord?.agentError) ? bodyRecord.agentError : null;
  const code = readString(bodyRecord?.code) || readString(bodyRecord?.error) || readString(payload?.error) || readString(agentError?.error);
  const message = readString(bodyRecord?.message) || readString(payload?.message) || readString(agentError?.message);

  if (code && message) {
    return `${fallback}: ${code} - ${message}`;
  }
  if (message) {
    return `${fallback}: ${message}`;
  }
  if (code) {
    return `${fallback}: ${code}`;
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function parseJsonOrThrow<T>(response: Response, parseErrorMessage: string): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(parseErrorMessage);
  }
}

export async function fetchDevices(): Promise<DeviceSummary[]> {
  const response = await fetch('/v1/devices', {
    credentials: 'same-origin',
  });

  if (redirectIfUnauthorized(response)) {
    throw new Error('Redirecting to admin login');
  }

  if (!response.ok) {
    throw new Error('Failed to load devices');
  }

  const payload = await parseJsonOrThrow<DeviceSummary[]>(response, 'Failed to parse devices response');
  return Array.isArray(payload) ? payload : [];
}

export async function fetchDeviceDetails(deviceId: string): Promise<DeviceSummary> {
  const response = await fetch(`/v1/devices/${deviceId}`, {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error('Failed to load selected device details');
  }

  return parseJsonOrThrow<DeviceSummary>(response, 'Failed to parse selected device details response');
}

export async function fetchRuntimeSummary(deviceId: string): Promise<RuntimeSummary> {
  const response = await fetch(`/v1/device-summary?deviceId=${encodeURIComponent(deviceId)}`, {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error('Failed to load runtime summary');
  }

  return parseJsonOrThrow<RuntimeSummary>(response, 'Failed to parse runtime summary response');
}

export async function requestStatusSnapshot(deviceId: string): Promise<DeviceCommandResponse> {
  return postDeviceRequest(deviceId, 'request-status-snapshot', 'Failed to request status snapshot');
}

export async function requestRecentLogs(deviceId: string): Promise<DeviceCommandResponse> {
  return postDeviceRequest(deviceId, 'request-recent-logs', 'Failed to request recent logs');
}

export async function requestRestartOpenvpn(deviceId: string): Promise<DeviceCommandResponse> {
  return postDeviceRequest(deviceId, 'request-restart-openvpn', 'Failed to request OpenVPN restart');
}

export async function requestRestartBoundaryAuth(deviceId: string): Promise<DeviceCommandResponse> {
  return postDeviceRequest(deviceId, 'request-restart-boundary-auth', 'Failed to request Boundary auth restart');
}

export async function deleteDevice(deviceId: string): Promise<void> {
  const csrfToken = getAdminCsrfToken();
  const response = await fetch(`/v1/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ csrfToken }),
  });

  if (redirectIfUnauthorized(response)) {
    throw new Error('Redirecting to admin login');
  }

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Failed to delete device'));
  }
}

export async function requestRestartServerTunnel(deviceId: string, serverId: string): Promise<DeviceCommandResponse> {
  return postDeviceRequest(
    deviceId,
    'request-restart-server-tunnel',
    'Failed to request server tunnel restart',
    { serverId },
  );
}

export async function requestStartServerTunnel(deviceId: string, serverId: string): Promise<DeviceCommandResponse> {
  return postDeviceRequest(
    deviceId,
    'request-start-server-tunnel',
    'Failed to request server tunnel start',
    { serverId },
  );
}

export async function fetchPtySessions(deviceId: string): Promise<PtySessionEntry[]> {
  const response = await fetch(`/v1/devices/${encodeURIComponent(deviceId)}/pty-sessions`, {
    credentials: 'same-origin',
  });

  if (redirectIfUnauthorized(response)) {
    throw new Error('Redirecting to admin login');
  }

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Failed to load PTY sessions'));
  }

  const payload = await parseJsonOrThrow<PtySessionsResponse>(response, 'Failed to parse PTY sessions response');
  return Array.isArray(payload.items) ? payload.items : [];
}

export async function requestStartServerSshPty(deviceId: string, serverId: string, cols = 120, rows = 32): Promise<PtyOpenResponse> {
  const csrfToken = getAdminCsrfToken();
  const response = await fetch(`/v1/devices/${encodeURIComponent(deviceId)}/request-start-server-ssh`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken, serverId, cols, rows }),
  });

  if (redirectIfUnauthorized(response)) {
    throw new Error('Redirecting to admin login');
  }

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Failed to request server SSH terminal'));
  }

  return parseJsonOrThrow<PtyOpenResponse>(response, 'Failed to parse server SSH terminal response');
}

export async function requestAttachServerSshPty(deviceId: string, serverId: string, localSessionId: string, cols = 120, rows = 32): Promise<PtyOpenResponse> {
  const csrfToken = getAdminCsrfToken();
  const response = await fetch(`/v1/devices/${encodeURIComponent(deviceId)}/request-attach-server-ssh`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken, serverId, localSessionId, cols, rows }),
  });

  if (redirectIfUnauthorized(response)) {
    throw new Error('Redirecting to admin login');
  }

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Failed to attach server SSH terminal'));
  }

  return parseJsonOrThrow<PtyOpenResponse>(response, 'Failed to parse server SSH terminal attach response');
}

export async function requestStopServerTunnel(deviceId: string, serverId: string): Promise<DeviceCommandResponse> {
  return postDeviceRequest(
    deviceId,
    'request-stop-server-tunnel',
    'Failed to request server tunnel stop',
    { serverId },
  );
}

export async function fetchRecentLogs(deviceId: string, limit = 20): Promise<RecentLogEntry[]> {
  const response = await fetch(`/v1/logs?deviceId=${encodeURIComponent(deviceId)}&limit=${limit}`, {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error('Failed to load recent logs');
  }

  const payload = await parseJsonOrThrow<RecentLogEntry[]>(response, 'Failed to parse recent logs response');
  return Array.isArray(payload) ? payload : [];
}

export async function fetchTunnelLogs(deviceId: string, serverId: string, limit = 200, offset = 0): Promise<TunnelLogsResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const response = await fetch(
    `/v1/devices/${encodeURIComponent(deviceId)}/tunnels/${encodeURIComponent(serverId)}/logs?${params}`,
    {
      credentials: 'same-origin',
    },
  );

  if (!response.ok) {
    throw new Error('Failed to load tunnel logs');
  }

  const payload = await parseJsonOrThrow<TunnelLogsResponse>(response, 'Failed to parse tunnel logs response');
  return {
    entries: Array.isArray(payload.entries) ? payload.entries : [],
    total: typeof payload.total === 'number' ? payload.total : 0,
  };
}

export async function fetchCommands(deviceId: string, limit = 20): Promise<CommandHistoryEntry[]> {
  const params = new URLSearchParams({
    deviceId,
    limit: String(limit),
  });

  const response = await fetch(`/v1/commands?${params.toString()}`, {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error('Failed to load commands');
  }

  const payload = await parseJsonOrThrow<CommandHistoryResponse>(response, 'Failed to parse commands response');
  return Array.isArray(payload?.items) ? payload.items : [];
}

export async function fetchCommandAudit(commandId: string): Promise<CommandAuditEntry[]> {
  const response = await fetch(`/v1/commands/${encodeURIComponent(commandId)}/audit`, {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error('Failed to load command audit');
  }

  const payload = await parseJsonOrThrow<CommandAuditResponse>(response, 'Failed to parse command audit response');
  return Array.isArray(payload?.items) ? payload.items : [];
}

export async function fetchTransfers(deviceId: string, limit = 50): Promise<TransferEntry[]> {
  const params = new URLSearchParams({
    deviceId,
    limit: String(limit),
  });

  const response = await fetch(`/v1/file-transfers?${params.toString()}`, {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error('Failed to load transfers');
  }

  const payload = await parseJsonOrThrow<TransferResponse>(response, 'Failed to parse transfers response');
  return Array.isArray(payload?.items) ? payload.items : [];
}

export async function startScpTransfer(
  deviceId: string,
  direction: ScpTransferDirection,
  payload: ScpTransferPayload,
): Promise<DeviceCommandResponse> {
  const csrfToken = getAdminCsrfToken();
  const commandType = direction === 'download' ? 'start_scp_download' : 'start_scp_upload';
  const response = await fetch('/v1/commands', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      csrfToken,
      deviceId,
      commandType,
      payload: {
        serverId: payload.serverId,
        localPath: payload.localPath,
        remotePath: payload.remotePath,
        recursive: payload.recursive ?? false,
        overwritePolicy: payload.overwritePolicy ?? 'prompt',
        verifyChecksum: payload.verifyChecksum ?? false,
        followSymlinks: payload.followSymlinks ?? false,
        preserveMtime: payload.preserveMtime ?? false,
        preserveMode: payload.preserveMode ?? false,
        rateLimitKbps: payload.rateLimitKbps ?? null,
      },
    }),
  });

  if (redirectIfUnauthorized(response)) {
    throw new Error('Redirecting to admin login');
  }

  if (!response.ok) {
    throw new Error(await responseErrorMessage(response, 'Failed to start SCP transfer'));
  }

  return parseJsonOrThrow<DeviceCommandResponse>(response, 'Failed to parse SCP transfer response');
}

export async function stopTransfer(deviceId: string, transferId: string): Promise<TransferMutationResponse> {
  return postTransferAction(deviceId, transferId, 'stop');
}

export async function dismissTransfer(deviceId: string, transferId: string): Promise<TransferMutationResponse> {
  return postTransferAction(deviceId, transferId, 'dismiss');
}

export async function forceRemoveTransfer(deviceId: string, transferId: string): Promise<TransferMutationResponse> {
  return postTransferAction(deviceId, transferId, 'force-remove');
}

export async function dismissFinishedTransfers(deviceId: string): Promise<TransferMutationResponse> {
  return postTransferAction(deviceId, null, 'dismiss-finished');
}

export async function resumeTransfer(deviceId: string, transfer: TransferEntry): Promise<unknown> {
  const csrfToken = getAdminCsrfToken();
  const direction = String(transfer.direction || 'upload');
  const commandType = direction === 'download' ? 'start_scp_download' : 'start_scp_upload';

  const response = await fetch('/v1/commands', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      csrfToken,
      deviceId,
      commandType,
      payload: {
        transferId: String(transfer.transferId),
        localPath: String(transfer.localPath || ''),
        remotePath: String(transfer.remotePath || ''),
        resumeToken: transfer.resumeToken,
        resumeOffsetBytes: transfer.resumeOffsetBytes,
        tempPathHint: transfer.tempPathHint,
      },
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to resume transfer');
  }

  return parseJsonOrThrow<unknown>(response, 'Failed to parse resume transfer response');
}

export type TelemetryFilters = {
  type?: string;
  q?: string;
  fromTs?: string;
  toTs?: string;
  limit?: number;
};

type StreamSubscription = {
  unsubscribe: () => void;
};

function parseStreamData<T>(event: MessageEvent): T | undefined {
  if (typeof event.data !== 'string' || !event.data.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(event.data) as T;
  } catch {
    return undefined;
  }
}

function subscribeStream<T>(url: string, eventName: string, onMessage: (data?: T) => void): StreamSubscription {
  if (typeof EventSource === 'undefined') {
    return {
      unsubscribe: () => {},
    };
  }

  const source = new EventSource(url, { withCredentials: true });
  const handleMessage = (event?: MessageEvent) => {
    onMessage(event ? parseStreamData<T>(event) : undefined);
  };

  if (typeof source.addEventListener === 'function') {
    source.addEventListener(eventName, handleMessage as EventListener);
  }
  source.onmessage = handleMessage;

  return {
    unsubscribe: () => {
      source.close();
    },
  };
}

export function subscribeTelemetryStream(deviceId: string, onMessage: (entry?: TelemetryEntry) => void): StreamSubscription {
  return subscribeStream<TelemetryEntry>(`/v1/logs/stream?deviceId=${encodeURIComponent(deviceId)}`, 'telemetry', onMessage);
}

export function subscribeTransfersStream(deviceId: string, onMessage: (entry?: TransferEntry) => void): StreamSubscription {
  return subscribeStream<TransferEntry>(`/v1/file-transfers/stream?deviceId=${encodeURIComponent(deviceId)}`, 'file_transfer', onMessage);
}

export function subscribeCommandsStream(deviceId: string, onMessage: () => void): StreamSubscription {
  return subscribeStream(`/v1/commands/stream?deviceId=${encodeURIComponent(deviceId)}`, 'command', () => onMessage());
}

export type DeviceStatusChangeEvent = {
  deviceId: string;
  status: string;
  lastSeenAt: string;
};

export function subscribeDevicesStream(onMessage: (event?: DeviceStatusChangeEvent) => void): StreamSubscription {
  if (typeof EventSource === 'undefined') {
    return { unsubscribe: () => {} };
  }

  const source = new EventSource('/v1/devices/stream', { withCredentials: true });

  const handleEvent = (event: MessageEvent) => {
    try {
      onMessage(JSON.parse(event.data) as DeviceStatusChangeEvent);
    } catch {
      onMessage(undefined);
    }
  };

  if (typeof source.addEventListener === 'function') {
    source.addEventListener('device-connected', handleEvent as EventListener);
    source.addEventListener('device-disconnected', handleEvent as EventListener);
  }

  return {
    unsubscribe: () => {
      source.close();
    },
  };
}

export function buildTelemetryExportUrl(deviceId: string, filters: TelemetryFilters = {}): string {
  const params = new URLSearchParams({
    deviceId,
    limit: String(filters.limit ?? 100),
  });

  if (filters.type) {
    params.set('type', filters.type);
  }

  if (filters.q) {
    params.set('q', filters.q);
  }

  if (filters.fromTs) {
    params.set('fromTs', filters.fromTs);
  }

  if (filters.toTs) {
    params.set('toTs', filters.toTs);
  }

  return `/v1/logs/export?${params.toString()}`;
}

export async function fetchTelemetry(deviceId: string, filters: TelemetryFilters = {}): Promise<TelemetryEntry[]> {
  const logsExportUrl = buildTelemetryExportUrl(deviceId, filters).replace('/v1/logs/export?', '/v1/logs?');

  const response = await fetch(logsExportUrl, {
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error('Failed to load telemetry');
  }

  const payload = await parseJsonOrThrow<TelemetryResponse | TelemetryEntry[]>(response, 'Failed to parse telemetry response');
  if (Array.isArray(payload)) {
    return payload;
  }

  return Array.isArray(payload?.events) ? payload.events : [];
}

// ── TOTP / 2FA ────────────────────────────────────────────────────

export type TotpStatusResponse = { enabled: boolean };
export type TotpSetupResponse = { secret: string; qrDataUrl: string };
export type TotpRecoveryCodesResponse = { codes: string[] };

export async function fetchTotpStatus(): Promise<TotpStatusResponse> {
  const response = await fetch('/admin/totp/status', {
    credentials: 'same-origin',
  });
  if (response.status === 401 || response.status === 403) {
    redirectIfUnauthorized(response);
  }
  return response.json();
}

export async function setupTotp(): Promise<TotpSetupResponse> {
  const csrfToken = getAdminCsrfToken();
  const response = await fetch('/admin/totp/setup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken }),
  });
  if (response.status === 401 || response.status === 403) {
    redirectIfUnauthorized(response);
  }
  if (!response.ok) {
    throw new Error('Failed to start TOTP setup');
  }
  return response.json();
}

export async function verifyTotpSetup(totpCode: string): Promise<{ enabled: boolean }> {
  const csrfToken = getAdminCsrfToken();
  const response = await fetch('/admin/totp/verify-setup', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken, totpCode }),
  });
  if (response.status === 401 || response.status === 403) {
    redirectIfUnauthorized(response);
  }
  if (!response.ok) {
    const msg = await extractErrorMessage(response);
    throw new Error(msg || 'Invalid TOTP code');
  }
  return response.json();
}

export async function disableTotp(totpCode: string): Promise<{ enabled: boolean }> {
  const csrfToken = getAdminCsrfToken();
  const response = await fetch('/admin/totp/disable', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken, totpCode }),
  });
  if (response.status === 401 || response.status === 403) {
    redirectIfUnauthorized(response);
  }
  if (!response.ok) {
    const msg = await extractErrorMessage(response);
    throw new Error(msg || 'Invalid TOTP code');
  }
  return response.json();
}

export async function fetchRecoveryCodes(): Promise<TotpRecoveryCodesResponse> {
  const response = await fetch('/admin/totp/recovery-codes', {
    credentials: 'same-origin',
  });
  if (response.status === 401 || response.status === 403) {
    redirectIfUnauthorized(response);
  }
  return response.json();
}

export async function regenerateRecoveryCodes(): Promise<TotpRecoveryCodesResponse> {
  const csrfToken = getAdminCsrfToken();
  const response = await fetch('/admin/totp/regenerate-recovery-codes', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken }),
  });
  if (response.status === 401 || response.status === 403) {
    redirectIfUnauthorized(response);
  }
  if (!response.ok) {
    throw new Error('Failed to regenerate recovery codes');
  }
  return response.json();
}

// ── Session Management ─────────────────────────────────────────────

export type SessionEntry = {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
};

export async function fetchSessions(): Promise<SessionEntry[]> {
  const response = await fetch('/admin/sessions', {
    credentials: 'same-origin',
  });
  if (response.status === 401 || response.status === 403) {
    redirectIfUnauthorized(response);
  }
  return response.json();
}

export async function revokeSession(tokenHash: string): Promise<{ ok: boolean }> {
  const csrfToken = getAdminCsrfToken();
  const response = await fetch('/admin/sessions/revoke', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken, tokenHash }),
  });
  if (response.status === 401 || response.status === 403) {
    redirectIfUnauthorized(response);
  }
  if (!response.ok) {
    throw new Error('Failed to revoke session');
  }
  return response.json();
}

export async function revokeAllSessions(): Promise<{ ok: boolean }> {
  const csrfToken = getAdminCsrfToken();
  const response = await fetch('/admin/sessions/revoke-all', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken }),
  });
  if (response.status === 401 || response.status === 403) {
    redirectIfUnauthorized(response);
  }
  if (!response.ok) {
    throw new Error('Failed to revoke all sessions');
  }
  return response.json();
}

// ── Audit Log ──────────────────────────────────────────────────────

export type AuditEntry = {
  id: number;
  event: string;
  actor: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
};

export async function fetchAuditLog(params?: {
  event?: string;
  actor?: string;
  limit?: number;
}): Promise<AuditEntry[]> {
  const searchParams = new URLSearchParams();
  if (params?.event) searchParams.set('event', params.event);
  if (params?.actor) searchParams.set('actor', params.actor);
  if (params?.limit) searchParams.set('limit', String(params.limit));
  const qs = searchParams.toString();
  const response = await fetch(`/admin/audit-log${qs ? '?' + qs : ''}`, {
    credentials: 'same-origin',
  });
  if (response.status === 401 || response.status === 403) {
    redirectIfUnauthorized(response);
  }
  return response.json();
}
