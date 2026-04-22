import { randomUUID } from 'node:crypto';

export type AgentMessageSender = (client: any, message: any) => { seq: number; ts: string };

type RequestDeps = {
  deviceStore: { getSessionByDeviceId: (deviceId: string) => { ws?: any } | null | undefined };
  sendMessage: AgentMessageSender;
};

type PtyDeps = RequestDeps & {
  ptySessionStore: {
    createOpening: (input: {
      id: string;
      sessionId: string;
      deviceId: string;
      cols?: number;
      rows?: number;
      openedAt: string;
      recordingEnabled?: boolean;
      openedByActorType?: string | null;
      openedByActorId?: string | null;
      attachedActorType?: string | null;
      attachedActorId?: string | null;
    }) => unknown;
    trackPendingReq: (deviceId: string, reqSeq: number, sessionId: string, type: 'open' | 'close') => void;
    markClosing: (sessionId: string, ts: string) => void;
  };
};

export function requestStatusSnapshot(deps: RequestDeps, deviceId: string, commandId?: string) {
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }

  const envelope = deps.sendMessage(session.ws, {
    type: 'request_status_snapshot',
    commandId,
    payload: null,
  });

  return { ok: true, deviceId, reqSeq: envelope.seq, requestedAt: envelope.ts };
}

export function requestInventory(deps: RequestDeps, deviceId: string, commandId?: string) {
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }

  const envelope = deps.sendMessage(session.ws, {
    type: 'request_inventory',
    commandId,
    payload: null,
  });

  return { ok: true, deviceId, reqSeq: envelope.seq, requestedAt: envelope.ts };
}

export function requestRecentLogs(deps: RequestDeps, deviceId: string, commandId?: string) {
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }

  const envelope = deps.sendMessage(session.ws, {
    type: 'request_recent_logs',
    commandId,
    payload: null,
  });

  return { ok: true, deviceId, reqSeq: envelope.seq, requestedAt: envelope.ts };
}

export function requestRestartOpenvpn(deps: RequestDeps, deviceId: string, commandId?: string) {
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }

  const envelope = deps.sendMessage(session.ws, {
    type: 'request_restart_openvpn',
    commandId,
    payload: null,
  });

  return { ok: true, deviceId, reqSeq: envelope.seq, requestedAt: envelope.ts };
}

export function requestRestartBoundaryAuth(deps: RequestDeps, deviceId: string, commandId?: string) {
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }

  const envelope = deps.sendMessage(session.ws, {
    type: 'request_restart_boundary_auth',
    commandId,
    payload: null,
  });

  return { ok: true, deviceId, reqSeq: envelope.seq, requestedAt: envelope.ts };
}

export function requestRestartServerTunnel(deps: RequestDeps, deviceId: string, serverId: string, commandId?: string) {
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }

  const normalizedServerId = String(serverId || '').trim();
  if (!normalizedServerId) {
    return { ok: false, reason: 'SERVER_ID_REQUIRED' };
  }

  const envelope = deps.sendMessage(session.ws, {
    type: 'request_restart_server_tunnel',
    commandId,
    payload: { serverId: normalizedServerId },
  });

  return { ok: true, deviceId, serverId: normalizedServerId, reqSeq: envelope.seq, requestedAt: envelope.ts };
}

export function requestRestartServerSsh(deps: RequestDeps, deviceId: string, serverId: string, commandId?: string) {
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }

  const normalizedServerId = String(serverId || '').trim();
  if (!normalizedServerId) {
    return { ok: false, reason: 'SERVER_ID_REQUIRED' };
  }

  const envelope = deps.sendMessage(session.ws, {
    type: 'request_restart_server_ssh',
    commandId,
    payload: { serverId: normalizedServerId },
  });

  return { ok: true, deviceId, serverId: normalizedServerId, reqSeq: envelope.seq, requestedAt: envelope.ts };
}

export function dispatchFileOpCommand(
  deps: RequestDeps,
  deviceId: string,
  type: string,
  payload: Record<string, unknown>,
  commandId?: string,
) {
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }

  const envelope = deps.sendMessage(session.ws, {
    type,
    commandId,
    payload,
  });

  return { ok: true, deviceId, reqSeq: envelope.seq, requestedAt: envelope.ts };
}

export function openPty(
  deps: PtyDeps,
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
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }

  const normalizedSessionId = String(input.sessionId || '').trim();
  if (!normalizedSessionId) {
    return { ok: false, reason: 'SESSION_ID_REQUIRED' };
  }

  deps.ptySessionStore.createOpening({
    id: randomUUID(),
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

  const envelope = deps.sendMessage(session.ws, {
    type: 'open_pty',
    commandId,
    payload: {
      sessionId: normalizedSessionId,
      cols: input.cols,
      rows: input.rows,
      recording: Boolean(input.recording),
    },
  });
  deps.ptySessionStore.trackPendingReq(deviceId, envelope.seq, normalizedSessionId, 'open');

  return { ok: true, deviceId, sessionId: normalizedSessionId, reqSeq: envelope.seq, requestedAt: envelope.ts };
}

export function writePty(deps: RequestDeps, deviceId: string, input: { sessionId: string; data: string }, commandId?: string) {
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }
  const normalizedSessionId = String(input.sessionId || '').trim();
  if (!normalizedSessionId) {
    return { ok: false, reason: 'SESSION_ID_REQUIRED' };
  }
  const envelope = deps.sendMessage(session.ws, {
    type: 'write_pty',
    commandId,
    payload: {
      sessionId: normalizedSessionId,
      data: String(input.data ?? ''),
    },
  });
  return { ok: true, deviceId, sessionId: normalizedSessionId, reqSeq: envelope.seq, requestedAt: envelope.ts };
}

export function resizePty(
  deps: RequestDeps,
  deviceId: string,
  input: { sessionId: string; cols: number; rows: number },
  commandId?: string,
) {
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }
  const normalizedSessionId = String(input.sessionId || '').trim();
  if (!normalizedSessionId) {
    return { ok: false, reason: 'SESSION_ID_REQUIRED' };
  }
  const envelope = deps.sendMessage(session.ws, {
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

export function closePty(deps: PtyDeps, deviceId: string, input: { sessionId: string }, commandId?: string) {
  const session = deps.deviceStore.getSessionByDeviceId(deviceId);
  if (!session?.ws) {
    return { ok: false, reason: 'DEVICE_NOT_CONNECTED' };
  }
  const normalizedSessionId = String(input.sessionId || '').trim();
  if (!normalizedSessionId) {
    return { ok: false, reason: 'SESSION_ID_REQUIRED' };
  }
  deps.ptySessionStore.markClosing(normalizedSessionId, new Date().toISOString());

  const envelope = deps.sendMessage(session.ws, {
    type: 'close_pty',
    commandId,
    payload: { sessionId: normalizedSessionId },
  });
  deps.ptySessionStore.trackPendingReq(deviceId, envelope.seq, normalizedSessionId, 'close');
  return { ok: true, deviceId, sessionId: normalizedSessionId, reqSeq: envelope.seq, requestedAt: envelope.ts };
}
