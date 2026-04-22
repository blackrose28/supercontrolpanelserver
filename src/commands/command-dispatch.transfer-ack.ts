import { randomUUID } from 'node:crypto';
import { AgentGateway } from '../agent/agent.gateway';
import { FileTransferStore } from '../file-ops/file-transfer.store';
import { PtySessionStore } from '../pty/pty-session.store';
import { CommandActorType } from './command.store';
import { readOptionalStringField } from './command-dispatch.parsers';

export function trackTransferSessionFromAck(input: {
  deviceId: string;
  commandType: string;
  payload: unknown;
  actorType: CommandActorType;
  actorId: string | null;
  reqSeq: number;
  requestedAt: string;
}, deps: {
  agentGateway: AgentGateway;
  fileTransferStore: FileTransferStore;
  ptySessionStore: PtySessionStore;
}) {
  const { deviceId, commandType, payload, actorType, actorId, reqSeq, requestedAt } = input;
  if (commandType !== 'start_scp_upload' && commandType !== 'start_scp_download') {
    return;
  }

  const transferId = readOptionalStringField(payload, 'transferId');
  if (!transferId) {
    return;
  }

  void deps.agentGateway.awaitReqResponse(deviceId, reqSeq, 30_000)
    .then((ack) => {
      const ackPayload = ack && typeof ack.payload === 'object' && ack.payload ? ack.payload as Record<string, unknown> : null;
      const sessionId = ackPayload && typeof ackPayload.sessionId === 'string' ? ackPayload.sessionId.trim() : '';
      if (!sessionId) {
        return;
      }

      const transfer = deps.fileTransferStore.get(transferId);
      if (!transfer || transfer.deviceId !== deviceId) {
        return;
      }

      deps.fileTransferStore.attachSession(transferId, sessionId, ack.ts || requestedAt);
      deps.ptySessionStore.createOpening({
        id: randomUUID(),
        sessionId,
        deviceId,
        openedAt: ack.ts || requestedAt,
        recordingEnabled: false,
        openedByActorType: actorType,
        openedByActorId: actorId,
        attachedActorType: null,
        attachedActorId: null,
      });
      deps.ptySessionStore.markOpen(sessionId, ack.ts || requestedAt);
    })
    .catch((error) => {
      console.warn('Failed to capture transfer session ack', { deviceId, transferId, commandType, error });
    });
}
