import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AdminAuthPrincipal } from '../admin/admin-auth';
import { AdminSessionService } from '../admin/admin-session.service';
import { AdminApiTokenService } from '../admin/admin-api-token.service';
import { DeviceStore } from '../devices/device.store';
import { AgentGateway } from '../agent/agent.gateway';
import {
  auditRejectedAction,
  errorMessage,
  PtyGatewayError,
  shouldAuditReject,
} from './pty-gateway.errors';
import {
  authenticatePtyPrincipal,
  mapPrincipalToPtyActor,
} from './pty-auth.service';
import {
  PtyHandlerDeps,
  handleAttachAction,
  handleCloseAction,
  handleDetachAction,
  handleOpenAction,
  handleRecordingConsentAction,
  handleResizeAction,
  handleWriteAction,
} from './pty-message.handlers';
import { PtyMessageRouteResult, routePtyMessage } from './pty-message.router';
import { PtySessionRecord, PtySessionStore } from './pty-session.store';
import { PtyHubService } from './pty-hub.service';
import { isSameActor } from './pty-policy.service';
import { PtyAuditStore } from './pty-audit.store';
import { RateLimitBucket } from './pty-rate-limit';

@WebSocketGateway({ path: '/admin/ws/pty' })
export class PtyGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly writeRateLimits = new Map<string, RateLimitBucket>();
  private readonly resizeRateLimits = new Map<string, RateLimitBucket>();

  constructor(
    private readonly adminSessions: AdminSessionService,
    private readonly adminApiTokens: AdminApiTokenService,
    private readonly deviceStore: DeviceStore,
    private readonly agentGateway: AgentGateway,
    private readonly ptySessions: PtySessionStore,
    private readonly ptyHub: PtyHubService,
    private readonly ptyAudit: PtyAuditStore,
  ) {}

  handleConnection(client: any, request: any) {
    try {
      client.principal = authenticatePtyPrincipal(
        request?.headers?.authorization,
        request?.headers?.cookie,
        this.adminSessions,
        this.adminApiTokens,
      );
    } catch (error) {
      client.close(1008, error instanceof Error ? error.message : 'AUTH_FAILED');
      return;
    }

    this.ptyHub.registerClient(client);
    client.on('message', (raw: Buffer | string) => {
      const data = typeof raw === 'string' ? raw : raw.toString('utf8');
      this.handleRawMessage(data, client);
    });

    this.ptyHub.send(client, {
      type: 'pty_state',
      payload: { state: 'connected' },
    });
  }

  handleDisconnect(client: any) {
    const principal = client?.principal;
    if (!principal) {
      this.ptyHub.unregisterClient(client);
      return;
    }
    const actor = mapPrincipalToPtyActor(principal);
    for (const sessionId of this.ptyHub.sessionsForClient(client)) {
      const record = this.ptySessions.get(sessionId);
      if (record && isSameActor(record, actor.actorType, actor.actorId)) {
        const detached = this.ptySessions.detach(sessionId, new Date().toISOString());
        this.appendAudit(detached, 'pty_detached', actor, 'PTY session detached because browser websocket disconnected');
      }
    }
    this.ptyHub.unregisterClient(client);
  }

  publishPtyOutput(sessionId: string, payload: Record<string, unknown>) {
    this.ptyHub.broadcast(sessionId, {
      type: 'pty_output',
      payload,
    });
  }

  publishPtyExit(sessionId: string, payload: Record<string, unknown>) {
    this.ptyHub.broadcast(sessionId, {
      type: 'pty_exit',
      payload,
    });
  }

  private appendAudit(
    record: Pick<PtySessionRecord, 'sessionId' | 'deviceId'>,
    eventType: string,
    actor: { actorType: string; actorId: string | null },
    summary: string,
    details?: Record<string, unknown>,
  ) {
    this.ptyAudit.append({
      id: randomUUID(),
      sessionId: record.sessionId,
      deviceId: record.deviceId,
      ts: new Date().toISOString(),
      eventType,
      actorType: actor.actorType as any,
      actorId: actor.actorId,
      summary,
      details,
    });
  }

  private auditExpiredSessions(records: PtySessionRecord[]) {
    for (const record of records) {
      this.ptyAudit.append({
        id: randomUUID(),
        sessionId: record.sessionId,
        deviceId: record.deviceId,
        ts: record.expiredAt || new Date().toISOString(),
        eventType: 'pty_expired',
        actorType: 'system',
        actorId: null,
        summary: 'PTY session expired after detach grace window elapsed',
        details: { reasonCode: record.failureCode, reasonDetail: record.failureDetail },
      });
    }
  }

  private handleRawMessage(data: string, client: any) {
    let routeResult: PtyMessageRouteResult = { msgType: '', payload: {}, handled: false };

    try {
      routeResult = routePtyMessage({
        data,
        onInvalidJson: () => {
          this.ptyHub.send(client, errorMessage('pty_error', 'INVALID_JSON', 'Invalid PTY websocket JSON message'));
        },
        onUnsupported: (msgType) => {
          this.ptyHub.send(client, errorMessage('pty_error', 'UNSUPPORTED_MESSAGE_TYPE', `Unsupported PTY message type: ${msgType || 'unknown'}`));
        },
        onOpen: (payload) => this.handleOpen(client, payload),
        onAttach: (payload) => this.handleAttach(client, payload),
        onDetach: (payload) => this.handleDetach(client, payload),
        onRecordingConsent: (payload) => this.handleRecordingConsent(client, payload),
        onWrite: (payload) => this.handleWrite(client, payload),
        onResize: (payload) => this.handleResize(client, payload),
        onClose: (payload) => this.handleClose(client, payload),
      });
    } catch (error) {
      const { msgType, payload } = routeResult;
      if (error instanceof UnauthorizedException || error instanceof ForbiddenException) {
        auditRejectedAction(
          this.ptyAudit,
          this.ptySessions,
          msgType,
          payload,
          mapPrincipalToPtyActor(client.principal),
          'PTY_UNAUTHORIZED',
          'PTY access denied',
        );
        this.ptyHub.send(client, errorMessage('pty_error', 'PTY_UNAUTHORIZED', 'PTY access denied'));
        return;
      }
      if (error instanceof PtyGatewayError) {
        if (shouldAuditReject(msgType)) {
          auditRejectedAction(
            this.ptyAudit,
            this.ptySessions,
            msgType,
            payload,
            mapPrincipalToPtyActor(client.principal),
            error.code,
            error.message,
            error.details,
          );
        }
        this.ptyHub.send(client, errorMessage('pty_error', error.code, error.message, error.details));
        return;
      }
      this.ptyHub.send(client, errorMessage('pty_error', 'PTY_INTERNAL_ERROR', error instanceof Error ? error.message : 'PTY websocket action failed'));
    }
  }

  private getHandlerDeps(): PtyHandlerDeps {
    return {
      deviceStore: this.deviceStore,
      agentGateway: this.agentGateway,
      ptySessions: this.ptySessions,
      ptyHub: this.ptyHub,
      ptyAudit: this.ptyAudit,
      writeRateLimits: this.writeRateLimits,
      resizeRateLimits: this.resizeRateLimits,
      appendAudit: this.appendAudit.bind(this),
      auditExpiredSessions: this.auditExpiredSessions.bind(this),
    };
  }

  private handleOpen(client: any, payload: Record<string, unknown>) {
    handleOpenAction(client, payload, this.getHandlerDeps());
  }

  private handleAttach(client: any, payload: Record<string, unknown>) {
    handleAttachAction(client, payload, this.getHandlerDeps());
  }

  private handleDetach(client: any, payload: Record<string, unknown>) {
    handleDetachAction(client, payload, this.getHandlerDeps());
  }

  private handleRecordingConsent(client: any, payload: Record<string, unknown>) {
    handleRecordingConsentAction(client, payload, this.getHandlerDeps());
  }

  private handleWrite(client: any, payload: Record<string, unknown>) {
    handleWriteAction(client, payload, this.getHandlerDeps());
  }

  private handleResize(client: any, payload: Record<string, unknown>) {
    handleResizeAction(client, payload, this.getHandlerDeps());
  }

  private handleClose(client: any, payload: Record<string, unknown>) {
    handleCloseAction(client, payload, this.getHandlerDeps());
  }
}


