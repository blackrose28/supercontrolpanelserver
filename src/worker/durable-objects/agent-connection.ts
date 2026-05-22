import type { WorkerEnv, DurableObjectStateLike } from '../types';
import { D1DeviceStore } from '../db/d1-device-store';
import { nowMs, requireD1 } from '../env-helpers';
import { jsonResponse, parseJsonBody, applySecurityHeaders } from '../http';
import { authenticateAgentRequest } from '../auth';
import { safeWebSocketSend } from '../agent-transport';
import { handleAgentSocketMessage } from '../agent-socket';

export class AgentConnectionDurableObject {
  constructor(private readonly state: DurableObjectStateLike, private readonly env: WorkerEnv) { }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this._fetch(request);
    } catch (err) {
      console.error('Agent Durable Object fetch error:', err);
      return jsonResponse({ error: 'INTERNAL_ERROR', details: String(err) }, { status: 500 });
    }
  }

  private async _fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/dispatch') {
      const envelope = await parseJsonBody(request);
      const sockets = this.state.getWebSockets?.() ?? [];
      const message = JSON.stringify(envelope);
      let delivered = 0;
      for (const socket of sockets) {
        if (safeWebSocketSend(socket, message)) {
          delivered += 1;
        }
      }
      return jsonResponse({ delivered, sockets: sockets.length });
    }

    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
      return jsonResponse({ error: 'WEBSOCKET_UPGRADE_REQUIRED' }, { status: 426 });
    }

    const auth = await authenticateAgentRequest(request, this.env);
    if (auth instanceof Response) return auth;

    const WebSocketPairCtor = (globalThis as any).WebSocketPair;
    if (typeof WebSocketPairCtor !== 'function') {
      return jsonResponse({ error: 'WEBSOCKET_PAIR_UNAVAILABLE' }, { status: 501 });
    }

    const pair = new WebSocketPairCtor();
    const client = pair[0] as WebSocket;
    const server = pair[1] as WebSocket;
    if (typeof this.state.acceptWebSocket === 'function') {
      this.state.acceptWebSocket(server, [auth.device.id]);
      (server as any).serializeAttachment?.({ deviceId: auth.device.id });
    } else {
      (server as any).accept?.();
    }

    await new D1DeviceStore(auth.db).updateDeviceStatus(auth.device.id, 'connected', new Date(nowMs(this.env)).toISOString());
    safeWebSocketSend(server, JSON.stringify({ type: 'welcome', payload: { deviceId: auth.device.id, protocol: 'scp.cc.v1', transport: 'durable-object-websocket' } }));
    const wsHeaders = applySecurityHeaders(new Headers());
    return new Response(null, { status: 101, headers: wsHeaders, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      let envelope: Record<string, any> = {};
      try {
        envelope = JSON.parse(text || '{}');
      } catch {
        return;
      }
      const attachment = (socket as any).deserializeAttachment?.();
      const deviceId = typeof attachment?.deviceId === 'string'
        ? attachment.deviceId
        : (typeof envelope.deviceId === 'string' ? envelope.deviceId : '');
      if (!deviceId) return;
      const db = requireD1(this.env);
      if (db instanceof Response) return;
      await handleAgentSocketMessage(db, this.env, deviceId, socket, text);
    } catch (err) {
      console.error('Agent Durable Object webSocketMessage error:', err);
    }
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const attachment = (socket as any).deserializeAttachment?.();
    if (attachment?.deviceId) {
      try {
        const db = requireD1(this.env);
        if (!(db instanceof Response)) {
          await new D1DeviceStore(db).updateDeviceStatus(attachment.deviceId, 'disconnected', new Date(nowMs(this.env)).toISOString());
        }
      } catch (err) {
        console.error('Agent Durable Object webSocketClose status update failed:', err);
      }
    }
  }
  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    const attachment = (socket as any).deserializeAttachment?.();
    if (attachment?.deviceId) {
      try {
        const db = requireD1(this.env);
        if (!(db instanceof Response)) {
          await new D1DeviceStore(db).updateDeviceStatus(
            attachment.deviceId,
            'disconnected',
            new Date(nowMs(this.env)).toISOString(),
          );
        }
      } catch (err) {
        console.warn('Agent Durable Object webSocketError status update failed:', err);
      }
    }
    console.warn('Agent Durable Object WebSocket disconnected:', String(error));
  }
}
