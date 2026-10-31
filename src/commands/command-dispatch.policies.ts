import { HttpException, HttpStatus } from '@nestjs/common';
import { RemoteBrowserSessionStore } from '../file-ops/remote-browser-session.store';
import { FileTransferRecord } from '../file-ops/file-transfer.types';
import { LogStore } from '../logs/log.store';
import { FileOpQuotaCheckResult } from '../file-ops/file-op-quota.service';

export function withQuotaWarning<T extends Record<string, unknown>>(
  response: T,
  warning: Extract<FileOpQuotaCheckResult, { ok: true }>['warning'],
) {
  if (!warning) {
    return response;
  }
  return {
    ...response,
    warning,
  };
}

export function enforceQuota(result: FileOpQuotaCheckResult, commandType: string) {
  if (isQuotaAllowed(result)) {
    return;
  }
  const rejection = result;

  throw new HttpException(
    {
      type: 'nack',
      payload: {
        code: rejection.code,
        rate_limited: true,
        retryAfterMs: rejection.retryAfterMs,
        tenantId: rejection.tenantId,
        usedBytes: rejection.usedBytes,
        budgetBytes: rejection.budgetBytes,
        thresholdPct: rejection.thresholdPct,
        commandType,
        message: rejection.message,
      },
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function isQuotaAllowed(
  result: FileOpQuotaCheckResult,
): result is Extract<FileOpQuotaCheckResult, { ok: true }> {
  return result.ok;
}

export function ensureActorOwnsFileOpResource(
  record: { actorType: string | null; actorId: string | null },
  actorType: string,
  actorId: string | null,
  code: string,
  message: string,
) {
  if (!record.actorType) {
    return;
  }
  if (record.actorType === actorType && record.actorId === actorId) {
    return;
  }
  throw new HttpException({ ok: false, code, message }, HttpStatus.FORBIDDEN);
}

export function ensureBrowserSessionAuthorizedForTransfer(
  remoteBrowserSessionStore: RemoteBrowserSessionStore,
  browserSessionId: string | null,
  deviceId: string,
  serverId: string,
  actorType: string,
  actorId: string | null,
) {
  if (!browserSessionId) {
    return;
  }

  const session = remoteBrowserSessionStore.get(browserSessionId);
  if (!session || session.deviceId !== deviceId) {
    throw new HttpException(
      { ok: false, code: 'BROWSER_SESSION_NOT_FOUND', message: 'Remote browser session not found' },
      HttpStatus.NOT_FOUND,
    );
  }
  ensureActorOwnsFileOpResource(
    {
      actorType: session.actorType,
      actorId: session.actorId,
    },
    actorType,
    actorId,
    'BROWSER_SESSION_UNAUTHORIZED',
    'Remote browser session is owned by another operator',
  );
  if (session.serverId !== serverId) {
    throw new HttpException(
      {
        ok: false,
        code: 'BROWSER_SESSION_SERVER_MISMATCH',
        message: 'Remote browser session belongs to a different server',
      },
      HttpStatus.CONFLICT,
    );
  }
}

export function enforceAdmission(
  result: { ok: true } | { ok: false; retryAfterMs: number; message: string },
  commandType: string,
) {
  if ('retryAfterMs' in result) {
    throw new HttpException(
      {
        type: 'nack',
        payload: {
          code: 'rate_limited',
          rate_limited: true,
          retryAfterMs: result.retryAfterMs,
          commandType,
          message: result.message,
        },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export function ensureTransferCanResume(
  existing: FileTransferRecord,
  deviceId: string,
  direction: 'upload' | 'download',
  payload: {
    serverId: string;
    resumeToken: string | null;
    tempPathHint: string | null;
    resumeOffsetBytes: number | null;
  },
) {
  if (existing.deviceId !== deviceId || existing.direction !== direction || existing.serverId !== payload.serverId) {
    throw new HttpException(
      { ok: false, code: 'resume_state_lost', message: 'Existing transfer does not match this resume request' },
      HttpStatus.CONFLICT,
    );
  }
  if (!['failed', 'canceled'].includes(existing.state)) {
    throw new HttpException(
      { ok: false, code: 'resume_not_supported', message: 'Only failed or canceled transfers can be resumed' },
      HttpStatus.CONFLICT,
    );
  }
  if (!existing.resumeSupported || !existing.resumeToken || !existing.tempPathHint || existing.resumeOffsetBytes == null) {
    throw new HttpException(
      { ok: false, code: 'resume_not_supported', message: 'This transfer does not have resumable state' },
      HttpStatus.CONFLICT,
    );
  }
  if (payload.resumeToken !== existing.resumeToken || payload.tempPathHint !== existing.tempPathHint) {
    throw new HttpException(
      { ok: false, code: 'resume_state_lost', message: 'Resume token or temp path no longer matches stored transfer state' },
      HttpStatus.CONFLICT,
    );
  }
  if (payload.resumeOffsetBytes !== existing.resumeOffsetBytes) {
    throw new HttpException(
      { ok: false, code: 'resume_offset_mismatch', message: 'Resume offset does not match the latest stored resumable offset' },
      HttpStatus.CONFLICT,
    );
  }
}

export function ensureBoundaryTunnelRunningForTransfer(
  logStore: LogStore,
  deviceId: string,
  serverId: string,
) {
  const summary = logStore.getDeviceRuntimeSummary(deviceId);
  const inventory = summary.inventory && typeof summary.inventory === 'object'
    ? summary.inventory as Record<string, unknown>
    : null;
  const servers = Array.isArray(inventory?.servers)
    ? inventory.servers as Array<Record<string, unknown>>
    : [];
  const server = servers.find((entry) => typeof entry?.id === 'string' && entry.id === serverId);
  const connectionMethod =
    server && typeof server.connectionMethod === 'string'
      ? server.connectionMethod.trim().toLowerCase()
      : '';

  if (connectionMethod !== 'boundary') {
    return;
  }

  const functionId = `server-tunnel-${serverId}`;
  const functionState = summary.functions?.[functionId];
  const state = typeof functionState?.state === 'string' ? functionState.state.trim().toLowerCase() : '';
  const sessionId = typeof functionState?.sessionId === 'string' ? functionState.sessionId.trim() : '';
  if (state === 'running' && sessionId) {
    return;
  }

  throw new HttpException(
    {
      ok: false,
      code: 'tunnel_not_running',
      message: 'Boundary tunnel is not running for this server. Start the tunnel, then retry the transfer.',
    },
    HttpStatus.CONFLICT,
  );
}
