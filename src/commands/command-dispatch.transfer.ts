import { HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AdminAuthPrincipal } from '../admin/admin-auth';
import { AgentGateway } from '../agent/agent.gateway';
import { FileTransferStore } from '../file-ops/file-transfer.store';
import { FileOpAdmissionService } from '../file-ops/file-op-admission.service';
import { FileOpQuotaService } from '../file-ops/file-op-quota.service';
import { RemoteBrowserSessionStore } from '../file-ops/remote-browser-session.store';
import { LogStore } from '../logs/log.store';
import {
  buildTransferPayload,
  describeSymlinkPolicy,
  isResumeTransferPayload,
} from './command-dispatch.parsers';
import { enforceAdmission, enforceQuota, ensureActorOwnsFileOpResource, ensureBoundaryTunnelRunningForTransfer, ensureBrowserSessionAuthorizedForTransfer, ensureTransferCanResume, withQuotaWarning } from './command-dispatch.policies';
import { mapPrincipalToActor } from './command-dispatch.actor';
import { DispatchSafeInput } from './command-dispatch.types';

type DispatchSafeResponse = Record<string, unknown>;

export type DispatchTransferDeps = {
  fileOpAdmission: FileOpAdmissionService;
  fileOpQuota: FileOpQuotaService;
  fileTransferStore: FileTransferStore;
  remoteBrowserSessionStore: RemoteBrowserSessionStore;
  logStore: LogStore;
  agentGateway: AgentGateway;
  dispatchSafeCommand: (input: DispatchSafeInput) => DispatchSafeResponse;
  nowIso: () => string;
};

export function dispatchTransferCommand(input: {
  direction: 'upload' | 'download';
  commandType: string;
  requestedCommandId?: string;
  deviceId: string;
  payload: unknown;
  principal: AdminAuthPrincipal;
}, deps: DispatchTransferDeps) {
  const { direction, commandType, requestedCommandId, deviceId, payload, principal } = input;
  enforceAdmission(deps.fileOpAdmission.checkTransferCapacity(deviceId), commandType);
  const quota = deps.fileOpQuota.checkTransferStartQuota();
  enforceQuota(quota, commandType);

  const transfer = buildTransferPayload(payload, direction);
  ensureBoundaryTunnelRunningForTransfer(deps.logStore, deviceId, transfer.serverId);
  const actor = mapPrincipalToActor(principal);
  const existingTransfer = deps.fileTransferStore.get(transfer.transferId);

  if (existingTransfer) {
    ensureActorOwnsFileOpResource(
      { actorType: existingTransfer.actorType, actorId: existingTransfer.actorId },
      actor.actorType,
      actor.actorId,
      'TRANSFER_UNAUTHORIZED',
      'Transfer is owned by another operator',
    );

    if (!isResumeTransferPayload(transfer)) {
      throw new HttpException(
        { ok: false, code: 'TRANSFER_ID_CONFLICT', message: 'transferId already exists' },
        HttpStatus.CONFLICT,
      );
    }

    ensureTransferCanResume(existingTransfer, deviceId, direction, transfer);
    deps.fileTransferStore.prepareForResume(transfer.transferId, deps.nowIso(), {
      attempt: existingTransfer.attempt,
      maxAttempts: existingTransfer.maxAttempts,
      resumeSupported: existingTransfer.resumeSupported,
      retryScheduled: false,
      resumeToken: existingTransfer.resumeToken,
      resumeOffsetBytes: existingTransfer.resumeOffsetBytes,
      tempPathHint: existingTransfer.tempPathHint,
      message: direction === 'upload' ? 'Resuming upload transfer' : 'Resuming download transfer',
    });

    return withQuotaWarning(
      deps.dispatchSafeCommand({
        deviceId,
        commandType,
        requestedCommandId,
        payload: transfer,
        payloadSummary: direction === 'upload'
          ? `Resume upload ${transfer.localPath} to ${transfer.remotePath} on ${transfer.serverId}`
          : `Resume download ${transfer.remotePath} to ${transfer.localPath} from ${transfer.serverId}`,
        principal,
        dispatch: (commandId) => {
          deps.fileTransferStore.attachCommand(transfer.transferId, commandId, null, deps.nowIso());
          const result = deps.agentGateway.dispatchFileOpCommand(deviceId, commandType, transfer, commandId);
          if (!result.ok) {
            deps.fileTransferStore.markState(transfer.transferId, 'failed', deps.nowIso(), { reasonCode: result.reason ?? 'DISPATCH_FAILED', reasonDetail: result.reason ?? null });
          } else {
            deps.fileTransferStore.attachCommand(transfer.transferId, commandId, result.reqSeq ?? null, result.requestedAt ?? deps.nowIso());
          }
          return result;
        },
      }),
      quota.ok ? quota.warning : null,
    );
  }

  ensureBrowserSessionAuthorizedForTransfer(
    deps.remoteBrowserSessionStore,
    transfer.browserSessionId,
    deviceId,
    transfer.serverId,
    actor.actorType,
    actor.actorId,
  );

  deps.fileTransferStore.create({
    id: randomUUID(),
    transferId: transfer.transferId,
    deviceId,
    serverId: transfer.serverId,
    direction,
    actorType: actor.actorType,
    actorId: actor.actorId,
    browserSessionId: transfer.browserSessionId,
    localPath: transfer.localPath,
    remotePath: transfer.remotePath,
    recursive: transfer.recursive,
    overwritePolicy: transfer.overwritePolicy,
    followSymlinks: transfer.followSymlinks,
    rateLimitKbps: transfer.rateLimitKbps,
    verifyChecksum: transfer.verifyChecksum,
    preserveMtime: transfer.preserveMtime,
    preserveMode: transfer.preserveMode,
    ts: deps.nowIso(),
  });

  return withQuotaWarning(
    deps.dispatchSafeCommand({
      deviceId,
      commandType,
      requestedCommandId,
      payload: transfer,
      payloadSummary: direction === 'upload'
        ? `Upload ${transfer.localPath} to ${transfer.remotePath} on ${transfer.serverId} (${describeSymlinkPolicy('upload', transfer.followSymlinks)})`
        : `Download ${transfer.remotePath} to ${transfer.localPath} from ${transfer.serverId} (${describeSymlinkPolicy('download', transfer.followSymlinks)})`,
      principal,
      dispatch: (commandId) => {
        deps.fileTransferStore.attachCommand(transfer.transferId, commandId, null, deps.nowIso());
        const result = deps.agentGateway.dispatchFileOpCommand(deviceId, commandType, transfer, commandId);
        if (!result.ok) {
          deps.fileTransferStore.markState(transfer.transferId, 'failed', deps.nowIso(), { reasonCode: result.reason ?? 'DISPATCH_FAILED', reasonDetail: result.reason ?? null });
        } else {
          deps.fileTransferStore.attachCommand(transfer.transferId, commandId, result.reqSeq ?? null, result.requestedAt ?? deps.nowIso());
        }
        return result;
      },
    }),
    quota.ok ? quota.warning : null,
  );
}
