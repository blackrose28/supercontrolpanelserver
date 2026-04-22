import { HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AdminAuthPrincipal } from '../admin/admin-auth';
import { AgentGateway } from '../agent/agent.gateway';
import { FileOpAdmissionService } from '../file-ops/file-op-admission.service';
import { RemoteBrowserSessionStore } from '../file-ops/remote-browser-session.store';
import { mapPrincipalToActor } from './command-dispatch.actor';
import {
  readBooleanField,
  readOptionalStringField,
  readRequiredServerId,
  readRequiredStringField,
} from './command-dispatch.parsers';
import {
  enforceAdmission,
  ensureActorOwnsFileOpResource,
} from './command-dispatch.policies';
import { DispatchSafeInput } from './command-dispatch.types';

export type DispatchRemoteBrowserDeps = {
  fileOpAdmission: FileOpAdmissionService;
  remoteBrowserSessionStore: RemoteBrowserSessionStore;
  agentGateway: AgentGateway;
  dispatchSafeCommand: (input: DispatchSafeInput) => Record<string, unknown>;
  nowIso: () => string;
};

export function dispatchRemoteBrowserCommand(input: {
  deviceId: string;
  commandType: string;
  requestedCommandId?: string;
  payload: unknown;
  principal: AdminAuthPrincipal;
}, deps: DispatchRemoteBrowserDeps) {
  const { deviceId, commandType, requestedCommandId, payload, principal } = input;

  if (commandType === 'open_remote_browser') {
    enforceAdmission(deps.fileOpAdmission.checkRemoteBrowserCapacity(deviceId), commandType);
    const serverId = readRequiredServerId(payload);
    const browserSessionId = readOptionalStringField(payload, 'browserSessionId') || randomUUID();
    const actor = mapPrincipalToActor(principal);
    const existingSession = deps.remoteBrowserSessionStore.get(browserSessionId);

    if (existingSession) {
      ensureActorOwnsFileOpResource(
        {
          actorType: existingSession.actorType,
          actorId: existingSession.actorId,
        },
        actor.actorType,
        actor.actorId,
        'BROWSER_SESSION_UNAUTHORIZED',
        'Remote browser session is owned by another operator',
      );
      throw new HttpException(
        {
          ok: false,
          code: 'BROWSER_SESSION_ID_CONFLICT',
          message: 'browserSessionId already exists',
        },
        HttpStatus.CONFLICT,
      );
    }

    deps.remoteBrowserSessionStore.createOpening({
      id: randomUUID(),
      browserSessionId,
      deviceId,
      serverId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      openedAt: deps.nowIso(),
    });

    return deps.dispatchSafeCommand({
      deviceId,
      commandType,
      requestedCommandId,
      payload: { serverId, browserSessionId },
      payloadSummary: `Open remote browser for ${serverId}`,
      principal,
      dispatch: (commandId) => deps.agentGateway.dispatchFileOpCommand(deviceId, 'open_remote_browser', { serverId, browserSessionId }, commandId),
    });
  }

  const browserSessionId = readRequiredStringField(payload, 'browserSessionId');
  const session = deps.remoteBrowserSessionStore.get(browserSessionId);
  if (!session || session.deviceId !== deviceId) {
    throw new HttpException({ ok: false, code: 'BROWSER_SESSION_NOT_FOUND', message: 'Remote browser session not found' }, HttpStatus.NOT_FOUND);
  }

  const actor = mapPrincipalToActor(principal);
  ensureActorOwnsFileOpResource(
    {
      actorType: session.actorType,
      actorId: session.actorId,
    },
    actor.actorType,
    actor.actorId,
    'BROWSER_SESSION_UNAUTHORIZED',
    'Remote browser session is owned by another operator',
  );

  const nextPayload: Record<string, unknown> = { browserSessionId };
  const path = readOptionalStringField(payload, 'path');
  if (path) {
    nextPayload.path = path;
  }
  if (commandType === 'delete_remote_browser_path') {
    nextPayload.recursive = readBooleanField(payload, 'recursive', false);
  }
  if (path) {
    deps.remoteBrowserSessionStore.noteActivity(browserSessionId, deps.nowIso(), path);
  }
  if (commandType === 'close_remote_browser') {
    deps.remoteBrowserSessionStore.noteActivity(browserSessionId, deps.nowIso(), null);
  }

  return deps.dispatchSafeCommand({
    deviceId,
    commandType,
    requestedCommandId,
    payload: nextPayload,
    payloadSummary: `${commandType} for browser ${browserSessionId}`,
    principal,
    dispatch: (commandId) => deps.agentGateway.dispatchFileOpCommand(deviceId, commandType, nextPayload, commandId),
  });
}
