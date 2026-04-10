import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { AgentGateway } from '../agent/agent.gateway';
import {
  AdminAuthPrincipal,
} from '../admin/admin-auth';
import { DeviceStore } from '../devices/device.store';
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
  ) {}

  dispatchSafeCommand(input: {
    deviceId: string;
    commandType: SafeCommandType;
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
            ],
          },
          HttpStatus.BAD_REQUEST,
        );
    }
  }
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
