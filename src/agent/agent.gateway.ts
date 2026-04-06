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

@WebSocketGateway({ path: '/agent' })
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private seqCounter = 0;

  constructor(
    private deviceStore: DeviceStore,
    private readonly logStore: LogStore,
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
      this.deviceStore.removeSession(client.sessionId);
    }
  }

  requestStatusSnapshot(deviceId: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const envelope = this.sendMessage(session.ws, {
      type: 'request_status_snapshot',
      payload: null,
    });

    return {
      ok: true,
      deviceId,
      reqSeq: envelope.seq,
      requestedAt: envelope.ts,
    };
  }

  requestInventory(deviceId: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const envelope = this.sendMessage(session.ws, {
      type: 'request_inventory',
      payload: null,
    });

    return {
      ok: true,
      deviceId,
      reqSeq: envelope.seq,
      requestedAt: envelope.ts,
    };
  }

  requestRecentLogs(deviceId: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const envelope = this.sendMessage(session.ws, {
      type: 'request_recent_logs',
      payload: null,
    });

    return {
      ok: true,
      deviceId,
      reqSeq: envelope.seq,
      requestedAt: envelope.ts,
    };
  }

  requestRestartOpenvpn(deviceId: string) {
    const session = this.deviceStore.getSessionByDeviceId(deviceId);
    if (!session?.ws) {
      return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
    }

    const envelope = this.sendMessage(session.ws, {
      type: 'request_restart_openvpn',
      payload: null,
    });

    return {
      ok: true,
      deviceId,
      reqSeq: envelope.seq,
      requestedAt: envelope.ts,
    };
  }

  private handleRawMessage(data: string, client: any) {
    try {
      const envelope = JSON.parse(data);
      console.log(`Received from ${client.deviceId}: type=${envelope.type}`);

      switch (envelope.type) {
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
        case 'function-status':
          this.handleFunctionStatus(envelope, client);
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
    console.log(`Status snapshot from ${client.deviceId}:`, envelope.payload);

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
  }

  private handleInventory(envelope: any, client: any) {
    console.log(`Inventory from ${client.deviceId}:`, envelope.payload);

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
  }

  private handleRecentLogs(envelope: any, client: any) {
    console.log(`Recent logs from ${client.deviceId}:`, envelope.payload);

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
  }

  private handleFunctionStatus(envelope: any, client: any) {
    console.log(`Function status from ${client.deviceId}:`, envelope.payload);

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
}
