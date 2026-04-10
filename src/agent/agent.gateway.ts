import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'ws';
import { DeviceStore } from '../devices/device.store';
import { v4 as uuidv4 } from 'uuid';
import { LogStore } from '../logs/log.store';
import { CommandRecord, CommandStore } from '../commands/command.store';
import { redactTelemetryPayload } from '../logs/log-redaction';
import { PtySessionStore } from '../pty/pty-session.store';
import { PtyHubService } from '../pty/pty-hub.service';
import { PtyAuditStore } from '../pty/pty-audit.store';

@WebSocketGateway({ path: '/agent' })
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private seqCounter = 0;

  constructor(
    private deviceStore: DeviceStore,
    private readonly logStore: LogStore,
    private readonly commandStore: CommandStore,
    private readonly ptySessionStore: PtySessionStore,
    private readonly ptyHub: PtyHubService,
    private readonly ptyAudit: PtyAuditStore,
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
    const sessionId = uuidv4();
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
            id: uuidv4(),
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
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const envelope = this.sendMessage(session.ws, {
      type: 'request_status_snapshot',
      commandId,
      payload: null,
    });

    return {
      ok: true,
      deviceId,
      reqSeq: envelope.seq,
      requestedAt: envelope.ts,
    };
  }

  requestInventory(deviceId: string, commandId?: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const envelope = this.sendMessage(session.ws, {
      type: 'request_inventory',
      commandId,
      payload: null,
    });

    return {
      ok: true,
      deviceId,
      reqSeq: envelope.seq,
      requestedAt: envelope.ts,
    };
  }

  requestRecentLogs(deviceId: string, commandId?: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const envelope = this.sendMessage(session.ws, {
      type: 'request_recent_logs',
      commandId,
      payload: null,
    });

    return {
      ok: true,
      deviceId,
      reqSeq: envelope.seq,
      requestedAt: envelope.ts,
    };
  }

  requestRestartOpenvpn(deviceId: string, commandId?: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const envelope = this.sendMessage(session.ws, {
      type: 'request_restart_openvpn',
      commandId,
      payload: null,
    });

    return {
      ok: true,
      deviceId,
      reqSeq: envelope.seq,
      requestedAt: envelope.ts,
    };
  }

  requestRestartBoundaryAuth(deviceId: string, commandId?: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const envelope = this.sendMessage(session.ws, {
      type: 'request_restart_boundary_auth',
      commandId,
      payload: null,
    });

    return {
      ok: true,
      deviceId,
      reqSeq: envelope.seq,
      requestedAt: envelope.ts,
    };
  }

  requestRestartServerTunnel(deviceId: string, serverId: string, commandId?: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const normalizedServerId = String(serverId || '').trim();
    if (!normalizedServerId) {
      return { ok: false, reason: 'SERVER_ID_REQUIRED' };
    }

    const envelope = this.sendMessage(session.ws, {
      type: 'request_restart_server_tunnel',
      commandId,
      payload: { serverId: normalizedServerId },
    });

    return {
      ok: true,
      deviceId,
      serverId: normalizedServerId,
      reqSeq: envelope.seq,
      requestedAt: envelope.ts,
    };
  }

  requestRestartServerSsh(deviceId: string, serverId: string, commandId?: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const normalizedServerId = String(serverId || '').trim();
    if (!normalizedServerId) {
      return { ok: false, reason: 'SERVER_ID_REQUIRED' };
    }

    const envelope = this.sendMessage(session.ws, {
      type: 'request_restart_server_ssh',
      commandId,
      payload: { serverId: normalizedServerId },
    });

    return {
      ok: true,
      deviceId,
      serverId: normalizedServerId,
      reqSeq: envelope.seq,
      requestedAt: envelope.ts,
    };
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
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const normalizedSessionId = String(input.sessionId || '').trim();
    if (!normalizedSessionId) {
      return { ok: false, reason: 'SESSION_ID_REQUIRED' };
    }

    this.ptySessionStore.createOpening({
      id: uuidv4(),
      sessionId: normalizedSessionId,
      deviceId,
      cols: input.cols,
      rows: input.rows,
      openedAt: new Date().toISOString(),
      recordingEnabled: Boolean(input.recording),
      openedByActorType: input.actorType ?? null,
      openedByActorId: input.actorId ?? null,
      attachedActorType: input.actorType ?? null,
      attachedActorId: input.actorId ?? null,
    });

    const envelope = this.sendMessage(session.ws, {
      type: 'open_pty',
      commandId,
      payload: {
        sessionId: normalizedSessionId,
        cols: input.cols,
        rows: input.rows,
        recording: Boolean(input.recording),
      },
    });
    this.ptySessionStore.trackPendingReq(deviceId, envelope.seq, normalizedSessionId, 'open');

    return { ok: true, deviceId, sessionId: normalizedSessionId, reqSeq: envelope.seq, requestedAt: envelope.ts };
  }

  writePty(deviceId: string, input: { sessionId: string; data: string }, commandId?: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }
    const normalizedSessionId = String(input.sessionId || '').trim();
    if (!normalizedSessionId) {
      return { ok: false, reason: 'SESSION_ID_REQUIRED' };
    }
    const envelope = this.sendMessage(session.ws, {
      type: 'write_pty',
      commandId,
      payload: {
        sessionId: normalizedSessionId,
        data: String(input.data ?? ''),
      },
    });
    return { ok: true, deviceId, sessionId: normalizedSessionId, reqSeq: envelope.seq, requestedAt: envelope.ts };
  }

  resizePty(
    deviceId: string,
    input: { sessionId: string; cols: number; rows: number },
    commandId?: string,
  ) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }
    const normalizedSessionId = String(input.sessionId || '').trim();
    if (!normalizedSessionId) {
      return { ok: false, reason: 'SESSION_ID_REQUIRED' };
    }
    const envelope = this.sendMessage(session.ws, {
      type: 'resize_pty',
      commandId,
      payload: {
        sessionId: normalizedSessionId,
        cols: input.cols,
        rows: input.rows,
      },
    });
    return { ok: true, deviceId, sessionId: normalizedSessionId, reqSeq: envelope.seq, requestedAt: envelope.ts };
  }

  closePty(deviceId: string, input: { sessionId: string }, commandId?: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }
    const normalizedSessionId = String(input.sessionId || '').trim();
    if (!normalizedSessionId) {
      return { ok: false, reason: 'SESSION_ID_REQUIRED' };
    }
    this.ptySessionStore.markClosing(normalizedSessionId, new Date().toISOString());

    const envelope = this.sendMessage(session.ws, {
      type: 'close_pty',
      commandId,
      payload: { sessionId: normalizedSessionId },
    });
    this.ptySessionStore.trackPendingReq(deviceId, envelope.seq, normalizedSessionId, 'close');
    return { ok: true, deviceId, sessionId: normalizedSessionId, reqSeq: envelope.seq, requestedAt: envelope.ts };
  }

  private handleRawMessage(data: string, client: any) {
    try {
      const envelope = JSON.parse(data);
      console.log(`Received from ${client.deviceId}: type=${envelope.type}`);

      switch (envelope.type) {
        case 'ack':
          this.handleAck(envelope, client);
          break;
        case 'nack':
          this.handleNack(envelope, client);
          break;
        case 'heartbeat':
          this.handleHeartbeat(envelope, client);
          break;
        case 'status_snapshot':
          this.handleStatusSnapshot(envelope, client);
          break;
        case 'inventory':
          this.handleInventory(envelope, client);
          break;
        case 'recent_logs':
          this.handleRecentLogs(envelope, client);
          break;
        case 'command_status':
          this.handleCommandStatus(envelope, client);
          break;
        case 'function-status':
          this.handleFunctionStatus(envelope, client);
          break;
        case 'pty-output':
          this.handlePtyOutput(envelope, client);
          break;
        case 'pty-exit':
          this.handlePtyExit(envelope, client);
          break;
        default:
          console.log(`Unknown message type: ${envelope.type}`);
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  }

  private handleHeartbeat(envelope: any, client: any) {
    // Update lastSeenAt
    this.deviceStore.updateDeviceStatus(client.deviceId, 'connected');
    
    // Send ack
    this.sendMessage(client, {
      type: 'ack',
      reqSeq: envelope.seq,
      payload: { status: 'ok' },
    });
  }

  private handleStatusSnapshot(envelope: any, client: any) {
    console.log(`Status snapshot from ${client.deviceId}:`, redactTelemetryPayload(envelope.payload ?? null));

    this.logStore.append({
      id: uuidv4(),
      deviceId: client.deviceId,
      type: 'status_snapshot',
      sessionId: client.sessionId ?? null,
      functionId: null,
      seq: typeof envelope.seq === 'number' ? envelope.seq : Date.now(),
      ts: envelope.ts || new Date().toISOString(),
      payload: envelope.payload ?? null,
    });

    this.sendMessage(client, {
      type: 'ack',
      reqSeq: envelope.seq,
      payload: { status: 'ok' },
    });

    this.completeRefreshCommand(client.deviceId, 'request_status_snapshot', envelope.ts, 'status snapshot received');
  }

  private handleInventory(envelope: any, client: any) {
    console.log(`Inventory from ${client.deviceId}:`, redactTelemetryPayload(envelope.payload ?? null));

    this.logStore.append({
      id: uuidv4(),
      deviceId: client.deviceId,
      type: 'inventory',
      sessionId: client.sessionId ?? null,
      functionId: null,
      seq: typeof envelope.seq === 'number' ? envelope.seq : Date.now(),
      ts: envelope.ts || new Date().toISOString(),
      payload: envelope.payload ?? null,
    });

    this.sendMessage(client, {
      type: 'ack',
      reqSeq: envelope.seq,
      payload: { status: 'ok' },
    });

    this.completeRefreshCommand(client.deviceId, 'request_inventory', envelope.ts, 'inventory received');
  }

  private handleAck(envelope: any, client: any) {
    const reqSeq = typeof envelope.reqSeq === 'number' ? envelope.reqSeq : null;
    if (reqSeq == null) {
      return;
    }

    const command = this.commandStore.findByReqSeq(client.deviceId, reqSeq);
    const pendingPty = this.ptySessionStore.consumePendingReq(client.deviceId, reqSeq);
    if (pendingPty) {
      const ts = envelope.ts || new Date().toISOString();
      if (pendingPty.type === 'open') {
        const opened = this.ptySessionStore.markOpen(pendingPty.sessionId, ts);
        this.ptyAudit.append({
          id: uuidv4(),
          sessionId: opened.sessionId,
          deviceId: opened.deviceId,
          ts,
          eventType: 'pty_opened',
          actorType: opened.openedByActorType as any,
          actorId: opened.openedByActorId,
          summary: 'PTY session opened',
          details: { recordingEnabled: opened.recordingEnabled, cols: opened.cols, rows: opened.rows },
        });
      } else if (pendingPty.type === 'close') {
        this.ptySessionStore.markClosing(pendingPty.sessionId, ts);
      }
    }
    if (!command) {
      return;
    }

    // Transport-level ack only confirms receipt of the frame.
    // Command lifecycle audit should come from explicit command_status
    // or a compatibility fallback tied to an observed result.
  }

  private handleNack(envelope: any, client: any) {
    const reqSeq = typeof envelope.reqSeq === 'number' ? envelope.reqSeq : null;
    if (reqSeq == null) {
      return;
    }

    const command = this.commandStore.findByReqSeq(client.deviceId, reqSeq);
    const pendingPty = this.ptySessionStore.consumePendingReq(client.deviceId, reqSeq);
    if (!command) {
      if (!pendingPty) {
        return;
      }
    }

    const payload =
      envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
    const reasonCode =
      typeof payload.error === 'string' && payload.error.trim().length
        ? payload.error.trim()
        : 'AGENT_NACK';
    const finishedAt = envelope.ts || new Date().toISOString();

    if (pendingPty) {
      if (pendingPty.type === 'open') {
        this.ptySessionStore.markOpenFailed(pendingPty.sessionId, reasonCode, reasonCode, finishedAt);
      }
      return;
    }

    this.commandStore.markFailed(command.commandId, reasonCode, reasonCode, finishedAt);
    this.commandStore.appendAuditIfMissing({
      id: uuidv4(),
      commandId: command.commandId,
      ts: finishedAt,
      eventType: 'failed',
      source: 'agent',
      summary: `Agent rejected reqSeq ${reqSeq}: ${reasonCode}`,
      details: {
        reqSeq,
        payload: envelope.payload ?? null,
      },
    });
  }

  private handleRecentLogs(envelope: any, client: any) {
    console.log(`Recent logs from ${client.deviceId}:`, redactTelemetryPayload(envelope.payload ?? null));

    this.logStore.append({
      id: uuidv4(),
      deviceId: client.deviceId,
      type: 'recent_logs',
      sessionId: client.sessionId ?? null,
      functionId: null,
      seq: typeof envelope.seq === 'number' ? envelope.seq : Date.now(),
      ts: envelope.ts || new Date().toISOString(),
      payload: envelope.payload ?? null,
    });

    this.sendMessage(client, {
      type: 'ack',
      reqSeq: envelope.seq,
      payload: { status: 'ok' },
    });

    this.completeRefreshCommand(client.deviceId, 'request_recent_logs', envelope.ts, 'recent logs received');

  }

  private handleFunctionStatus(envelope: any, client: any) {
    console.log(`Function status from ${client.deviceId}:`, redactTelemetryPayload(envelope.payload ?? null));

    const payload =
      envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
    const functionId =
      typeof payload.functionId === 'string' ? payload.functionId : null;

    this.logStore.append({
      id: uuidv4(),
      deviceId: client.deviceId,
      type: 'function-status',
      sessionId:
        typeof payload.sessionId === 'string'
          ? payload.sessionId
          : client.sessionId ?? null,
      functionId,
      seq: typeof envelope.seq === 'number' ? envelope.seq : Date.now(),
      ts: envelope.ts || new Date().toISOString(),
      payload: envelope.payload ?? null,
    });

    this.sendMessage(client, {
      type: 'ack',
      reqSeq: envelope.seq,
      payload: { status: 'ok' },
    });

    this.advanceRestartCommandFromFunctionStatus(client.deviceId, envelope.ts, payload);
  }

  private handlePtyOutput(envelope: any, client: any) {
    const payload =
      envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
    const sessionId =
      typeof payload.sessionId === 'string'
        ? payload.sessionId
        : typeof payload.id === 'string'
          ? payload.id
          : client.sessionId ?? null;

    this.logStore.append({
      id: uuidv4(),
      deviceId: client.deviceId,
      type: 'pty-output',
      sessionId,
      functionId: null,
      seq: typeof envelope.seq === 'number' ? envelope.seq : Date.now(),
      ts: envelope.ts || new Date().toISOString(),
      payload: envelope.payload ?? null,
    });
    if (sessionId) {
      this.ptySessionStore.noteOutput(sessionId, envelope.ts || new Date().toISOString());
      const data = typeof payload.data === 'string' ? payload.data : '';
      this.ptyHub.appendOutput(sessionId, data);
      this.ptyHub.broadcast(sessionId, {
        type: 'pty_output',
        payload: {
          ...(payload ?? {}),
          sessionId,
        },
      });
    }
  }

  private handlePtyExit(envelope: any, client: any) {
    const payload =
      envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
    const sessionId =
      typeof payload.sessionId === 'string'
        ? payload.sessionId
        : typeof payload.id === 'string'
          ? payload.id
          : client.sessionId ?? null;

    this.logStore.append({
      id: uuidv4(),
      deviceId: client.deviceId,
      type: 'pty-exit',
      sessionId,
      functionId: null,
      seq: typeof envelope.seq === 'number' ? envelope.seq : Date.now(),
      ts: envelope.ts || new Date().toISOString(),
      payload: envelope.payload ?? null,
    });
    if (sessionId) {
      const reason =
        typeof payload.reason === 'string' && payload.reason.trim().length
          ? payload.reason.trim()
          : null;
      const closed = this.ptySessionStore.markClosed(sessionId, envelope.ts || new Date().toISOString(), reason);
      this.ptyAudit.append({
        id: uuidv4(),
        sessionId: closed.sessionId,
        deviceId: closed.deviceId,
        ts: closed.closedAt || envelope.ts || new Date().toISOString(),
        eventType: 'pty_closed',
        actorType: 'system',
        actorId: null,
        summary: 'PTY session closed after agent exit',
        details: { exitReason: reason, payload: { exitCode: payload.exitCode ?? null, reason } },
      });
      this.ptyHub.broadcast(sessionId, {
        type: 'pty_exit',
        payload: {
          ...(payload ?? {}),
          sessionId,
        },
      });
    }
  }

  private handleCommandStatus(envelope: any, client: any) {
    const commandId =
      typeof envelope.commandId === 'string' && envelope.commandId.trim().length
        ? envelope.commandId.trim()
        : null;
    if (!commandId) {
      return;
    }

    const command = this.commandStore.getCommand(commandId);
    if (!command || command.deviceId !== client.deviceId) {
      return;
    }

    const payload =
      envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
    const state = typeof payload.state === 'string' ? payload.state.trim() : '';
    const outcome =
      typeof payload.outcome === 'string' && payload.outcome.trim().length
        ? payload.outcome.trim()
        : null;
    const reasonCode =
      typeof payload.reasonCode === 'string' && payload.reasonCode.trim().length
        ? payload.reasonCode.trim()
        : null;
    const reasonDetail =
      typeof payload.reasonDetail === 'string' && payload.reasonDetail.trim().length
        ? payload.reasonDetail.trim()
        : null;
    const ts = envelope.ts || new Date().toISOString();

    if (state === 'acknowledged') {
      if (!this.commandStore.hasAuditEvent(commandId, ['acknowledged', 'executing', 'succeeded', 'failed', 'canceled'], 'agent')) {
        this.commandStore.appendAuditIfMissing({
          id: uuidv4(),
          commandId,
          ts,
          eventType: 'acknowledged',
          source: 'agent',
          summary: `Agent acknowledged ${command.commandType}`,
          details: payload,
        });
      }
      return;
    }

    if (state === 'executing') {
      const updated = this.commandStore.markExecuting(commandId, ts);
      if (updated.state === 'executing' || updated.executingAt === ts) {
        this.commandStore.appendAuditIfMissing({
          id: uuidv4(),
          commandId,
          ts,
          eventType: 'executing',
          source: 'agent',
          summary: `Agent started ${command.commandType}`,
          details: payload,
        });
      }
      return;
    }

    if (state === 'succeeded') {
      if (command.state === 'succeeded' || command.state === 'failed' || command.state === 'canceled') {
        return;
      }

      this.commandStore.markSucceeded(commandId, outcome, ts);
      this.commandStore.appendAuditIfMissing({
        id: uuidv4(),
        commandId,
        ts,
        eventType: 'succeeded',
        source: 'agent',
        summary: `Agent completed ${command.commandType}`,
        details: payload,
      });
      return;
    }

    if (state === 'failed') {
      if (command.state === 'succeeded' || command.state === 'failed' || command.state === 'canceled') {
        return;
      }

      this.commandStore.markFailed(
        commandId,
        reasonCode ?? 'COMMAND_FAILED',
        reasonDetail,
        ts,
      );
      this.commandStore.appendAuditIfMissing({
        id: uuidv4(),
        commandId,
        ts,
        eventType: 'failed',
        source: 'agent',
        summary: `Agent failed ${command.commandType}`,
        details: payload,
      });
    }
  }

  private sendMessage(client: any, message: any) {
    const envelope = {
      ...message,
      deviceId: 'server',
      seq: ++this.seqCounter,
      ts: new Date().toISOString(),
    };
    client.send(JSON.stringify(envelope));
    return envelope;
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
      id: uuidv4(),
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
        id: uuidv4(),
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
        id: uuidv4(),
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
        id: uuidv4(),
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
        id: uuidv4(),
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

function payloadHasServerId(payload: unknown, serverId: string): boolean {
  return !!payload
    && typeof payload === 'object'
    && typeof (payload as Record<string, unknown>).serverId === 'string'
    && (payload as Record<string, unknown>).serverId === serverId;
}
