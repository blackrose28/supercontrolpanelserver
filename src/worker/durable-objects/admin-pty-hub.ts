import type { WorkerEnv, AdminPrincipal, DurableObjectStateLike } from '../types';
import { D1DeviceStore } from '../db/d1-device-store';
import { D1CommandStore } from '../db/d1-command-store';
import { D1PtyAuditStore, D1PtySessionStore } from '../db/d1-pty-store';
import { nowMs, makeUuid, requireD1 } from '../env-helpers';
import { jsonResponse, parseJsonBody, applySecurityHeaders } from '../http';
import { adminActorType, adminActorId } from '../auth';
import { safeWebSocketSend, publicCommand, notifyAgentDurableObject } from '../agent-transport';

/**
 * Hibernatable WebSocket Durable Object that owns every admin /admin/ws/pty connection.
 *
 * Why this exists: when pty-output arrives at the agent socket DO and we want to forward
 * it to the admin browser's WebSocket, Cloudflare's I/O isolation rules forbid touching
 * a WebSocket from a different request handler — even within the same isolate. The only
 * supported way to send to a WebSocket from "outside" its originating request is to put
 * the WebSocket inside a Durable Object that uses `state.acceptWebSocket()`. The DO
 * itself becomes the single owner; any of its method calls (including a `fetch()` from
 * the agent DO) can iterate `state.getWebSockets()` and call `.send()` legally.
 *
 * Singleton: routed through `idFromName('admin-pty-hub-singleton')` so all admin browser
 * tabs across the worker land in the same DO instance and the agent DO has a single
 * place to fan out to.
 */
export class AdminPtyHubDurableObject {
  constructor(
    private readonly state: DurableObjectStateLike & {
      acceptWebSocket?: (socket: WebSocket, tags?: string[]) => void;
      getWebSockets?: (tag?: string) => WebSocket[];
    },
    private readonly env: WorkerEnv,
  ) { }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/fanout') {
        return await this.handleFanout(request);
      }
      if (url.pathname === '/upgrade') {
        return await this.handleUpgrade(request);
      }
      return jsonResponse({ error: 'NOT_FOUND' }, { status: 404 });
    } catch (err) {
      console.error('AdminPtyHubDurableObject fetch error:', err);
      return jsonResponse({ error: 'INTERNAL_ERROR', details: String(err) }, { status: 500 });
    }
  }

  private async handleFanout(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(request);
    } catch {
      return jsonResponse({ ok: false, error: 'INVALID_JSON' }, { status: 400 });
    }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const msgType = typeof body.type === 'string' ? body.type : 'pty_output';
    const payload = body.payload && typeof body.payload === 'object' ? (body.payload as Record<string, unknown>) : {};
    if (!sessionId) {
      return jsonResponse({ ok: false, error: 'SESSION_ID_REQUIRED' }, { status: 400 });
    }
    const tagged = (this.state.getWebSockets?.() ?? []).filter((ws) => {
      const att = (ws as any).deserializeAttachment?.();
      return att?.sessionId === sessionId;
    });
    console.log(
      `[PTY-TRACE] hub.fanout sessionId=${sessionId} type=${msgType} subscribers=${tagged.length}`,
    );
    const message = JSON.stringify({ type: msgType, payload });
    let delivered = 0;
    for (const ws of tagged) {
      if (safeWebSocketSend(ws, message)) delivered++;
    }
    return jsonResponse({ ok: true, delivered });
  }

  private async handleUpgrade(request: Request): Promise<Response> {
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
      return jsonResponse({ error: 'WEBSOCKET_UPGRADE_REQUIRED' }, { status: 426 });
    }
    const principalHeader = request.headers.get('x-admin-principal');
    if (!principalHeader) {
      return jsonResponse({ error: 'MISSING_PRINCIPAL' }, { status: 401 });
    }
    let principal: AdminPrincipal;
    try {
      principal = JSON.parse(principalHeader) as AdminPrincipal;
    } catch {
      return jsonResponse({ error: 'INVALID_PRINCIPAL' }, { status: 400 });
    }

    const WebSocketPairCtor = (globalThis as any).WebSocketPair;
    if (typeof WebSocketPairCtor !== 'function') {
      return jsonResponse({ error: 'WEBSOCKET_PAIR_UNAVAILABLE' }, { status: 501 });
    }
    const pair = new WebSocketPairCtor();
    const client = pair[0] as WebSocket;
    const server = pair[1] as WebSocket;
    if (typeof this.state.acceptWebSocket !== 'function') {
      return jsonResponse({ error: 'HIBERNATABLE_WS_UNAVAILABLE' }, { status: 501 });
    }
    this.state.acceptWebSocket(server, []);
    (server as any).serializeAttachment?.({
      principal,
      sessionId: null,
      writeTimestamps: [] as number[],
    });
    safeWebSocketSend(server, JSON.stringify({ type: 'pty_state', payload: { status: 'connected' } }));
    const wsHeaders = applySecurityHeaders(new Headers());
    return new Response(null, { status: 101, headers: wsHeaders, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      const db = requireD1(this.env);
      if (db instanceof Response) return;
      const att = (socket as any).deserializeAttachment?.() as
        | { principal: AdminPrincipal; sessionId: string | null; writeTimestamps: number[] }
        | undefined;
      if (!att) {
        safeWebSocketSend(socket, JSON.stringify({ type: 'pty_error', payload: { code: 'NOT_AUTHENTICATED', message: 'Missing socket attachment' } }));
        return;
      }
      await this.handleAdminMessage({ socket, attachment: att, text, db });
    } catch (err) {
      console.error('AdminPtyHubDurableObject webSocketMessage error:', err);
      safeWebSocketSend(socket, JSON.stringify({ type: 'pty_error', payload: { code: 'INTERNAL_ERROR', message: String(err) } }));
    }
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const att = (socket as any).deserializeAttachment?.() as { sessionId?: string | null } | undefined;
    if (att?.sessionId) {
      console.log(`[PTY-TRACE] hub.close sessionId=${att.sessionId}`);
    }
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    const att = (socket as any).deserializeAttachment?.() as { sessionId?: string | null } | undefined;
    console.warn(`[PTY-TRACE] hub.error sessionId=${att?.sessionId ?? 'null'} err=${String(error)}`);
  }

  private async handleAdminMessage(input: {
    socket: WebSocket;
    attachment: { principal: AdminPrincipal; sessionId: string | null; writeTimestamps: number[] };
    text: string;
    db: any;
  }): Promise<void> {
    let message: Record<string, any>;
    try {
      message = JSON.parse(input.text || '{}');
    } catch {
      safeWebSocketSend(input.socket, JSON.stringify({ type: 'pty_error', payload: { code: 'INVALID_JSON', message: 'Invalid PTY message JSON' } }));
      return;
    }
    if (message.payload && typeof message.payload === 'object') {
      message = { ...message.payload, ...message };
    }
    const principal = input.attachment.principal;
    const env = this.env;
    const db = input.db;
    const send = (type: string, payload: unknown) => {
      safeWebSocketSend(input.socket, JSON.stringify({ type, payload }));
    };

    if (message.type === 'pty_write' || message.type === 'pty_resize') {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
      if (!sessionId) return send('pty_error', { code: 'SESSION_ID_REQUIRED', message: 'sessionId is required' });
      const sessions = new D1PtySessionStore(db);
      const session = await sessions.get(sessionId);
      if (!session) return send('pty_error', { code: 'PTY_SESSION_NOT_FOUND', message: 'PTY session not found' });
      const actorType = adminActorType(principal);
      const actorId = adminActorId(principal);
      if (session.attachedActorType !== actorType || (session.attachedActorId ?? null) !== (actorId ?? null)) {
        return send('pty_error', { code: 'PTY_NOT_ATTACHED', message: 'PTY session is not attached to this admin client' });
      }
      if (!['opening', 'open'].includes(session.state)) {
        return send('pty_error', { code: 'PTY_SESSION_NOT_ACTIVE', message: 'PTY session is not active' });
      }
      const nowMsValue = nowMs(env);
      const now = new Date(nowMsValue).toISOString();
      if (message.type === 'pty_write') {
        const recent = input.attachment.writeTimestamps.filter((ts) => nowMsValue - ts < 1000);
        if (recent.length >= 20) {
          return send('pty_error', { code: 'PTY_WRITE_RATE_LIMITED', message: 'PTY write rate limit exceeded' });
        }
        const data = typeof message.data === 'string' ? message.data : '';
        if (!data) return send('pty_error', { code: 'PTY_WRITE_DATA_REQUIRED', message: 'data is required' });
        if (data.length > 8192) return send('pty_error', { code: 'PTY_WRITE_TOO_LARGE', message: 'PTY write payload is too large' });
        recent.push(nowMsValue);
        input.attachment.writeTimestamps = recent;
        (input.socket as any).serializeAttachment?.(input.attachment);
        const commands = new D1CommandStore(db);
        let command = await commands.createQueuedCommand({
          id: makeUuid(env), commandId: makeUuid(env), deviceId: session.deviceId,
          commandType: 'write_pty', actorType, actorId,
          payload: { sessionId, data },
          payloadSummary: `Write PTY ${sessionId}`, submittedAt: now,
        });
        command = await commands.markDispatched(command.commandId, await commands.nextReqSeq(session.deviceId), now);
        await notifyAgentDurableObject(env, session.deviceId, publicCommand(command), now);
        await new D1PtyAuditStore(db).append({
          id: makeUuid(env), sessionId, deviceId: session.deviceId, ts: now,
          eventType: 'pty_write', actorType, actorId,
          summary: 'Admin wrote to PTY session', details: { byteLength: data.length },
        });
        return send('pty_write_accepted', { sessionId, acceptedBytes: data.length });
      }

      const cols = Math.min(Math.max(Number(message.cols) || 80, 20), 300);
      const rows = Math.min(Math.max(Number(message.rows) || 24, 5), 120);
      const resized = await sessions.updateSize(sessionId, cols, rows);
      const commands = new D1CommandStore(db);
      let command = await commands.createQueuedCommand({
        id: makeUuid(env), commandId: makeUuid(env), deviceId: resized.deviceId,
        commandType: 'resize_pty', actorType, actorId,
        payload: { sessionId, cols, rows },
        payloadSummary: `Resize PTY ${sessionId}`, submittedAt: now,
      });
      command = await commands.markDispatched(command.commandId, await commands.nextReqSeq(resized.deviceId), now);
      await notifyAgentDurableObject(env, resized.deviceId, publicCommand(command), now);
      await new D1PtyAuditStore(db).append({
        id: makeUuid(env), sessionId, deviceId: resized.deviceId, ts: now,
        eventType: 'pty_resize', actorType, actorId,
        summary: 'Admin resized PTY session', details: { cols, rows },
      });
      return send('pty_resize_accepted', { sessionId, cols, rows });
    }

    if (message.type === 'pty_attach' || message.type === 'pty_detach') {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
      if (!sessionId) return send('pty_error', { code: 'SESSION_ID_REQUIRED', message: 'sessionId is required' });
      const sessions = new D1PtySessionStore(db);
      const existing = await sessions.get(sessionId);
      if (!existing) return send('pty_error', { code: 'PTY_SESSION_NOT_FOUND', message: 'PTY session not found' });
      const now = new Date(nowMs(env)).toISOString();
      const actorType = adminActorType(principal);
      const actorId = adminActorId(principal);
      if (message.type === 'pty_attach') {
        const attached = await sessions.attach(sessionId, actorType, actorId, now);
        input.attachment.sessionId = sessionId;
        (input.socket as any).serializeAttachment?.(input.attachment);
        console.log(`[PTY-TRACE] hub.pty_attach sessionId=${sessionId} deviceId=${attached.deviceId}`);
        await new D1PtyAuditStore(db).append({
          id: makeUuid(env), sessionId, deviceId: attached.deviceId, ts: now,
          eventType: 'pty_attached', actorType, actorId,
          summary: 'Admin attached PTY session', details: {},
        });
        send('pty_attached', { sessionId, deviceId: attached.deviceId });
        const scrollbackNow = new Date(nowMs(env)).toISOString();
        const commands = new D1CommandStore(db);
        let scrollCommand = await commands.createQueuedCommand({
          id: makeUuid(env), commandId: makeUuid(env), deviceId: attached.deviceId,
          commandType: 'request_pty_scrollback', actorType, actorId,
          payload: { sessionId },
          payloadSummary: `PTY scrollback ${sessionId}`, submittedAt: scrollbackNow,
        });
        const scrollReqSeq = await commands.nextReqSeq(attached.deviceId);
        scrollCommand = await commands.markDispatched(scrollCommand.commandId, scrollReqSeq, scrollbackNow);
        await notifyAgentDurableObject(env, attached.deviceId, publicCommand(scrollCommand), scrollbackNow);
        return;
      }
      const detached = await sessions.detach(sessionId, now);
      input.attachment.sessionId = null;
      (input.socket as any).serializeAttachment?.(input.attachment);
      await new D1PtyAuditStore(db).append({
        id: makeUuid(env), sessionId, deviceId: detached.deviceId, ts: now,
        eventType: 'pty_detached', actorType, actorId,
        summary: 'Admin detached PTY session', details: {},
      });
      return send('pty_detached', { sessionId, deviceId: detached.deviceId });
    }

    if (message.type === 'pty_close' || message.type === 'pty_delete') {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
      if (!sessionId) return send('pty_error', { code: 'SESSION_ID_REQUIRED', message: 'sessionId is required' });
      const sessions = new D1PtySessionStore(db);
      const existing = await sessions.get(sessionId);
      if (!existing) return send('pty_error', { code: 'PTY_SESSION_NOT_FOUND', message: 'PTY session not found' });
      const now = new Date(nowMs(env)).toISOString();
      const actorType = adminActorType(principal);
      const actorId = adminActorId(principal);

      if (message.type === 'pty_delete') {
        if (!['closed', 'expired', 'failed'].includes(existing.state)) {
          return send('pty_error', { code: 'PTY_SESSION_NOT_TERMINAL', message: 'Only terminal PTY sessions can be deleted' });
        }
        await sessions.deleteTerminalSession(sessionId, now);
        if (input.attachment.sessionId === sessionId) {
          input.attachment.sessionId = null;
          (input.socket as any).serializeAttachment?.(input.attachment);
        }
        await new D1PtyAuditStore(db).append({
          id: makeUuid(env), sessionId, deviceId: existing.deviceId, ts: now,
          eventType: 'pty_deleted', actorType, actorId,
          summary: 'Admin deleted PTY session record', details: {},
        });
        return send('pty_deleted', { sessionId, deviceId: existing.deviceId });
      }

      if (!['opening', 'open'].includes(existing.state)) {
        return send('pty_error', { code: 'PTY_SESSION_NOT_ACTIVE', message: 'Only active PTY sessions can be closed' });
      }
      const closing = await sessions.markClosing(sessionId, now);
      if (input.attachment.sessionId === sessionId) {
        input.attachment.sessionId = null;
        (input.socket as any).serializeAttachment?.(input.attachment);
      }
      const commands = new D1CommandStore(db);
      let command = await commands.createQueuedCommand({
        id: makeUuid(env), commandId: makeUuid(env), deviceId: closing.deviceId,
        commandType: 'close_pty', actorType, actorId,
        payload: { sessionId },
        payloadSummary: `Close PTY ${sessionId}`, submittedAt: now,
      });
      const reqSeq = await commands.nextReqSeq(closing.deviceId);
      command = await commands.markDispatched(command.commandId, reqSeq, now);
      await notifyAgentDurableObject(env, closing.deviceId, publicCommand(command), now);
      await new D1PtyAuditStore(db).append({
        id: makeUuid(env), sessionId, deviceId: closing.deviceId, ts: now,
        eventType: 'pty_close_requested', actorType, actorId,
        summary: 'Admin requested PTY close', details: {},
      });
      return send('pty_close_requested', { sessionId, deviceId: closing.deviceId });
    }

    if (message.type !== 'pty_open') {
      return send('pty_error', { code: 'NOT_IMPLEMENTED', message: 'Admin PTY workflow message is not implemented yet in Worker mode.' });
    }

    const deviceId = typeof message.deviceId === 'string' ? message.deviceId.trim() : '';
    if (!deviceId) return send('pty_error', { code: 'DEVICE_ID_REQUIRED', message: 'deviceId is required' });
    const device = await new D1DeviceStore(db).getDevice(deviceId);
    if (!device) return send('pty_error', { code: 'DEVICE_NOT_FOUND', message: 'Device not found' });

    const sessionId = typeof message.sessionId === 'string' && message.sessionId.trim() ? message.sessionId.trim() : makeUuid(env);
    const cols = Math.min(Math.max(Number(message.cols) || 80, 20), 300);
    const rows = Math.min(Math.max(Number(message.rows) || 24, 5), 120);
    const now = new Date(nowMs(env)).toISOString();
    const actorType = adminActorType(principal);
    const actorId = adminActorId(principal);

    await new D1PtySessionStore(db).createOpening({
      id: makeUuid(env), sessionId, deviceId,
      cols, rows, openedAt: now,
      openedByActorType: actorType, openedByActorId: actorId,
      attachedActorType: actorType, attachedActorId: actorId,
    });
    await new D1PtyAuditStore(db).append({
      id: makeUuid(env), sessionId, deviceId, ts: now,
      eventType: 'pty_open_requested', actorType, actorId,
      summary: 'Admin requested PTY open', details: { cols, rows },
    });

    const commands = new D1CommandStore(db);
    let command = await commands.createQueuedCommand({
      id: makeUuid(env), commandId: sessionId, deviceId,
      commandType: 'open_pty', actorType, actorId,
      payload: { sessionId, cols, rows },
      payloadSummary: `Open PTY ${sessionId}`, submittedAt: now,
    });
    const reqSeq = await commands.nextReqSeq(deviceId);
    command = await commands.markDispatched(sessionId, reqSeq, now);
    await commands.appendAudit({
      id: makeUuid(env), commandId: sessionId, ts: now, eventType: 'dispatched',
      actorType, actorId, source: 'worker',
      summary: `Dispatched open_pty to ${deviceId}`,
      details: { reqSeq, sessionId, cols, rows },
    });
    await notifyAgentDurableObject(env, deviceId, publicCommand(command), now);
    send('pty_opening', { sessionId, deviceId, cols, rows });
  }
}
