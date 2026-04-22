import type { DeviceSummary } from '../types/device';

export type RuntimeSummary = {
  deviceId?: string;
  updatedAt?: string;
  functions?: Record<string, { state?: string; message?: string }>;
};

export type RecentLogEntry = {
  id?: string;
  ts?: string;
  type?: string;
  functionId?: string;
  payload?: unknown;
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

function getAdminCsrfToken(): string {
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
    }),
  });

  if (redirectIfUnauthorized(response)) {
    throw new Error('Redirecting to admin login');
  }

  if (!response.ok) {
    throw new Error(failureMessage);
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

function subscribeStream(url: string, onMessage: () => void): StreamSubscription {
  if (typeof EventSource === 'undefined') {
    return {
      unsubscribe: () => {},
    };
  }

  const source = new EventSource(url, { withCredentials: true });
  source.onmessage = () => {
    onMessage();
  };

  return {
    unsubscribe: () => {
      source.close();
    },
  };
}

export function subscribeTelemetryStream(deviceId: string, onMessage: () => void): StreamSubscription {
  return subscribeStream(`/v1/logs/stream?deviceId=${encodeURIComponent(deviceId)}`, onMessage);
}

export function subscribeTransfersStream(deviceId: string, onMessage: () => void): StreamSubscription {
  return subscribeStream(`/v1/file-transfers/stream?deviceId=${encodeURIComponent(deviceId)}`, onMessage);
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
