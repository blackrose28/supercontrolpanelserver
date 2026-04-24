import { randomUUID } from 'node:crypto';
import { FileTransferState } from '../file-ops/file-transfer.types';
import { CommandRecord } from '../commands/command.store';

type PendingReqResponses = Map<
  number,
  {
    deviceId: string;
    resolve: (value: { ok: true; payload: unknown; ts: string }) => void;
    reject: (reason?: unknown) => void;
    timer: NodeJS.Timeout;
  }
>;

type PendingPtyReq = { sessionId: string; type: 'open' | 'close' } | null;

type CommandStoreNackDeps = {
  findByReqSeq: (deviceId: string, reqSeq: number) => any;
  markFailed: (commandId: string, reasonCode: string, reasonDetail: string | null, ts: string) => unknown;
  appendAuditIfMissing: (entry: any) => void;
};

type PtySessionStoreNackDeps = {
  consumePendingReq: (deviceId: string, reqSeq: number) => PendingPtyReq;
  markOpenFailed: (sessionId: string, reasonCode: string, reasonDetail: string | null, ts: string) => unknown;
};

function parseNackReason(envelope: any) {
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
  const reasonCode =
    typeof payload.error === 'string' && payload.error.trim().length
      ? payload.error.trim()
      : 'AGENT_NACK';
  return { payload, reasonCode };
}

export function handleAgentNack(input: {
  envelope: any;
  client: any;
  pendingReqResponses: PendingReqResponses;
  commandStore: CommandStoreNackDeps;
  ptySessionStore: PtySessionStoreNackDeps;
}) {
  const { envelope, client, pendingReqResponses, commandStore, ptySessionStore } = input;
  const reqSeq = typeof envelope.reqSeq === 'number' ? envelope.reqSeq : null;
  if (reqSeq == null) {
    return;
  }

  const pendingResponse = pendingReqResponses.get(reqSeq);
  if (pendingResponse && pendingResponse.deviceId === client.deviceId) {
    clearTimeout(pendingResponse.timer);
    pendingReqResponses.delete(reqSeq);
    pendingResponse.reject({
      code:
        envelope.payload && typeof envelope.payload === 'object' && typeof envelope.payload.error === 'string'
          ? envelope.payload.error
          : 'AGENT_NACK',
      payload: envelope.payload ?? null,
      ts: envelope.ts || new Date().toISOString(),
    });
  }

  const command = commandStore.findByReqSeq(client.deviceId, reqSeq);
  const pendingPty = ptySessionStore.consumePendingReq(client.deviceId, reqSeq);
  if (!command) {
    if (!pendingPty) {
      return;
    }
  }

  const { reasonCode } = parseNackReason(envelope);
  const finishedAt = envelope.ts || new Date().toISOString();

  if (pendingPty) {
    if (pendingPty.type === 'open') {
      ptySessionStore.markOpenFailed(pendingPty.sessionId, reasonCode, reasonCode, finishedAt);
    }
    return;
  }

  commandStore.markFailed(command.commandId, reasonCode, reasonCode, finishedAt);
  commandStore.appendAuditIfMissing({
    id: randomUUID(),
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

export function handleAgentAck(input: {
  envelope: any;
  client: any;
  pendingReqResponses: PendingReqResponses;
  commandStore: {
    findByReqSeq: (deviceId: string, reqSeq: number) => any;
  };
  ptySessionStore: {
    consumePendingReq: (deviceId: string, reqSeq: number) => { sessionId: string; type: 'open' | 'close' } | null;
    markOpen: (sessionId: string, ts: string) => any;
    markClosing: (sessionId: string, ts: string) => any;
  };
  ptyAudit: {
    append: (entry: any) => void;
  };
}) {
  const { envelope, client, pendingReqResponses, commandStore, ptySessionStore, ptyAudit } = input;
  const reqSeq = typeof envelope.reqSeq === 'number' ? envelope.reqSeq : null;
  if (reqSeq == null) {
    return;
  }

  const pendingResponse = pendingReqResponses.get(reqSeq);
  if (pendingResponse && pendingResponse.deviceId === client.deviceId) {
    clearTimeout(pendingResponse.timer);
    pendingReqResponses.delete(reqSeq);
    pendingResponse.resolve({
      ok: true,
      payload: envelope.payload ?? null,
      ts: envelope.ts || new Date().toISOString(),
    });
  }

  const command = commandStore.findByReqSeq(client.deviceId, reqSeq);
  const pendingPty = ptySessionStore.consumePendingReq(client.deviceId, reqSeq);
  if (pendingPty) {
    const ts = envelope.ts || new Date().toISOString();
    if (pendingPty.type === 'open') {
      const opened = ptySessionStore.markOpen(pendingPty.sessionId, ts);
      ptyAudit.append({
        id: randomUUID(),
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
      ptySessionStore.markClosing(pendingPty.sessionId, ts);
    }
  }
  if (!command) {
    return;
  }
}

type TransferStoreDeps = {
  get: (transferId: string) => any;
  updateProgress: (
    transferId: string,
    ts: string,
    fields: {
      bytesTransferred: number;
      attempt?: number;
      maxAttempts?: number;
      resumeSupported?: boolean;
      retryScheduled?: boolean;
      resumeToken?: string | null;
      resumeOffsetBytes?: number | null;
      tempPathHint?: string | null;
      bytesTotal?: number | null;
      percent?: number | null;
      throughputBps?: number | null;
      etaSec?: number | null;
      phase?: string;
      message?: string;
    },
  ) => void;
  markState: (
    transferId: string,
    state: FileTransferState,
    ts: string,
    patch: {
      phase?: string;
      reasonCode?: string;
      reasonDetail?: string;
      message?: string;
      attempt?: number;
      maxAttempts?: number;
      resumeSupported?: boolean;
      retryScheduled?: boolean;
      resumeToken?: string | null;
      resumeOffsetBytes?: number | null;
      tempPathHint?: string | null;
    },
  ) => void;
};

export function handleAgentTransferProgress(input: {
  envelope: any;
  client: any;
  fileTransferStore: TransferStoreDeps;
  sendMessage: (client: any, message: any) => unknown;
}) {
  const { envelope, client, fileTransferStore, sendMessage } = input;
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
  const transferId = typeof payload.transferId === 'string' ? payload.transferId.trim() : '';
  if (!transferId) {
    return;
  }

  const existing = fileTransferStore.get(transferId);
  if (!existing || existing.deviceId !== client.deviceId) {
    return;
  }

  if (existing.state === 'canceled' && existing.reasonCode === 'transfer_stop_requested') {
    sendMessage(client, {
      type: 'ack',
      reqSeq: envelope.seq,
      payload: { status: 'ok' },
    });
    return;
  }

  fileTransferStore.updateProgress(
    transferId,
    envelope.ts || new Date().toISOString(),
    {
      attempt:
        typeof payload.attempt === 'number' && Number.isFinite(payload.attempt)
          ? payload.attempt
          : existing.attempt,
      maxAttempts:
        typeof payload.maxAttempts === 'number' && Number.isFinite(payload.maxAttempts)
          ? payload.maxAttempts
          : existing.maxAttempts,
      resumeSupported:
        typeof payload.resumeSupported === 'boolean'
          ? payload.resumeSupported
          : existing.resumeSupported,
      retryScheduled:
        typeof payload.retryScheduled === 'boolean'
          ? payload.retryScheduled
          : existing.retryScheduled,
      resumeToken:
        typeof payload.resumeToken === 'string'
          ? payload.resumeToken
          : payload.resumeToken === null
            ? null
            : existing.resumeToken,
      resumeOffsetBytes:
        typeof payload.resumeOffsetBytes === 'number' && Number.isFinite(payload.resumeOffsetBytes)
          ? payload.resumeOffsetBytes
          : payload.resumeOffsetBytes === null
            ? null
            : existing.resumeOffsetBytes,
      tempPathHint:
        typeof payload.tempPathHint === 'string'
          ? payload.tempPathHint
          : payload.tempPathHint === null
            ? null
            : existing.tempPathHint,
      bytesTransferred:
        typeof payload.bytesTransferred === 'number' && Number.isFinite(payload.bytesTransferred)
          ? payload.bytesTransferred
          : existing.bytesTransferred,
      bytesTotal:
        typeof payload.bytesTotal === 'number' && Number.isFinite(payload.bytesTotal)
          ? payload.bytesTotal
          : payload.bytesTotal === null
            ? null
            : existing.bytesTotal,
      percent:
        typeof payload.percent === 'number' && Number.isFinite(payload.percent)
          ? payload.percent
          : payload.percent === null
            ? null
            : existing.percent,
      throughputBps:
        typeof payload.throughputBps === 'number' && Number.isFinite(payload.throughputBps)
          ? payload.throughputBps
          : payload.throughputBps === null
            ? null
            : existing.throughputBps,
      etaSec:
        typeof payload.etaSec === 'number' && Number.isFinite(payload.etaSec)
          ? payload.etaSec
          : payload.etaSec === null
            ? null
            : existing.etaSec,
      phase: typeof payload.phase === 'string' ? payload.phase : existing.phase,
      message: typeof payload.message === 'string' ? payload.message : existing.message,
    },
  );

  sendMessage(client, {
    type: 'ack',
    reqSeq: envelope.seq,
    payload: { status: 'ok' },
  });
}

export function handleAgentTransferStatus(input: {
  envelope: any;
  client: any;
  fileTransferStore: TransferStoreDeps;
  sendMessage: (client: any, message: any) => unknown;
}) {
  const { envelope, client, fileTransferStore, sendMessage } = input;
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
  const transferId = typeof payload.transferId === 'string' ? payload.transferId.trim() : '';
  if (!transferId) {
    return;
  }

  const existing = fileTransferStore.get(transferId);
  if (!existing || existing.deviceId !== client.deviceId) {
    return;
  }

  const state = typeof payload.state === 'string' && payload.state.trim().length ? payload.state.trim() : existing.state;
  if (state === 'queued' || state === 'starting' || state === 'running' || state === 'succeeded' || state === 'failed' || state === 'canceled') {
    const nextState = existing.state === 'canceled' && existing.reasonCode === 'transfer_stop_requested' && state === 'failed' ? 'canceled' : state;
    fileTransferStore.markState(transferId, nextState, envelope.ts || new Date().toISOString(), {
      phase: typeof payload.phase === 'string' ? payload.phase : existing.phase,
      reasonCode: typeof payload.reasonCode === 'string' ? payload.reasonCode : existing.reasonCode,
      reasonDetail: typeof payload.reasonDetail === 'string' ? payload.reasonDetail : existing.reasonDetail,
      message: typeof payload.message === 'string' ? payload.message : existing.message,
      attempt: typeof payload.attempt === 'number' && Number.isFinite(payload.attempt) ? payload.attempt : existing.attempt,
      maxAttempts: typeof payload.maxAttempts === 'number' && Number.isFinite(payload.maxAttempts) ? payload.maxAttempts : existing.maxAttempts,
      resumeSupported: typeof payload.resumeSupported === 'boolean' ? payload.resumeSupported : existing.resumeSupported,
      retryScheduled: typeof payload.retryScheduled === 'boolean' ? payload.retryScheduled : existing.retryScheduled,
      resumeToken: typeof payload.resumeToken === 'string' ? payload.resumeToken : payload.resumeToken === null ? null : existing.resumeToken,
      resumeOffsetBytes: typeof payload.resumeOffsetBytes === 'number' && Number.isFinite(payload.resumeOffsetBytes)
        ? payload.resumeOffsetBytes
        : payload.resumeOffsetBytes === null
          ? null
          : existing.resumeOffsetBytes,
      tempPathHint: typeof payload.tempPathHint === 'string' ? payload.tempPathHint : payload.tempPathHint === null ? null : existing.tempPathHint,
    });
  }

  sendMessage(client, {
    type: 'ack',
    reqSeq: envelope.seq,
    payload: { status: 'ok' },
  });
}

type LogStoreDeps = {
  append: (entry: any) => void;
};

type RefreshCommandType = 'request_status_snapshot' | 'request_inventory' | 'request_recent_logs';

type DeviceStoreDeps = {
  updateDeviceStatus: (deviceId: string, status: 'connected' | 'disconnected') => unknown;
  updateDeviceOs: (deviceId: string, os: string) => unknown;
};

type PtySessionStoreDeps = {
  noteOutput: (sessionId: string, ts: string) => unknown;
  markClosed: (sessionId: string, ts: string, reason?: string | null) => any;
};

type PtyAuditDeps = {
  append: (entry: any) => void;
};

type PtyHubDeps = {
  appendOutput: (sessionId: string, data: string) => unknown;
  broadcast: (sessionId: string, message: any) => unknown;
};

export function handleAgentHeartbeat(input: {
  envelope: any;
  client: any;
  deviceStore: DeviceStoreDeps;
  sendMessage: (client: any, message: any) => unknown;
}) {
  const { envelope, client, deviceStore, sendMessage } = input;
  deviceStore.updateDeviceStatus(client.deviceId, 'connected');

  const os = envelope.payload?.os;
  if (typeof os === 'string' && os) {
    deviceStore.updateDeviceOs(client.deviceId, os);
  }

  sendMessage(client, {
    type: 'ack',
    reqSeq: envelope.seq,
    payload: { status: 'ok' },
  });
}

export function handleAgentStatusSnapshot(input: {
  envelope: any;
  client: any;
  logStore: LogStoreDeps;
  redactTelemetryPayload: (payload: unknown) => unknown;
  sendMessage: (client: any, message: any) => unknown;
  completeRefreshCommand: (
    deviceId: string,
    commandType: RefreshCommandType,
    observedAt: string | undefined,
    outcome: string,
  ) => void;
}) {
  const {
    envelope,
    client,
    logStore,
    redactTelemetryPayload,
    sendMessage,
    completeRefreshCommand,
  } = input;
  console.log(`Status snapshot from ${client.deviceId}:`, redactTelemetryPayload(envelope.payload ?? null));

  logStore.append({
    id: randomUUID(),
    deviceId: client.deviceId,
    type: 'status_snapshot',
    sessionId: client.sessionId ?? null,
    functionId: null,
    seq: typeof envelope.seq === 'number' ? envelope.seq : Date.now(),
    ts: envelope.ts || new Date().toISOString(),
    payload: envelope.payload ?? null,
  });

  sendMessage(client, {
    type: 'ack',
    reqSeq: envelope.seq,
    payload: { status: 'ok' },
  });

  completeRefreshCommand(client.deviceId, 'request_status_snapshot', envelope.ts, 'status snapshot received');
}

export function handleAgentInventory(input: {
  envelope: any;
  client: any;
  logStore: LogStoreDeps;
  redactTelemetryPayload: (payload: unknown) => unknown;
  sendMessage: (client: any, message: any) => unknown;
  completeRefreshCommand: (
    deviceId: string,
    commandType: RefreshCommandType,
    observedAt: string | undefined,
    outcome: string,
  ) => void;
}) {
  const {
    envelope,
    client,
    logStore,
    redactTelemetryPayload,
    sendMessage,
    completeRefreshCommand,
  } = input;
  console.log(`Inventory from ${client.deviceId}:`, redactTelemetryPayload(envelope.payload ?? null));

  logStore.append({
    id: randomUUID(),
    deviceId: client.deviceId,
    type: 'inventory',
    sessionId: client.sessionId ?? null,
    functionId: null,
    seq: typeof envelope.seq === 'number' ? envelope.seq : Date.now(),
    ts: envelope.ts || new Date().toISOString(),
    payload: envelope.payload ?? null,
  });

  sendMessage(client, {
    type: 'ack',
    reqSeq: envelope.seq,
    payload: { status: 'ok' },
  });

  completeRefreshCommand(client.deviceId, 'request_inventory', envelope.ts, 'inventory received');
}

export function handleAgentRecentLogs(input: {
  envelope: any;
  client: any;
  logStore: LogStoreDeps;
  redactTelemetryPayload: (payload: unknown) => unknown;
  sendMessage: (client: any, message: any) => unknown;
  completeRefreshCommand: (
    deviceId: string,
    commandType: RefreshCommandType,
    observedAt: string | undefined,
    outcome: string,
  ) => void;
}) {
  const {
    envelope,
    client,
    logStore,
    redactTelemetryPayload,
    sendMessage,
    completeRefreshCommand,
  } = input;
  console.log(`Recent logs from ${client.deviceId}:`, redactTelemetryPayload(envelope.payload ?? null));

  logStore.append({
    id: randomUUID(),
    deviceId: client.deviceId,
    type: 'recent_logs',
    sessionId: client.sessionId ?? null,
    functionId: null,
    seq: typeof envelope.seq === 'number' ? envelope.seq : Date.now(),
    ts: envelope.ts || new Date().toISOString(),
    payload: envelope.payload ?? null,
  });

  // Expand individual events from recent_logs so they populate
  // the runtime summary and become queryable (e.g. pty-output by sessionId).
  const payload =
    envelope.payload && typeof envelope.payload === 'object'
      ? (envelope.payload as Record<string, unknown>)
      : {};
  const recentEvents = Array.isArray(payload.events) ? payload.events : [];
  for (const evt of recentEvents) {
    const evtRecord =
      evt && typeof evt === 'object'
        ? (evt as Record<string, unknown>)
        : {};
    logStore.append({
      id: randomUUID(),
      deviceId: client.deviceId,
      type: typeof evtRecord.type === 'string' ? evtRecord.type : 'unknown',
      sessionId:
        typeof evtRecord.sessionId === 'string'
          ? evtRecord.sessionId
          : evtRecord.sessionId == null
            ? null
            : client.sessionId ?? null,
      functionId:
        typeof evtRecord.functionId === 'string'
          ? evtRecord.functionId
          : evtRecord.functionId == null
            ? null
            : null,
      seq: typeof evtRecord.seq === 'number' ? evtRecord.seq : Date.now(),
      ts:
        typeof evtRecord.ts === 'string' && evtRecord.ts.trim()
          ? evtRecord.ts
          : envelope.ts || new Date().toISOString(),
      payload:
        evtRecord.payload !== undefined && evtRecord.payload !== null
          ? evtRecord.payload
          : null,
    });
  }

  sendMessage(client, {
    type: 'ack',
    reqSeq: envelope.seq,
    payload: { status: 'ok' },
  });

  completeRefreshCommand(client.deviceId, 'request_recent_logs', envelope.ts, 'recent logs received');
}

export function handleAgentFunctionStatus(input: {
  envelope: any;
  client: any;
  logStore: LogStoreDeps;
  redactTelemetryPayload: (payload: unknown) => unknown;
  sendMessage: (client: any, message: any) => unknown;
  advanceRestartCommandFromFunctionStatus: (
    deviceId: string,
    observedAt: string | undefined,
    payload: Record<string, unknown>,
  ) => void;
}) {
  const {
    envelope,
    client,
    logStore,
    redactTelemetryPayload,
    sendMessage,
    advanceRestartCommandFromFunctionStatus,
  } = input;
  console.log(`Function status from ${client.deviceId}:`, redactTelemetryPayload(envelope.payload ?? null));

  const payload =
    envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
  const functionId =
    typeof payload.functionId === 'string' ? payload.functionId : null;

  logStore.append({
    id: randomUUID(),
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

  sendMessage(client, {
    type: 'ack',
    reqSeq: envelope.seq,
    payload: { status: 'ok' },
  });

  advanceRestartCommandFromFunctionStatus(client.deviceId, envelope.ts, payload);
}

export function handleAgentPtyOutput(input: {
  envelope: any;
  client: any;
  logStore: LogStoreDeps;
  ptySessionStore: PtySessionStoreDeps;
  ptyHub: PtyHubDeps;
}) {
  const { envelope, client, logStore, ptySessionStore, ptyHub } = input;
  const payload =
    envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
  const sessionId =
    typeof payload.sessionId === 'string'
      ? payload.sessionId
      : typeof payload.id === 'string'
        ? payload.id
        : client.sessionId ?? null;

  logStore.append({
    id: randomUUID(),
    deviceId: client.deviceId,
    type: 'pty-output',
    sessionId,
    functionId: null,
    seq: typeof envelope.seq === 'number' ? envelope.seq : Date.now(),
    ts: envelope.ts || new Date().toISOString(),
    payload: envelope.payload ?? null,
  });
  if (sessionId) {
    ptySessionStore.noteOutput(sessionId, envelope.ts || new Date().toISOString());
    const data = typeof payload.data === 'string' ? payload.data : '';
    ptyHub.appendOutput(sessionId, data);
    ptyHub.broadcast(sessionId, {
      type: 'pty_output',
      payload: {
        ...(payload ?? {}),
        sessionId,
      },
    });
  }
}

export function handleAgentPtyExit(input: {
  envelope: any;
  client: any;
  logStore: LogStoreDeps;
  ptySessionStore: PtySessionStoreDeps;
  ptyAudit: PtyAuditDeps;
  ptyHub: PtyHubDeps;
}) {
  const { envelope, client, logStore, ptySessionStore, ptyAudit, ptyHub } = input;
  const payload =
    envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
  const sessionId =
    typeof payload.sessionId === 'string'
      ? payload.sessionId
      : typeof payload.id === 'string'
        ? payload.id
        : client.sessionId ?? null;

  logStore.append({
    id: randomUUID(),
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
    const closed = ptySessionStore.markClosed(sessionId, envelope.ts || new Date().toISOString(), reason);
    ptyAudit.append({
      id: randomUUID(),
      sessionId: closed.sessionId,
      deviceId: closed.deviceId,
      ts: closed.closedAt || envelope.ts || new Date().toISOString(),
      eventType: 'pty_closed',
      actorType: 'system',
      actorId: null,
      summary: 'PTY session closed after agent exit',
      details: { exitReason: reason, payload: { exitCode: payload.exitCode ?? null, reason } },
    });
    ptyHub.broadcast(sessionId, {
      type: 'pty_exit',
      payload: {
        ...(payload ?? {}),
        sessionId,
      },
    });
  }
}

export function handleAgentCommandStatus(input: {
  envelope: any;
  client: any;
  commandStore: {
    getCommand: (commandId: string) => CommandRecord | null;
    hasAuditEvent: (commandId: string, eventTypes: string[], source: string) => boolean;
    appendAuditIfMissing: (entry: any) => void;
    markExecuting: (commandId: string, ts: string) => { state: string; executingAt: string | null };
    markSucceeded: (commandId: string, outcome: string | null, ts: string) => unknown;
    markFailed: (commandId: string, reasonCode: string, reasonDetail: string | null, ts: string) => unknown;
  };
}) {
  const { envelope, client, commandStore } = input;
  const commandId =
    typeof envelope.commandId === 'string' && envelope.commandId.trim().length
      ? envelope.commandId.trim()
      : null;
  if (!commandId) {
    return;
  }

  const command = commandStore.getCommand(commandId);
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
    if (!commandStore.hasAuditEvent(commandId, ['acknowledged', 'executing', 'succeeded', 'failed', 'canceled'], 'agent')) {
      commandStore.appendAuditIfMissing({
        id: randomUUID(),
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
    const updated = commandStore.markExecuting(commandId, ts);
    if (updated.state === 'executing' || updated.executingAt === ts) {
      commandStore.appendAuditIfMissing({
        id: randomUUID(),
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

    commandStore.markSucceeded(commandId, outcome, ts);
    commandStore.appendAuditIfMissing({
      id: randomUUID(),
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

    commandStore.markFailed(
      commandId,
      reasonCode ?? 'COMMAND_FAILED',
      reasonDetail,
      ts,
    );
    commandStore.appendAuditIfMissing({
      id: randomUUID(),
      commandId,
      ts,
      eventType: 'failed',
      source: 'agent',
      summary: `Agent failed ${command.commandType}`,
      details: payload,
    });
  }
}
