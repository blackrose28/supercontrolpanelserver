import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { AgentGateway } from '../agent/agent.gateway';
import {
  AdminAuthPrincipal,
} from '../admin/admin-auth';
import { DeviceStore } from '../devices/device.store';
import { FileTransferRecord, FileTransferStore } from '../file-ops/file-transfer.store';
import { FileOpAdmissionService } from '../file-ops/file-op-admission.service';
import { FileOpQuotaCheckResult, FileOpQuotaService } from '../file-ops/file-op-quota.service';
import { RemoteBrowserSessionStore } from '../file-ops/remote-browser-session.store';
import { LogStore } from '../logs/log.store';
import { PtySessionStore } from '../pty/pty-session.store';
import {
  CommandActorType,
  CommandStore,
  SafeCommandType,
} from './command.store';

@Injectable()
export class CommandDispatchService {
  constructor(
    private readonly deviceStore: DeviceStore,
    private readonly agentGateway: AgentGateway,
    private readonly commandStore: CommandStore,
    private readonly fileTransferStore: FileTransferStore,
    private readonly fileOpAdmission: FileOpAdmissionService,
    private readonly fileOpQuota: FileOpQuotaService,
    private readonly remoteBrowserSessionStore: RemoteBrowserSessionStore,
    private readonly logStore: LogStore,
    private readonly ptySessionStore: PtySessionStore,
  ) {}

  dispatchSafeCommand(input: {
    deviceId: string;
    commandType: SafeCommandType | string;
    requestedCommandId?: string;
    payload: unknown;
    payloadSummary: string;
    principal: AdminAuthPrincipal;
    dispatch: (commandId: string) => { ok: boolean; reason?: string; reqSeq?: number; requestedAt?: string };
  }) {
    const now = new Date().toISOString();
    const commandId = String(input.requestedCommandId || '').trim() || uuidv4();
    const actor = mapPrincipalToActor(input.principal);
    const existing = this.commandStore.getCommand(commandId);

    if (existing) {
      const samePayload = JSON.stringify(existing.payload ?? null) === JSON.stringify(input.payload ?? null);
      if (
        existing.deviceId !== input.deviceId
        || existing.commandType !== input.commandType
        || !samePayload
      ) {
        throw new HttpException(
          {
            ok: false,
            code: 'COMMAND_ID_CONFLICT',
            message: 'commandId already exists with different command details',
            command: existing,
          },
          HttpStatus.CONFLICT,
        );
      }

      return {
        ok: true,
        reused: true,
        deviceId: input.deviceId,
        command: existing,
      };
    }

    let command = this.commandStore.createQueuedCommand({
      id: uuidv4(),
      commandId,
      deviceId: input.deviceId,
      commandType: input.commandType,
      actorType: actor.actorType,
      actorId: actor.actorId,
      payload: input.payload,
      payloadSummary: input.payloadSummary,
      submittedAt: now,
    });

    this.commandStore.appendAudit({
      id: uuidv4(),
      commandId,
      ts: now,
      eventType: 'created',
      actorType: actor.actorType,
      actorId: actor.actorId,
      source: actor.source,
      summary: input.payloadSummary,
      details: {
        commandType: input.commandType,
        payload: input.payload,
      },
    });

    const result = input.dispatch(commandId);
    if (!result.ok || typeof result.reqSeq !== 'number' || !result.requestedAt) {
      command = this.commandStore.markFailed(
        commandId,
        result.reason ?? 'DISPATCH_FAILED',
        result.reason ?? null,
        new Date().toISOString(),
      );
      this.commandStore.appendAudit({
        id: uuidv4(),
        commandId,
        ts: command.finishedAt ?? new Date().toISOString(),
        eventType: 'failed',
        actorType: actor.actorType,
        actorId: actor.actorId,
        source: 'server',
        summary: `Command dispatch failed: ${result.reason ?? 'DISPATCH_FAILED'}`,
        details: {
          commandType: input.commandType,
          reason: result.reason ?? 'DISPATCH_FAILED',
        },
      });
      throw new HttpException(
        {
          ok: false,
          code: result.reason ?? 'DISPATCH_FAILED',
          command,
        },
        HttpStatus.CONFLICT,
      );
    }

    command = this.commandStore.markDispatched(commandId, result.reqSeq, result.requestedAt);
    this.trackTransferSessionFromAck(input.deviceId, input.commandType, input.payload, actor.actorType, actor.actorId, result.reqSeq, result.requestedAt);
    this.commandStore.appendAudit({
      id: uuidv4(),
      commandId,
      ts: result.requestedAt,
      eventType: 'dispatched',
      actorType: actor.actorType,
      actorId: actor.actorId,
      source: 'server',
      summary: `Dispatched ${input.commandType} to ${input.deviceId}`,
      details: {
        reqSeq: result.reqSeq,
      },
    });

    return {
      ...result,
      command,
    };
  }

  private trackTransferSessionFromAck(
    deviceId: string,
    commandType: string,
    payload: unknown,
    actorType: CommandActorType,
    actorId: string | null,
    reqSeq: number,
    requestedAt: string,
  ) {
    if (commandType !== 'start_scp_upload' && commandType !== 'start_scp_download') {
      return;
    }
    const transferId = readOptionalStringField(payload, 'transferId');
    if (!transferId) {
      return;
    }

    void this.agentGateway.awaitReqResponse(deviceId, reqSeq, 30_000)
      .then((ack) => {
        const ackPayload = ack && typeof ack.payload === 'object' && ack.payload ? ack.payload as Record<string, unknown> : null;
        const sessionId = ackPayload && typeof ackPayload.sessionId === 'string' ? ackPayload.sessionId.trim() : '';
        if (!sessionId) {
          return;
        }
        const transfer = this.fileTransferStore.get(transferId);
        if (!transfer || transfer.deviceId !== deviceId) {
          return;
        }
        this.fileTransferStore.attachSession(transferId, sessionId, ack.ts || requestedAt);
        this.ptySessionStore.createOpening({
          id: uuidv4(),
          sessionId,
          deviceId,
          openedAt: ack.ts || requestedAt,
          recordingEnabled: false,
          openedByActorType: actorType,
          openedByActorId: actorId,
          attachedActorType: null,
          attachedActorId: null,
        });
        this.ptySessionStore.markOpen(sessionId, ack.ts || requestedAt);
      })
      .catch((error) => {
        console.warn('Failed to capture transfer session ack', { deviceId, transferId, commandType, error });
      });
  }

  dispatchGenericCommand(input: {
    deviceId: string;
    commandType: string;
    requestedCommandId?: string;
    payload?: unknown;
    principal: AdminAuthPrincipal;
  }) {
    const deviceId = input.deviceId.trim();
    if (!deviceId) {
      throw new HttpException('deviceId is required', HttpStatus.BAD_REQUEST);
    }
    const device = this.deviceStore.getDevice(deviceId);
    if (!device) {
      throw new HttpException('Device not found', HttpStatus.NOT_FOUND);
    }

    const commandType = input.commandType.trim() as SafeCommandType;
    const payload = input.payload ?? null;

    switch (commandType) {
      case 'request_status_snapshot':
        return this.dispatchSafeCommand({
          deviceId,
          commandType,
          requestedCommandId: input.requestedCommandId,
          payload: null,
          payloadSummary: 'Request fresh status snapshot',
          principal: input.principal,
          dispatch: (commandId) => this.agentGateway.requestStatusSnapshot(deviceId, commandId),
        });
      case 'request_inventory':
        return this.dispatchSafeCommand({
          deviceId,
          commandType,
          requestedCommandId: input.requestedCommandId,
          payload: null,
          payloadSummary: 'Request inventory',
          principal: input.principal,
          dispatch: (commandId) => this.agentGateway.requestInventory(deviceId, commandId),
        });
      case 'request_recent_logs':
        return this.dispatchSafeCommand({
          deviceId,
          commandType,
          requestedCommandId: input.requestedCommandId,
          payload: null,
          payloadSummary: 'Request recent logs',
          principal: input.principal,
          dispatch: (commandId) => this.agentGateway.requestRecentLogs(deviceId, commandId),
        });
      case 'restart_openvpn':
        return this.dispatchSafeCommand({
          deviceId,
          commandType,
          requestedCommandId: input.requestedCommandId,
          payload: null,
          payloadSummary: 'Restart OpenVPN',
          principal: input.principal,
          dispatch: (commandId) => this.agentGateway.requestRestartOpenvpn(deviceId, commandId),
        });
      case 'restart_boundary_auth':
        return this.dispatchSafeCommand({
          deviceId,
          commandType,
          requestedCommandId: input.requestedCommandId,
          payload: null,
          payloadSummary: 'Restart Boundary auth',
          principal: input.principal,
          dispatch: (commandId) => this.agentGateway.requestRestartBoundaryAuth(deviceId, commandId),
        });
      case 'restart_server_tunnel': {
        const serverId = readRequiredServerId(payload);
        return this.dispatchSafeCommand({
          deviceId,
          commandType,
          requestedCommandId: input.requestedCommandId,
          payload: { serverId },
          payloadSummary: `Restart server tunnel for ${serverId}`,
          principal: input.principal,
          dispatch: (commandId) => this.agentGateway.requestRestartServerTunnel(deviceId, serverId, commandId),
        });
      }
      case 'restart_server_ssh': {
        const serverId = readRequiredServerId(payload);
        return this.dispatchSafeCommand({
          deviceId,
          commandType,
          requestedCommandId: input.requestedCommandId,
          payload: { serverId },
          payloadSummary: `Restart server SSH for ${serverId}`,
          principal: input.principal,
          dispatch: (commandId) => this.agentGateway.requestRestartServerSsh(deviceId, serverId, commandId),
        });
      }
      case 'open_remote_browser': {
        enforceAdmission(this.fileOpAdmission.checkRemoteBrowserCapacity(deviceId), commandType);
        const serverId = readRequiredServerId(payload);
        const browserSessionId = readOptionalStringField(payload, 'browserSessionId') || uuidv4();
        const actor = mapPrincipalToActor(input.principal);
        const existingSession = this.remoteBrowserSessionStore.get(browserSessionId);
        if (existingSession) {
          ensureActorOwnsFileOpResource(
            {
              actorType: existingSession.actorType,
              actorId: existingSession.actorId,
            },
            actor.actorType,
            actor.actorId,
            'BROWSER_SESSION_UNAUTHORIZED',
            'Remote browser session is owned by another operator',
          );
          throw new HttpException(
            {
              ok: false,
              code: 'BROWSER_SESSION_ID_CONFLICT',
              message: 'browserSessionId already exists',
            },
            HttpStatus.CONFLICT,
          );
        }
        this.remoteBrowserSessionStore.createOpening({
          id: uuidv4(),
          browserSessionId,
          deviceId,
          serverId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          openedAt: nowIso(),
        });
        return this.dispatchSafeCommand({
          deviceId,
          commandType,
          requestedCommandId: input.requestedCommandId,
          payload: { serverId, browserSessionId },
          payloadSummary: `Open remote browser for ${serverId}`,
          principal: input.principal,
          dispatch: (commandId) => this.agentGateway.dispatchFileOpCommand(deviceId, 'open_remote_browser', { serverId, browserSessionId }, commandId),
        });
      }
      case 'close_remote_browser':
      case 'list_remote_browser_children':
      case 'stat_remote_browser_path':
      case 'create_remote_browser_directory':
      case 'delete_remote_browser_path': {
        const browserSessionId = readRequiredStringField(payload, 'browserSessionId');
        const session = this.remoteBrowserSessionStore.get(browserSessionId);
        if (!session || session.deviceId !== deviceId) {
          throw new HttpException({ ok: false, code: 'BROWSER_SESSION_NOT_FOUND', message: 'Remote browser session not found' }, HttpStatus.NOT_FOUND);
        }
        const actor = mapPrincipalToActor(input.principal);
        ensureActorOwnsFileOpResource(
          {
            actorType: session.actorType,
            actorId: session.actorId,
          },
          actor.actorType,
          actor.actorId,
          'BROWSER_SESSION_UNAUTHORIZED',
          'Remote browser session is owned by another operator',
        );
        const nextPayload: Record<string, unknown> = { browserSessionId };
        const path = readOptionalStringField(payload, 'path');
        if (path) {
          nextPayload.path = path;
        }
        if (commandType === 'delete_remote_browser_path') {
          nextPayload.recursive = readBooleanField(payload, 'recursive', false);
        }
        if (path) {
          this.remoteBrowserSessionStore.noteActivity(browserSessionId, nowIso(), path);
        }
        if (commandType === 'close_remote_browser') {
          this.remoteBrowserSessionStore.noteActivity(browserSessionId, nowIso(), null);
        }
        return this.dispatchSafeCommand({
          deviceId,
          commandType,
          requestedCommandId: input.requestedCommandId,
          payload: nextPayload,
          payloadSummary: `${commandType} for browser ${browserSessionId}`,
          principal: input.principal,
          dispatch: (commandId) => this.agentGateway.dispatchFileOpCommand(deviceId, commandType, nextPayload, commandId),
        });
      }
      case 'scp_upload':
      case 'start_scp_upload': {
        enforceAdmission(this.fileOpAdmission.checkTransferCapacity(deviceId), commandType);
        const quota = this.fileOpQuota.checkTransferStartQuota();
        enforceQuota(quota, commandType);
        const transfer = buildTransferPayload(payload, 'upload');
        ensureBoundaryTunnelRunningForTransfer(this.logStore, deviceId, transfer.serverId);
        const actor = mapPrincipalToActor(input.principal);
        const existingTransfer = this.fileTransferStore.get(transfer.transferId);
        if (existingTransfer) {
          ensureActorOwnsFileOpResource(
            {
              actorType: existingTransfer.actorType,
              actorId: existingTransfer.actorId,
            },
            actor.actorType,
            actor.actorId,
            'TRANSFER_UNAUTHORIZED',
            'Transfer is owned by another operator',
          );
          if (!isResumeTransferPayload(transfer)) {
            throw new HttpException(
              {
                ok: false,
                code: 'TRANSFER_ID_CONFLICT',
                message: 'transferId already exists',
              },
              HttpStatus.CONFLICT,
            );
          }
          ensureTransferCanResume(existingTransfer, deviceId, 'upload', transfer);
          this.fileTransferStore.prepareForResume(transfer.transferId, nowIso(), {
            attempt: existingTransfer.attempt,
            maxAttempts: existingTransfer.maxAttempts,
            resumeSupported: existingTransfer.resumeSupported,
            retryScheduled: false,
            resumeToken: existingTransfer.resumeToken,
            resumeOffsetBytes: existingTransfer.resumeOffsetBytes,
            tempPathHint: existingTransfer.tempPathHint,
            message: 'Resuming upload transfer',
          });
          return withQuotaWarning(
            this.dispatchSafeCommand({
              deviceId,
              commandType,
              requestedCommandId: input.requestedCommandId,
              payload: transfer,
              payloadSummary: `Resume upload ${transfer.localPath} to ${transfer.remotePath} on ${transfer.serverId}`,
              principal: input.principal,
              dispatch: (commandId) => {
                this.fileTransferStore.attachCommand(transfer.transferId, commandId, null, nowIso());
                const result = this.agentGateway.dispatchFileOpCommand(deviceId, commandType, transfer, commandId);
                if (!result.ok) {
                  this.fileTransferStore.markState(transfer.transferId, 'failed', nowIso(), { reasonCode: result.reason ?? 'DISPATCH_FAILED', reasonDetail: result.reason ?? null });
                } else {
                  this.fileTransferStore.attachCommand(transfer.transferId, commandId, result.reqSeq ?? null, result.requestedAt ?? nowIso());
                }
                return result;
              },
            }),
            quota.ok ? quota.warning : null,
          );
        }
        ensureBrowserSessionAuthorizedForTransfer(
          this.remoteBrowserSessionStore,
          transfer.browserSessionId,
          deviceId,
          transfer.serverId,
          actor.actorType,
          actor.actorId,
        );
        this.fileTransferStore.create({
          id: uuidv4(),
          transferId: transfer.transferId,
          deviceId,
          serverId: transfer.serverId,
          direction: 'upload',
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
          ts: nowIso(),
        });
        return withQuotaWarning(
          this.dispatchSafeCommand({
            deviceId,
            commandType,
            requestedCommandId: input.requestedCommandId,
            payload: transfer,
            payloadSummary: `Upload ${transfer.localPath} to ${transfer.remotePath} on ${transfer.serverId} (${describeSymlinkPolicy('upload', transfer.followSymlinks)})`,
            principal: input.principal,
            dispatch: (commandId) => {
              this.fileTransferStore.attachCommand(transfer.transferId, commandId, null, nowIso());
              const result = this.agentGateway.dispatchFileOpCommand(deviceId, commandType, transfer, commandId);
              if (!result.ok) {
                this.fileTransferStore.markState(transfer.transferId, 'failed', nowIso(), { reasonCode: result.reason ?? 'DISPATCH_FAILED', reasonDetail: result.reason ?? null });
              } else {
                this.fileTransferStore.attachCommand(transfer.transferId, commandId, result.reqSeq ?? null, result.requestedAt ?? nowIso());
              }
              return result;
            },
          }),
          quota.ok ? quota.warning : null,
        );
      }
      case 'scp_download':
      case 'start_scp_download': {
        enforceAdmission(this.fileOpAdmission.checkTransferCapacity(deviceId), commandType);
        const quota = this.fileOpQuota.checkTransferStartQuota();
        enforceQuota(quota, commandType);
        const transfer = buildTransferPayload(payload, 'download');
        ensureBoundaryTunnelRunningForTransfer(this.logStore, deviceId, transfer.serverId);
        const actor = mapPrincipalToActor(input.principal);
        const existingTransfer = this.fileTransferStore.get(transfer.transferId);
        if (existingTransfer) {
          ensureActorOwnsFileOpResource(
            {
              actorType: existingTransfer.actorType,
              actorId: existingTransfer.actorId,
            },
            actor.actorType,
            actor.actorId,
            'TRANSFER_UNAUTHORIZED',
            'Transfer is owned by another operator',
          );
          if (!isResumeTransferPayload(transfer)) {
            throw new HttpException(
              {
                ok: false,
                code: 'TRANSFER_ID_CONFLICT',
                message: 'transferId already exists',
              },
              HttpStatus.CONFLICT,
            );
          }
          ensureTransferCanResume(existingTransfer, deviceId, 'download', transfer);
          this.fileTransferStore.prepareForResume(transfer.transferId, nowIso(), {
            attempt: existingTransfer.attempt,
            maxAttempts: existingTransfer.maxAttempts,
            resumeSupported: existingTransfer.resumeSupported,
            retryScheduled: false,
            resumeToken: existingTransfer.resumeToken,
            resumeOffsetBytes: existingTransfer.resumeOffsetBytes,
            tempPathHint: existingTransfer.tempPathHint,
            message: 'Resuming download transfer',
          });
          return withQuotaWarning(
            this.dispatchSafeCommand({
              deviceId,
              commandType,
              requestedCommandId: input.requestedCommandId,
              payload: transfer,
              payloadSummary: `Resume download ${transfer.remotePath} to ${transfer.localPath} from ${transfer.serverId}`,
              principal: input.principal,
              dispatch: (commandId) => {
                this.fileTransferStore.attachCommand(transfer.transferId, commandId, null, nowIso());
                const result = this.agentGateway.dispatchFileOpCommand(deviceId, commandType, transfer, commandId);
                if (!result.ok) {
                  this.fileTransferStore.markState(transfer.transferId, 'failed', nowIso(), { reasonCode: result.reason ?? 'DISPATCH_FAILED', reasonDetail: result.reason ?? null });
                } else {
                  this.fileTransferStore.attachCommand(transfer.transferId, commandId, result.reqSeq ?? null, result.requestedAt ?? nowIso());
                }
                return result;
              },
            }),
            quota.ok ? quota.warning : null,
          );
        }
        ensureBrowserSessionAuthorizedForTransfer(
          this.remoteBrowserSessionStore,
          transfer.browserSessionId,
          deviceId,
          transfer.serverId,
          actor.actorType,
          actor.actorId,
        );
        this.fileTransferStore.create({
          id: uuidv4(),
          transferId: transfer.transferId,
          deviceId,
          serverId: transfer.serverId,
          direction: 'download',
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
          ts: nowIso(),
        });
        return withQuotaWarning(
          this.dispatchSafeCommand({
            deviceId,
            commandType,
            requestedCommandId: input.requestedCommandId,
            payload: transfer,
            payloadSummary: `Download ${transfer.remotePath} to ${transfer.localPath} from ${transfer.serverId} (${describeSymlinkPolicy('download', transfer.followSymlinks)})`,
            principal: input.principal,
            dispatch: (commandId) => {
              this.fileTransferStore.attachCommand(transfer.transferId, commandId, null, nowIso());
              const result = this.agentGateway.dispatchFileOpCommand(deviceId, commandType, transfer, commandId);
              if (!result.ok) {
                this.fileTransferStore.markState(transfer.transferId, 'failed', nowIso(), { reasonCode: result.reason ?? 'DISPATCH_FAILED', reasonDetail: result.reason ?? null });
              } else {
                this.fileTransferStore.attachCommand(transfer.transferId, commandId, result.reqSeq ?? null, result.requestedAt ?? nowIso());
              }
              return result;
            },
          }),
          quota.ok ? quota.warning : null,
        );
      }
      default:
        throw new HttpException(
          {
            ok: false,
            code: 'COMMAND_TYPE_UNSUPPORTED',
            message: 'Unsupported commandType',
            supportedCommandTypes: [
              'request_status_snapshot',
              'request_inventory',
              'request_recent_logs',
              'restart_openvpn',
              'restart_boundary_auth',
              'restart_server_tunnel',
              'restart_server_ssh',
              'open_remote_browser',
              'close_remote_browser',
              'list_remote_browser_children',
              'stat_remote_browser_path',
              'create_remote_browser_directory',
              'delete_remote_browser_path',
              'scp_upload',
              'scp_download',
              'start_scp_upload',
              'start_scp_download',
            ],
          },
          HttpStatus.BAD_REQUEST,
        );
    }
  }
}

function withQuotaWarning<T extends Record<string, unknown>>(
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

function enforceQuota(result: FileOpQuotaCheckResult, commandType: string) {
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

function isQuotaAllowed(
  result: FileOpQuotaCheckResult,
): result is Extract<FileOpQuotaCheckResult, { ok: true }> {
  return result.ok;
}

function mapPrincipalToActor(principal: AdminAuthPrincipal): {
  actorType: CommandActorType;
  actorId: string | null;
  source: string;
} {
  switch (principal.kind) {
    case 'db-token':
      return {
        actorType: 'admin_api_token',
        actorId: principal.tokenId,
        source: 'api',
      };
    case 'env-token':
      return {
        actorType: 'admin_env_token',
        actorId: 'CC_ADMIN_API_TOKEN',
        source: 'api',
      };
    case 'session':
    default:
      return {
        actorType: 'admin_session',
        actorId: null,
        source: 'admin_ui',
      };
  }
}

function nowIso() {
  return new Date().toISOString();
}

function ensureActorOwnsFileOpResource(
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

function ensureBrowserSessionAuthorizedForTransfer(
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

function readRequiredStringField(payload: unknown, field: string): string {
  if (!payload || typeof payload !== 'object') {
    throw new HttpException({ ok: false, code: 'INVALID_PAYLOAD', message: `${field} is required` }, HttpStatus.BAD_REQUEST);
  }
  const value = (payload as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpException({ ok: false, code: 'INVALID_PAYLOAD', message: `${field} is required` }, HttpStatus.BAD_REQUEST);
  }
  return value.trim();
}

function readOptionalStringField(payload: unknown, field: string): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readBooleanField(payload: unknown, field: string, fallback: boolean): boolean {
  if (!payload || typeof payload !== 'object') {
    return fallback;
  }
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'boolean' ? value : fallback;
}

function enforceAdmission(
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

function readNullablePositiveIntField(payload: unknown, field: string): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as Record<string, unknown>)[field];
  if (value == null || value === '') {
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) {
    throw new HttpException({ ok: false, code: 'INVALID_PAYLOAD', message: `${field} must be a positive integer` }, HttpStatus.BAD_REQUEST);
  }
  return num;
}

function readNullableNonNegativeIntField(payload: unknown, field: string): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const value = (payload as Record<string, unknown>)[field];
  if (value == null || value === '') {
    return null;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new HttpException({ ok: false, code: 'INVALID_PAYLOAD', message: `${field} must be a non-negative integer` }, HttpStatus.BAD_REQUEST);
  }
  return num;
}

function buildTransferPayload(payload: unknown, direction: 'upload' | 'download') {
  const transferId = readOptionalStringField(payload, 'transferId') || uuidv4();
  const serverId = readRequiredStringField(payload, 'serverId');
  const localPath = readRequiredStringField(payload, 'localPath');
  const remotePath = readRequiredStringField(payload, 'remotePath');
  const overwritePolicy = readOptionalStringField(payload, 'overwritePolicy') || 'prompt';
  const resumeToken = readOptionalStringField(payload, 'resumeToken');
  const resumeOffsetBytes = readNullableNonNegativeIntField(payload, 'resumeOffsetBytes');
  const tempPathHint = readOptionalStringField(payload, 'tempPathHint');
  if (!['prompt', 'force', 'skip'].includes(overwritePolicy)) {
    throw new HttpException(
      { ok: false, code: 'INVALID_PAYLOAD', message: 'overwritePolicy must be one of prompt, force, skip' },
      HttpStatus.BAD_REQUEST,
    );
  }
  const resumeFieldCount = [resumeToken, resumeOffsetBytes, tempPathHint].filter((value) => value != null).length;
  if (resumeFieldCount > 0 && resumeFieldCount < 3) {
    throw new HttpException(
      { ok: false, code: 'INVALID_PAYLOAD', message: 'resumeToken, resumeOffsetBytes, and tempPathHint must be provided together' },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (resumeOffsetBytes === 0) {
    throw new HttpException(
      { ok: false, code: 'INVALID_PAYLOAD', message: 'resumeOffsetBytes must be greater than zero when resuming a transfer' },
      HttpStatus.BAD_REQUEST,
    );
  }
  return {
    transferId,
    serverId,
    browserSessionId: readOptionalStringField(payload, 'browserSessionId'),
    localPath,
    remotePath,
    recursive: readBooleanField(payload, 'recursive', false),
    overwritePolicy,
    followSymlinks: readBooleanField(payload, 'followSymlinks', direction === 'download'),
    rateLimitKbps: readNullablePositiveIntField(payload, 'rateLimitKbps'),
    verifyChecksum: readBooleanField(payload, 'verifyChecksum', false),
    preserveMtime: readBooleanField(payload, 'preserveMtime', false),
    preserveMode: readBooleanField(payload, 'preserveMode', false),
    resumeToken,
    resumeOffsetBytes,
    tempPathHint,
  };
}

function isResumeTransferPayload(payload: {
  resumeToken?: string | null;
  resumeOffsetBytes?: number | null;
  tempPathHint?: string | null;
}) {
  return Boolean(payload.resumeToken && payload.tempPathHint && typeof payload.resumeOffsetBytes === 'number');
}

function ensureTransferCanResume(
  existing: FileTransferRecord,
  deviceId: string,
  direction: 'upload' | 'download',
  payload: ReturnType<typeof buildTransferPayload>,
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

function describeSymlinkPolicy(direction: 'upload' | 'download', followSymlinks: boolean): string {
  if (direction === 'upload') {
    return followSymlinks
      ? 'symlink policy: follow local symlink targets'
      : 'symlink policy: reject local symlink sources';
  }
  return followSymlinks
    ? 'symlink policy: follow remote symlink targets'
    : 'symlink policy: preserve remote symlinks (not yet supported by agent)';
}

function ensureBoundaryTunnelRunningForTransfer(
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

function readRequiredServerId(payload: unknown): string {
  const serverId =
    payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).serverId === 'string'
      ? (payload as Record<string, string>).serverId.trim()
      : '';
  if (!serverId) {
    throw new HttpException('payload.serverId is required', HttpStatus.BAD_REQUEST);
  }
  return serverId;
}
