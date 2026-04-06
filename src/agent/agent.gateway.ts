import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server } from 'ws';
import { DeviceStore } from '../devices/device.store';
import { v4 as uuidv4 } from 'uuid';

@WebSocketGateway({ path: '/agent' })
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private seqCounter = 0;

  constructor(private deviceStore: DeviceStore) {}

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
    
    // Store snapshot (in-memory for Phase 1)
    // TODO: persist in Phase 2
    
    this.sendMessage(client, {
      type: 'ack',
      reqSeq: envelope.seq,
      payload: { status: 'ok' },
    });
  }

  private handleFunctionStatus(envelope: any, client: any) {
    console.log(`Function status from ${client.deviceId}:`, envelope.payload);
    
    // TODO: persist and forward to SSE in Phase 2
    
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
