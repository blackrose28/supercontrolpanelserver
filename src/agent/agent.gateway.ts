import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'ws';
import { DeviceStore } from '../devices/device.store';
import { randomUUID } from 'node:crypto';
import { LogStore } from '../logs/log.store';
import { CommandRecord, CommandStore } from '../commands/command.store';
import { redactTelemetryPayload } from '../logs/log-redaction';
import { PtySessionStore } from '../pty/pty-session.store';
import { PtyHubService } from '../pty/pty-hub.service';
import { PtyAuditStore } from '../pty/pty-audit.store';
import { FileTransferStore } from '../file-ops/file-transfer.store';
import { payloadHasServerId, sendAgentMessage } from './agent-transport';
import {
  closePty as closePtyRequest,
  dispatchFileOpCommand as dispatchFileOpCommandRequest,
  openPty as openPtyRequest,
  requestInventory as requestInventoryRequest,
  requestRecentLogs as requestRecentLogsRequest,
  requestRestartBoundaryAuth as requestRestartBoundaryAuthRequest,
  requestStartServerTunnel as requestStartServerTunnelRequest,
  requestRestartOpenvpn as requestRestartOpenvpnRequest,
  requestRestartServerSsh as requestRestartServerSshRequest,
  requestRestartServerTunnel as requestRestartServerTunnelRequest,
  requestStopServerTunnel as requestStopServerTunnelRequest,
  requestStatusSnapshot as requestStatusSnapshotRequest,
  resizePty as resizePtyRequest,
  writePty as writePtyRequest,
} from './agent-request-handler';
import { handleAgentAck, handleAgentCommandStatus, handleAgentFunctionStatus, handleAgentHeartbeat, handleAgentInventory, handleAgentNack, handleAgentPtyExit, handleAgentPtyOutput, handleAgentRecentLogs, handleAgentStatusSnapshot, handleAgentTransferProgress, handleAgentTransferStatus } from './agent-event-handler';
import { routeAgentRawMessage } from './agent-message-router';
@WebSocketGateway({ path: '/agent' })
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private seqCounter = 0;
  private readonly pendingReqResponses = new Map<
    number,
    {
      deviceId: string;
      resolve: (value: { ok: true; payload: unknown; ts: string }) => void;
      reject: (reason?: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private deviceStore: DeviceStore,
    private readonly logStore: LogStore,
    private readonly commandStore: CommandStore,
    private readonly ptySessionStore: PtySessionStore,
    private readonly ptyHub: PtyHubService,
    private readonly ptyAudit: PtyAuditStore,
    private readonly fileTransferStore: FileTransferStore,
  ) {}

  handleConnection(client: any, request: any) {
    console.log('Agent connection attempt');
    
    // Extract Bearer token from Authorization header
    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      client.close(1008, 'AUTH_FAILED');
      return;
    }

    const token = authHeader.substring(7);
    
    const device = this.deviceStore.findDeviceByAgentToken(token);
    
    if (!device) {
      client.close(1008, 'AUTH_FAILED');
      return;
    }

    // Create session
    const sessionId = randomUUID();
    this.deviceStore.addSession({
      id: sessionId,
      deviceId: device.id,
      connectedAt: new Date().toISOString(),
      ws: client,
    });

    client.deviceId = device.id;
    client.sessionId = sessionId;

    console.log(`Agent connected: deviceId=${device.id}, sessionId=${sessionId}`);

    client.on('message', (raw: Buffer | string) => {
      const data = typeof raw === 'string' ? raw : raw.toString('utf8');
      this.handleRawMessage(data, client);
    });

    // Send welcome message
    this.sendMessage(client, {
      type: 'welcome',
      payload: {
        protocol: 'scp.cc.v1',
        capabilities: { gzip: false, chunking: false },
      },
    });
  }

  handleDisconnect(client: any) {
    if (client.sessionId) {
      console.log(`Agent disconnected: sessionId=${client.sessionId}`);
      if (client.deviceId) {
        const expired = this.ptySessionStore.expireDeviceSessions(
          client.deviceId,
          new Date().toISOString(),
          'AGENT_DISCONNECTED',
          'Agent disconnected while PTY session was active',
        );
        for (const record of expired) {
          this.ptyAudit.append({
            id: randomUUID(),
            sessionId: record.sessionId,
            deviceId: record.deviceId,
            ts: record.expiredAt || new Date().toISOString(),
            eventType: 'pty_expired',
            actorType: 'system',
            actorId: null,
            summary: 'PTY session expired because agent disconnected',
            details: { reasonCode: record.failureCode, reasonDetail: record.failureDetail },
          });
        }
      }
      this.deviceStore.removeSession(client.sessionId);
    }
  }

  requestStatusSnapshot(deviceId: string, commandId?: string) {
    return requestStatusSnapshotRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      commandId,
    );
  }

  requestInventory(deviceId: string, commandId?: string) {
    return requestInventoryRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      commandId,
    );
  }

  requestRecentLogs(deviceId: string, commandId?: string) {
    return requestRecentLogsRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      commandId,
    );
  }

  requestRestartOpenvpn(deviceId: string, commandId?: string) {
    return requestRestartOpenvpnRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      commandId,
    );
  }

  requestRestartBoundaryAuth(deviceId: string, commandId?: string) {
    return requestRestartBoundaryAuthRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      commandId,
    );
  }

  requestRestartServerTunnel(deviceId: string, serverId: string, commandId?: string) {
    return requestRestartServerTunnelRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      serverId,
      commandId,
    );
  }

  requestStartServerTunnel(deviceId: string, serverId: string, commandId?: string) {
    return requestStartServerTunnelRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      serverId,
      commandId,
    );
  }

  requestStopServerTunnel(deviceId: string, serverId: string, commandId?: string) {
    return requestStopServerTunnelRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      serverId,
      commandId,
    );
  }

  requestRestartServerSsh(deviceId: string, serverId: string, commandId?: string) {
    return requestRestartServerSshRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      serverId,
      commandId,
    );
  }

  dispatchFileOpCommand(
    deviceId: string,
    type: string,
    payload: Record<string, unknown>,
    commandId?: string,
  ) {
    return dispatchFileOpCommandRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      type,
      payload,
      commandId,
    );
  }

  awaitReqResponse(deviceId: string, reqSeq: number, timeoutMs = 30_000) {
    return new Promise<{ ok: true; payload: unknown; ts: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReqResponses.delete(reqSeq);
        reject(new Error(`Timed out waiting for reqSeq ${reqSeq}`));
      }, timeoutMs);

      this.pendingReqResponses.set(reqSeq, {
        deviceId,
        resolve,
        reject,
        timer,
      });
    });
  }

  openPty(
    deviceId: string,
    input: {
      sessionId: string;
      cols: number;
      rows: number;
      recording?: boolean;
      actorType?: string;
      actorId?: string | null;
    },
    commandId?: string,
  ) {
    return openPtyRequest(
      {
        deviceStore: this.deviceStore,
        ptySessionStore: this.ptySessionStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      input,
      commandId,
    );
  }

  writePty(deviceId: string, input: { sessionId: string; data: string }, commandId?: string) {
    return writePtyRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      input,
      commandId,
    );
  }

  resizePty(
    deviceId: string,
    input: { sessionId: string; cols: number; rows: number },
    commandId?: string,
  ) {
    return resizePtyRequest(
      {
        deviceStore: this.deviceStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      input,
      commandId,
    );
  }

  closePty(deviceId: string, input: { sessionId: string }, commandId?: string) {
    return closePtyRequest(
      {
        deviceStore: this.deviceStore,
        ptySessionStore: this.ptySessionStore,
        sendMessage: this.sendMessage.bind(this),
      },
      deviceId,
      input,
      commandId,
    );
  }


  private handleRawMessage(data: string, client: any) {
    routeAgentRawMessage({
      data,
      client,
      handleAck: this.handleAck.bind(this),
      handleNack: this.handleNack.bind(this),
      handleHeartbeat: this.handleHeartbeat.bind(this),
      handleStatusSnapshot: this.handleStatusSnapshot.bind(this),
      handleInventory: this.handleInventory.bind(this),
      handleRecentLogs: this.handleRecentLogs.bind(this),
      handleCommandStatus: this.handleCommandStatus.bind(this),
      handleFunctionStatus: this.handleFunctionStatus.bind(this),
      handlePtyOutput: this.handlePtyOutput.bind(this),
      handlePtyExit: this.handlePtyExit.bind(this),
      handleTransferProgress: this.handleTransferProgress.bind(this),
      handleTransferStatus: this.handleTransferStatus.bind(this),
    });
  }

  private handleHeartbeat(envelope: any, client: any) {
    handleAgentHeartbeat({
      envelope,
      client,
      deviceStore: this.deviceStore,
      sendMessage: this.sendMessage.bind(this),
    });
  }

  private handleStatusSnapshot(envelope: any, client: any) {
    handleAgentStatusSnapshot({
      envelope,
      client,
      logStore: this.logStore,
      redactTelemetryPayload,
      sendMessage: this.sendMessage.bind(this),
      completeRefreshCommand: this.completeRefreshCommand.bind(this),
    });
  }

  private handleInventory(envelope: any, client: any) {
    handleAgentInventory({
      envelope,
      client,
      logStore: this.logStore,
      redactTelemetryPayload,
      sendMessage: this.sendMessage.bind(this),
      completeRefreshCommand: this.completeRefreshCommand.bind(this),
    });
  }

  private handleAck(envelope: any, client: any) {
    handleAgentAck({
      envelope,
      client,
      pendingReqResponses: this.pendingReqResponses,
      commandStore: this.commandStore,
      ptySessionStore: this.ptySessionStore,
      ptyAudit: this.ptyAudit,
    });

    // Transport-level ack only confirms receipt of the frame.
    // Command lifecycle audit should come from explicit command_status
    // or a compatibility fallback tied to an observed result.
  }

  private handleNack(envelope: any, client: any) {
    handleAgentNack({
      envelope,
      client,
      pendingReqResponses: this.pendingReqResponses,
      commandStore: this.commandStore,
      ptySessionStore: this.ptySessionStore,
    });
  }

  private handleRecentLogs(envelope: any, client: any) {
    handleAgentRecentLogs({
      envelope,
      client,
      logStore: this.logStore,
      redactTelemetryPayload,
      sendMessage: this.sendMessage.bind(this),
      completeRefreshCommand: this.completeRefreshCommand.bind(this),
    });
  }

  private handleFunctionStatus(envelope: any, client: any) {
    handleAgentFunctionStatus({
      envelope,
      client,
      logStore: this.logStore,
      redactTelemetryPayload,
      sendMessage: this.sendMessage.bind(this),
      advanceRestartCommandFromFunctionStatus: this.advanceRestartCommandFromFunctionStatus.bind(this),
    });
  }

  private handlePtyOutput(envelope: any, client: any) {
    handleAgentPtyOutput({
      envelope,
      client,
      logStore: this.logStore,
      ptySessionStore: this.ptySessionStore,
      ptyHub: this.ptyHub,
    });
  }

  private handlePtyExit(envelope: any, client: any) {
    handleAgentPtyExit({
      envelope,
      client,
      logStore: this.logStore,
      ptySessionStore: this.ptySessionStore,
      ptyAudit: this.ptyAudit,
      ptyHub: this.ptyHub,
    });
  }

  private handleTransferProgress(envelope: any, client: any) {
    handleAgentTransferProgress({
      envelope,
      client,
      fileTransferStore: this.fileTransferStore,
      sendMessage: this.sendMessage.bind(this),
    });
  }

  private handleTransferStatus(envelope: any, client: any) {
    handleAgentTransferStatus({
      envelope,
      client,
      fileTransferStore: this.fileTransferStore,
      sendMessage: this.sendMessage.bind(this),
    });
  }

  private handleCommandStatus(envelope: any, client: any) {
    handleAgentCommandStatus({
      envelope,
      client,
      commandStore: this.commandStore,
    });
  }

  private sendMessage(client: any, message: any) {
    this.seqCounter += 1;
    return sendAgentMessage(client, message, this.seqCounter);
  }

  private completeRefreshCommand(
    deviceId: string,
    commandType: 'request_status_snapshot' | 'request_inventory' | 'request_recent_logs',
    observedAt: string | undefined,
    outcome: string,
  ) {
    const command = this.commandStore.findPendingCommand(deviceId, commandType);
    if (!command) {
      return;
    }

    if (this.commandStore.hasAuditEvent(command.commandId, ['acknowledged', 'executing', 'succeeded', 'failed'], 'agent')) {
      return;
    }

    const ts = observedAt || new Date().toISOString();
    this.commandStore.markSucceeded(command.commandId, outcome, ts);
    this.commandStore.appendAuditIfMissing({
      id: randomUUID(),
      commandId: command.commandId,
      ts,
      eventType: 'succeeded',
      source: 'agent-fallback',
      summary: `${commandType} completed from response payload`,
      details: {
        commandType,
        outcome,
      },
    });
  }

  private advanceRestartCommandFromFunctionStatus(
    deviceId: string,
    observedAt: string | undefined,
    payload: Record<string, unknown>,
  ) {
    const functionId =
      typeof payload.functionId === 'string' ? payload.functionId.trim() : '';
    const state = typeof payload.state === 'string' ? payload.state.trim() : '';
    const message = typeof payload.message === 'string' ? payload.message : '';
    if (!functionId || !state) {
      return;
    }

    const command = this.findRestartCommandForFunction(deviceId, functionId);
    if (!command) {
      return;
    }

    const ts = observedAt || new Date().toISOString();
    if (['starting', 'stopping', 'restarting', 'authenticating', 'idle'].includes(state)) {
      this.commandStore.markExecuting(command.commandId, ts);
      this.commandStore.appendAuditIfMissing({
        id: randomUUID(),
        commandId: command.commandId,
        ts,
        eventType: 'executing',
        source: 'agent',
        summary: `${command.commandType} is executing (${state})`,
        details: {
          functionId,
          state,
          message,
        },
      });
      return;
    }

    if (state === 'error') {
      this.commandStore.markFailed(
        command.commandId,
        'FUNCTION_STATUS_ERROR',
        message || 'Function reported error',
        ts,
      );
      this.commandStore.appendAuditIfMissing({
        id: randomUUID(),
        commandId: command.commandId,
        ts,
        eventType: 'failed',
        source: 'agent',
        summary: `${command.commandType} failed (${functionId})`,
        details: {
          functionId,
          state,
          message,
        },
      });
      return;
    }

    if (['running', 'authenticated'].includes(state)) {
      this.commandStore.markExecuting(command.commandId, ts);
      this.commandStore.appendAuditIfMissing({
        id: randomUUID(),
        commandId: command.commandId,
        ts,
        eventType: 'executing',
        source: 'agent',
        summary: `${command.commandType} reached active state (${state})`,
        details: {
          functionId,
          state,
          message,
        },
      });
      this.commandStore.markSucceeded(command.commandId, message || state, ts);
      this.commandStore.appendAuditIfMissing({
        id: randomUUID(),
        commandId: command.commandId,
        ts,
        eventType: 'succeeded',
        source: 'agent',
        summary: `${command.commandType} completed successfully`,
        details: {
          functionId,
          state,
          message,
        },
      });
    }
  }

  private findRestartCommandForFunction(deviceId: string, functionId: string): CommandRecord | undefined {
    if (functionId === 'openvpn-connect') {
      return this.commandStore.findPendingCommand(deviceId, 'restart_openvpn');
    }
    if (functionId === 'boundary-auth') {
      return this.commandStore.findPendingCommand(deviceId, 'restart_boundary_auth');
    }
    if (functionId.startsWith('server-tunnel-')) {
      const serverId = functionId.slice('server-tunnel-'.length);
      return this.commandStore.findPendingCommand(
        deviceId,
        'restart_server_tunnel',
        (payload) => payloadHasServerId(payload, serverId),
      );
    }
    if (functionId.startsWith('server-ssh-')) {
      const serverId = functionId.slice('server-ssh-'.length);
      return this.commandStore.findPendingCommand(
        deviceId,
        'restart_server_ssh',
        (payload) => payloadHasServerId(payload, serverId),
      );
    }
    return undefined;
  }
}
