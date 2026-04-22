import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AgentGateway } from '../agent/agent.gateway';
import {
  AdminAuthPrincipal,
} from '../admin/admin-auth';
import { DeviceStore } from '../devices/device.store';
import { FileTransferStore } from '../file-ops/file-transfer.store';
import { FileOpAdmissionService } from '../file-ops/file-op-admission.service';
import { FileOpQuotaService } from '../file-ops/file-op-quota.service';
import { RemoteBrowserSessionStore } from '../file-ops/remote-browser-session.store';
import { LogStore } from '../logs/log.store';
import { PtySessionStore } from '../pty/pty-session.store';
import { mapPrincipalToActor } from './command-dispatch.actor';
import {
  readOptionalStringField,
} from './command-dispatch.parsers';
import { unsupportedCommandTypeError } from './command-dispatch.errors';
import { dispatchGenericCommandGroup } from './command-dispatch.generic';
import { dispatchRemoteBrowserCommand } from './command-dispatch.remote-browser';
import { dispatchTransferCommand } from './command-dispatch.transfer';
import { trackTransferSessionFromAck } from './command-dispatch.transfer-ack';
import { ServiceDispatchSafeInput } from './command-dispatch.types';
import { requireDispatchDevice } from './command-dispatch.validation';
import {
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

  dispatchSafeCommand(input: ServiceDispatchSafeInput) {
    const now = new Date().toISOString();
    const commandId = String(input.requestedCommandId || '').trim() || randomUUID();
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
      id: randomUUID(),
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
      id: randomUUID(),
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
        id: randomUUID(),
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
    trackTransferSessionFromAck(
      {
        deviceId: input.deviceId,
        commandType: input.commandType,
        payload: input.payload,
        actorType: actor.actorType,
        actorId: actor.actorId,
        reqSeq: result.reqSeq,
        requestedAt: result.requestedAt,
      },
      {
        agentGateway: this.agentGateway,
        fileTransferStore: this.fileTransferStore,
        ptySessionStore: this.ptySessionStore,
      },
    );
    this.commandStore.appendAudit({
      id: randomUUID(),
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

  dispatchGenericCommand(input: {
    deviceId: string;
    commandType: string;
    requestedCommandId?: string;
    payload?: unknown;
    principal: AdminAuthPrincipal;
  }) {
    const deviceId = requireDispatchDevice(this.deviceStore, input.deviceId);

    const commandType = input.commandType.trim() as SafeCommandType;
    const payload = input.payload ?? null;

    const genericResult = dispatchGenericCommandGroup(
      {
        deviceId,
        commandType,
        requestedCommandId: input.requestedCommandId,
        payload,
        principal: input.principal,
      },
      {
        agentGateway: this.agentGateway,
        dispatchSafeCommand: this.dispatchSafeCommand.bind(this),
      },
    );
    if (genericResult != null) {
      return genericResult;
    }

    switch (commandType) {
      case 'open_remote_browser':
      case 'close_remote_browser':
      case 'list_remote_browser_children':
      case 'stat_remote_browser_path':
      case 'create_remote_browser_directory':
      case 'delete_remote_browser_path':
        return dispatchRemoteBrowserCommand(
          {
            deviceId,
            commandType,
            requestedCommandId: input.requestedCommandId,
            payload,
            principal: input.principal,
          },
          {
            fileOpAdmission: this.fileOpAdmission,
            remoteBrowserSessionStore: this.remoteBrowserSessionStore,
            agentGateway: this.agentGateway,
            dispatchSafeCommand: this.dispatchSafeCommand.bind(this),
            nowIso,
          },
        );

      case 'scp_upload':
      case 'start_scp_upload':
        return dispatchTransferCommand(
          {
            direction: 'upload',
            commandType,
            requestedCommandId: input.requestedCommandId,
            deviceId,
            payload,
            principal: input.principal,
          },
          {
            fileOpAdmission: this.fileOpAdmission,
            fileOpQuota: this.fileOpQuota,
            fileTransferStore: this.fileTransferStore,
            remoteBrowserSessionStore: this.remoteBrowserSessionStore,
            logStore: this.logStore,
            agentGateway: this.agentGateway,
            dispatchSafeCommand: this.dispatchSafeCommand.bind(this),
            nowIso,
          },
        );
      case 'scp_download':
      case 'start_scp_download':
        return dispatchTransferCommand(
          {
            direction: 'download',
            commandType,
            requestedCommandId: input.requestedCommandId,
            deviceId,
            payload,
            principal: input.principal,
          },
          {
            fileOpAdmission: this.fileOpAdmission,
            fileOpQuota: this.fileOpQuota,
            fileTransferStore: this.fileTransferStore,
            remoteBrowserSessionStore: this.remoteBrowserSessionStore,
            logStore: this.logStore,
            agentGateway: this.agentGateway,
            dispatchSafeCommand: this.dispatchSafeCommand.bind(this),
            nowIso,
          },
        );
      default:
        throw unsupportedCommandTypeError();
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}
