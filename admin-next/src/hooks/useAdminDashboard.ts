import { useEffect, useRef, useState } from 'react';
import {
  buildTelemetryExportUrl,
  fetchCommandAudit,
  fetchCommands,
  fetchDeviceDetails,
  fetchDevices,
  fetchPtySessions,
  fetchRecentLogs,
  fetchRuntimeSummary,
  fetchTelemetry,
  fetchTunnelLogs,
  fetchTransfers,
  requestRecentLogs,
  requestRestartOpenvpn,
  requestRestartBoundaryAuth,
  requestRestartServerTunnel,
  requestAttachServerSshPty,
  requestStartServerSshPty,
  requestStartServerTunnel,
  requestStopServerTunnel,
  requestStatusSnapshot,
  stopTransfer,
  dismissTransfer,
  forceRemoveTransfer,
  dismissFinishedTransfers,
  resumeTransfer,
  startScpTransfer as startScpTransferRequest,
  type CommandAuditEntry,
  type CommandHistoryEntry,
  type RecentLogEntry,
  type PtySessionEntry,
  type RuntimeSummary,
  type ScpTransferDirection,
  type ScpTransferPayload,
  type TelemetryEntry,
  type TunnelLogEntry, type TunnelLogsResponse,
  type TransferEntry,
  subscribeTelemetryStream,
  subscribeCommandsStream,
  subscribeTransfersStream,
} from '../api/adminApi';
import type { DeviceSummary } from '../types/device';

type ActiveSshTerminal = {
  deviceId: string;
  serverId: string;
  sessionId: string;
};

const SERVER_SSH_SESSION_PATTERN = /^server-ssh-(.+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUNTIME_SUMMARY_TELEMETRY_TYPES = new Set(['function-status', 'inventory', 'status_snapshot']);

function telemetryType(entry?: TelemetryEntry): string {
  return typeof entry?.type === 'string' ? entry.type.trim().toLowerCase() : '';
}

function shouldRefreshRuntimeSummaryFromTelemetry(entry?: TelemetryEntry): boolean {
  if (!entry) {
    return true;
  }

  return RUNTIME_SUMMARY_TELEMETRY_TYPES.has(telemetryType(entry));
}

function shouldRefetchTelemetryListFromTelemetry(entry?: TelemetryEntry): boolean {
  if (!entry) {
    return true;
  }

  return telemetryType(entry) !== 'pty-output';
}

function serverIdFromSshSessionId(sessionId: string): string | null {
  const match = SERVER_SSH_SESSION_PATTERN.exec(sessionId.trim());
  return match?.[1] || null;
}

function activeSshTerminalsFromPtySessions(deviceId: string, sessions: PtySessionEntry[]): ActiveSshTerminal[] {
  return sessions.flatMap((session) => {
    const sessionId = typeof session.sessionId === 'string' ? session.sessionId.trim() : '';
    const state = typeof session.state === 'string' ? session.state.trim().toLowerCase() : '';
    const serverId = serverIdFromSshSessionId(sessionId);

    if (!serverId || !['opening', 'open'].includes(state)) {
      return [];
    }

    return [{ deviceId, serverId, sessionId }];
  });
}

function runtimeSummaryHasActiveSsh(summary: RuntimeSummary): boolean {
  return Object.entries(summary.functions ?? {}).some(([functionId, status]) => {
    const state = typeof status?.state === 'string' ? status.state.trim().toLowerCase() : '';
    return functionId.startsWith('server-ssh-') && ['starting', 'running'].includes(state);
  });
}

function activeSshSessionsFromRuntimeSummary(summary: RuntimeSummary): Array<{ serverId: string; localSessionId: string }> {
  return Object.entries(summary.functions ?? {}).flatMap(([functionId, status]) => {
    const state = typeof status?.state === 'string' ? status.state.trim().toLowerCase() : '';
    const localSessionId = typeof status?.sessionId === 'string' ? status.sessionId.trim() : '';
    if (!functionId.startsWith('server-ssh-') || !['starting', 'running'].includes(state) || !localSessionId) {
      return [];
    }

    const serverId = functionId.slice('server-ssh-'.length).trim();
    return serverId ? [{ serverId, localSessionId }] : [];
  });
}

export function useAdminDashboard() {
  const selectionRequestIdRef = useRef(0);
  const snapshotRefreshTimersRef = useRef<number[]>([]);

  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [selectedDeviceDetails, setSelectedDeviceDetails] = useState<DeviceSummary | null>(null);
  const [selectedDeviceLoading, setSelectedDeviceLoading] = useState(false);
  const [selectedDeviceError, setSelectedDeviceError] = useState<string | null>(null);

  const [runtimeSummary, setRuntimeSummary] = useState<RuntimeSummary | null>(null);
  const [runtimeSummaryLoading, setRuntimeSummaryLoading] = useState(false);
  const [runtimeSummaryError, setRuntimeSummaryError] = useState<string | null>(null);

  const [recentLogs, setRecentLogs] = useState<RecentLogEntry[]>([]);
  const [recentLogsLoading, setRecentLogsLoading] = useState(false);
  const [recentLogsError, setRecentLogsError] = useState<string | null>(null);
  const [selectedTunnelServerId, setSelectedTunnelServerId] = useState<string | null>(null);
  const [activeSshTerminals, setActiveSshTerminals] = useState<ActiveSshTerminal[]>([]);
  const [tunnelLogs, setTunnelLogs] = useState<TunnelLogEntry[]>([]);
  const [tunnelLogsLoading, setTunnelLogsLoading] = useState(false);
  const [tunnelLogsError, setTunnelLogsError] = useState<string | null>(null);
  const [tunnelLogsTotal, setTunnelLogsTotal] = useState(0);

  const [commands, setCommands] = useState<CommandHistoryEntry[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const [commandsError, setCommandsError] = useState<string | null>(null);

  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null);
  const [commandAudit, setCommandAudit] = useState<CommandAuditEntry[]>([]);
  const [commandAuditLoading, setCommandAuditLoading] = useState(false);
  const [commandAuditError, setCommandAuditError] = useState<string | null>(null);

  const [transfers, setTransfers] = useState<TransferEntry[]>([]);
  const [transfersLoading, setTransfersLoading] = useState(false);
  const [transfersError, setTransfersError] = useState<string | null>(null);
  const [transferActionLoading, setTransferActionLoading] = useState(false);
  const [transferStartLoading, setTransferStartLoading] = useState(false);
  const [activeTransferId, setActiveTransferId] = useState<string | null>(null);

  const [telemetry, setTelemetry] = useState<TelemetryEntry[]>([]);
  const [telemetryLoading, setTelemetryLoading] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [telemetryTypeFilter, setTelemetryTypeFilter] = useState('');
  const [telemetryTextFilter, setTelemetryTextFilter] = useState('');
  const [telemetryFromTsFilter, setTelemetryFromTsFilter] = useState('');
  const [telemetryToTsFilter, setTelemetryToTsFilter] = useState('');
  const [deviceActionLoadingId, setDeviceActionLoadingId] = useState<string | null>(null);
  const [recentLogsLimit, setRecentLogsLimit] = useState(20);
  const [commandsLimit, setCommandsLimit] = useState(20);
  const [transfersLimit, setTransfersLimit] = useState(50);
  const [telemetryLimit, setTelemetryLimit] = useState(100);

  const [deviceActionError, setDeviceActionError] = useState<string | null>(null);

  async function loadActiveSshTerminalsOnly(deviceId: string, requestId?: number, summary?: RuntimeSummary) {
    try {
      const sessions = await fetchPtySessions(deviceId);
      if (requestId != null && selectionRequestIdRef.current !== requestId) {
        return;
      }

      const hydratedTerminals = activeSshTerminalsFromPtySessions(deviceId, sessions);
      const hydratedServerIds = new Set(hydratedTerminals.map((terminal) => terminal.serverId));
      const adoptedTerminals: ActiveSshTerminal[] = [];
      for (const activeSsh of summary ? activeSshSessionsFromRuntimeSummary(summary) : []) {
        if (hydratedServerIds.has(activeSsh.serverId)) {
          continue;
        }

        try {
          const response = await requestAttachServerSshPty(deviceId, activeSsh.serverId, activeSsh.localSessionId);
          const sessionId = typeof response.sessionId === 'string' ? response.sessionId.trim() : '';
          if (sessionId) {
            adoptedTerminals.push({ deviceId, serverId: activeSsh.serverId, sessionId });
            hydratedServerIds.add(activeSsh.serverId);
          }
        } catch {
          continue;
        }
      }

      if (requestId != null && selectionRequestIdRef.current !== requestId) {
        return;
      }
      const nextTerminals = [...hydratedTerminals, ...adoptedTerminals];
      setActiveSshTerminals((previous) => [...previous.filter((terminal) => terminal.deviceId !== deviceId), ...nextTerminals]);
    } catch {
      return;
    }
  }

  function loadActiveSshTerminalsFromSummary(deviceId: string, summary: RuntimeSummary, requestId?: number) {
    if (requestId != null && selectionRequestIdRef.current !== requestId) {
      return;
    }

    if (!runtimeSummaryHasActiveSsh(summary)) {
      setActiveSshTerminals((previous) => previous.filter((terminal) => terminal.deviceId !== deviceId));
      return;
    }

    void loadActiveSshTerminalsOnly(deviceId, requestId, summary);
  }

  async function loadSelectedDevice(deviceId: string) {
    const requestId = selectionRequestIdRef.current + 1;
    selectionRequestIdRef.current = requestId;

    setSelectedDeviceLoading(true);
    setRuntimeSummaryLoading(true);
    setRecentLogsLoading(true);

    const deviceTask = fetchDeviceDetails(deviceId)
      .then((devicePayload) => {
        if (selectionRequestIdRef.current !== requestId) {
          return;
        }

        setSelectedDeviceDetails(devicePayload);
        setSelectedDeviceError(null);
      })
      .catch((err) => {
        if (selectionRequestIdRef.current !== requestId) {
          return;
        }

        const message = err instanceof Error ? err.message : 'Failed to load selected device details';
        setSelectedDeviceDetails(null);
        setSelectedDeviceError(message);
        setRuntimeSummary(null);
        setRuntimeSummaryError(null);
        setRecentLogs([]);
        setRecentLogsError(null);
      })
      .finally(() => {
        if (selectionRequestIdRef.current !== requestId) {
          return;
        }

        setSelectedDeviceLoading(false);
      });

    const summaryTask = fetchRuntimeSummary(deviceId)
      .then((summaryPayload) => {
        if (selectionRequestIdRef.current !== requestId) {
          return;
        }

        setRuntimeSummary(summaryPayload);
        setRuntimeSummaryError(null);
        loadActiveSshTerminalsFromSummary(deviceId, summaryPayload, requestId);
      })
      .catch((err) => {
        if (selectionRequestIdRef.current !== requestId) {
          return;
        }

        const message = err instanceof Error ? err.message : 'Failed to load runtime summary';
        setRuntimeSummary(null);
        setRuntimeSummaryError(message);
      })
      .finally(() => {
        if (selectionRequestIdRef.current !== requestId) {
          return;
        }

        setRuntimeSummaryLoading(false);
      });

    const logsTask = fetchRecentLogs(deviceId, recentLogsLimit)
      .then((logsPayload) => {
        if (selectionRequestIdRef.current !== requestId) {
          return;
        }

        setRecentLogs(logsPayload);
        setRecentLogsError(null);
      })
      .catch((err) => {
        if (selectionRequestIdRef.current !== requestId) {
          return;
        }

        const message = err instanceof Error ? err.message : 'Failed to load recent logs';
        setRecentLogs([]);
        setRecentLogsError(message);
      })
      .finally(() => {
        if (selectionRequestIdRef.current !== requestId) {
          return;
        }

        setRecentLogsLoading(false);
      });

    await Promise.all([deviceTask, summaryTask, logsTask]);
  }

  async function loadRuntimeSummaryOnly(deviceId: string) {
    setRuntimeSummaryLoading(true);

    try {
      const summaryPayload = await fetchRuntimeSummary(deviceId);
      setRuntimeSummary(summaryPayload);
      setRuntimeSummaryError(null);
      loadActiveSshTerminalsFromSummary(deviceId, summaryPayload);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load runtime summary';
      setRuntimeSummary(null);
      setRuntimeSummaryError(message);
    } finally {
      setRuntimeSummaryLoading(false);
    }
  }

  async function loadRecentLogsOnly(deviceId: string, options?: { silent?: boolean }) {
    const silent = options?.silent === true;
    if (!silent) {
      setRecentLogsLoading(true);
    }

    try {
      const logsPayload = await fetchRecentLogs(deviceId, recentLogsLimit);
      setRecentLogs(logsPayload);
      setRecentLogsError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load recent logs';
      if (!silent) {
        setRecentLogs([]);
      }
      setRecentLogsError(message);
    } finally {
      if (!silent) {
        setRecentLogsLoading(false);
      }
    }
  }

  async function loadTunnelLogsOnly(
    deviceId: string,
    serverId: string,
    options?: { silent?: boolean; append?: boolean; offset?: number },
  ) {
    const silent = options?.silent === true;
    const append = options?.append === true;
    const offset = options?.offset ?? (append ? tunnelLogs.length : 0);
    if (!silent) {
      setTunnelLogsLoading(true);
    }

    try {
      const { entries, total } = await fetchTunnelLogs(deviceId, serverId, 200, offset);
      setTunnelLogs((prev) => (append ? [...prev, ...entries] : entries));
      setTunnelLogsTotal(total);
      setTunnelLogsError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load tunnel logs';
      if (!silent && !append) {
        setTunnelLogs([]);
      }
      setTunnelLogsError(message);
    } finally {
      if (!silent) {
        setTunnelLogsLoading(false);
      }
    }
  }

  function loadMoreTunnelLogs() {
    if (selectedDeviceId && selectedTunnelServerId && tunnelLogs.length < tunnelLogsTotal) {
      void loadTunnelLogsOnly(selectedDeviceId, selectedTunnelServerId, { append: true });
    }
  }

  async function loadCommandAudit(commandId: string) {
    setCommandAuditLoading(true);

    try {
      const auditEntries = await fetchCommandAudit(commandId);
      setCommandAudit(auditEntries);
      setCommandAuditError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load command audit';
      setCommandAudit([]);
      setCommandAuditError(message);
    } finally {
      setCommandAuditLoading(false);
    }
  }

  async function selectCommand(commandId: string) {
    setSelectedCommandId(commandId);
    await loadCommandAudit(commandId);
  }

  async function loadCommands(deviceId: string, options?: { silent?: boolean }) {
    const silent = options?.silent === true;
    if (!silent) {
      setCommandsLoading(true);
    }

    try {
      const nextCommands = await fetchCommands(deviceId, commandsLimit);
      setCommands(nextCommands);
      setCommandsError(null);

      const nextSelectedCommandId =
        nextCommands.find((item) => item.commandId === selectedCommandId)?.commandId
        ?? nextCommands[0]?.commandId
        ?? null;
      setSelectedCommandId(nextSelectedCommandId);

      if (nextSelectedCommandId) {
        await loadCommandAudit(nextSelectedCommandId);
      } else {
        setCommandAudit([]);
        setCommandAuditError(null);
        setCommandAuditLoading(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load commands';
      setCommands([]);
      setCommandsError(message);
      setSelectedCommandId(null);
      setCommandAudit([]);
      setCommandAuditError(null);
      setCommandAuditLoading(false);
    } finally {
      if (!silent) {
        setCommandsLoading(false);
      }
    }
  }

  function upsertTransfer(nextTransfer: TransferEntry) {
    if (!nextTransfer?.transferId) {
      return;
    }

    setTransfers((currentTransfers) => [
      nextTransfer,
      ...currentTransfers.filter((item) => item.transferId !== nextTransfer.transferId),
    ].sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || '') || 0;
      const rightTime = Date.parse(right.updatedAt || '') || 0;
      return rightTime - leftTime;
    }).slice(0, transfersLimit));
    setTransfersError(null);
  }

  async function loadTransfers(deviceId: string) {
    setTransfersLoading(true);

    try {
      const nextTransfers = await fetchTransfers(deviceId, transfersLimit);
      setTransfers(nextTransfers);
      setTransfersError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load transfers';
      setTransfers([]);
      setTransfersError(message);
    } finally {
      setTransfersLoading(false);
    }
  }

  async function runTransferAction(action: 'stop' | 'dismiss' | 'force-remove' | 'resume', transferId: string) {
    if (!selectedDeviceId) {
      return;
    }

    setTransferActionLoading(true);
    setActiveTransferId(transferId);

    try {
      if (action === 'stop') {
        await stopTransfer(selectedDeviceId, transferId);
      } else if (action === 'dismiss') {
        await dismissTransfer(selectedDeviceId, transferId);
      } else if (action === 'force-remove') {
        await forceRemoveTransfer(selectedDeviceId, transferId);
      } else {
        const transfer = transfers.find((item) => item.transferId === transferId);
        if (!transfer) {
          throw new Error('Transfer not found');
        }
        await resumeTransfer(selectedDeviceId, transfer);
      }

      await loadTransfers(selectedDeviceId);
      setTransfersError(null);
    } catch (err) {
      setTransfersError(err instanceof Error ? err.message : 'Failed transfer action');
    } finally {
      setTransferActionLoading(false);
      setActiveTransferId(null);
    }
  }

  async function runStartScpTransfer(deviceId: string, direction: ScpTransferDirection, payload: ScpTransferPayload) {
    setTransferStartLoading(true);

    try {
      await startScpTransferRequest(deviceId, direction, payload);
      setTransfersError(null);
      setSelectedDeviceId(deviceId);
      await Promise.allSettled([
        loadTransfers(deviceId),
        loadCommands(deviceId, { silent: true }),
      ]);
    } catch (err) {
      setTransfersError(err instanceof Error ? err.message : 'Failed to start SCP transfer');
    } finally {
      setTransferStartLoading(false);
    }
  }

  async function loadTelemetry(deviceId: string) {
    setTelemetryLoading(true);

    try {
      const events = await fetchTelemetry(deviceId, {
        limit: telemetryLimit,
        type: telemetryTypeFilter || undefined,
        q: telemetryTextFilter.trim() || undefined,
        fromTs: telemetryFromTsFilter.trim() || undefined,
        toTs: telemetryToTsFilter.trim() || undefined,
      });
      setTelemetry(events);
      setTelemetryError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load telemetry';
      setTelemetry([]);
      setTelemetryError(message);
    } finally {
      setTelemetryLoading(false);
    }
  }

  async function loadDevices() {
    setLoading(true);

    try {
      const nextDevices = await fetchDevices();
      setDevices(nextDevices);
      setError(null);

      setSelectedDeviceId((current) =>
        current && nextDevices.some((item) => item.id === current) ? current : null,
      );

      setSelectedDeviceDetails((current) =>
        current && nextDevices.some((item) => item.id === current.id) ? current : null,
      );
      setSelectedDeviceError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }

  function clearSnapshotRefreshTimers() {
    snapshotRefreshTimersRef.current.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    snapshotRefreshTimersRef.current = [];
  }

  async function refreshSnapshotData(deviceId: string) {
    await Promise.allSettled([
      loadCommands(deviceId, { silent: true }),
      loadRuntimeSummaryOnly(deviceId),
    ]);
  }

  function scheduleSnapshotFollowUpRefresh(deviceId: string) {
    clearSnapshotRefreshTimers();
    snapshotRefreshTimersRef.current = [1000, 3000].map((delayMs) =>
      window.setTimeout(() => {
        void refreshSnapshotData(deviceId);
      }, delayMs),
    );
  }

  async function refreshRecentLogsData(deviceId: string) {
    await Promise.allSettled([
      loadCommands(deviceId, { silent: true }),
      loadRecentLogsOnly(deviceId, { silent: true }),
    ]);
  }

  function scheduleRecentLogsFollowUpRefresh(deviceId: string) {
    clearSnapshotRefreshTimers();
    snapshotRefreshTimersRef.current = [1000, 3000].map((delayMs) =>
      window.setTimeout(() => {
        void refreshRecentLogsData(deviceId);
      }, delayMs),
    );
  }

  async function runRequestStatusSnapshot(deviceId: string) {
    setDeviceActionLoadingId(deviceId);

    try {
      await requestStatusSnapshot(deviceId);
      setDeviceActionError(null);
      setSelectedDeviceId(deviceId);
      await refreshSnapshotData(deviceId);
      scheduleSnapshotFollowUpRefresh(deviceId);
    } catch (err) {
      setDeviceActionError(err instanceof Error ? err.message : 'Failed to request status snapshot');
    } finally {
      setDeviceActionLoadingId(null);
    }
  }

  async function runRequestRecentLogs(deviceId: string) {
    setDeviceActionLoadingId(deviceId);

    try {
      await requestRecentLogs(deviceId);
      setDeviceActionError(null);
      setSelectedDeviceId(deviceId);
      await refreshRecentLogsData(deviceId);
      scheduleRecentLogsFollowUpRefresh(deviceId);
    } catch (err) {
      setDeviceActionError(err instanceof Error ? err.message : 'Failed to request recent logs');
    } finally {
      setDeviceActionLoadingId(null);
    }
  }

  async function runRequestRestartOpenvpn(deviceId: string) {
    setDeviceActionLoadingId(deviceId);

    try {
      await requestRestartOpenvpn(deviceId);
      setDeviceActionError(null);
    } catch (err) {
      setDeviceActionError(err instanceof Error ? err.message : 'Failed to request OpenVPN restart');
    } finally {
      setDeviceActionLoadingId(null);
    }
  }

  async function runRequestRestartBoundaryAuth(deviceId: string) {
    setDeviceActionLoadingId(deviceId);

    try {
      await requestRestartBoundaryAuth(deviceId);
      setDeviceActionError(null);
    } catch (err) {
      setDeviceActionError(err instanceof Error ? err.message : 'Failed to request Boundary auth restart');
    } finally {
      setDeviceActionLoadingId(null);
    }
  }

  async function runRequestRestartServerTunnel(deviceId: string, serverId: string) {
    setDeviceActionLoadingId(deviceId);

    try {
      await requestRestartServerTunnel(deviceId, serverId);
      setDeviceActionError(null);
    } catch (err) {
      setDeviceActionError(err instanceof Error ? err.message : 'Failed to request server tunnel restart');
    } finally {
      setDeviceActionLoadingId(null);
    }
  }

  async function runRequestStartServerTunnel(deviceId: string, serverId: string) {
    setDeviceActionLoadingId(deviceId);

    try {
      await requestStartServerTunnel(deviceId, serverId);
      setDeviceActionError(null);
      setSelectedDeviceId(deviceId);
      await refreshSnapshotData(deviceId);
      scheduleSnapshotFollowUpRefresh(deviceId);
    } catch (err) {
      setDeviceActionError(err instanceof Error ? err.message : 'Failed to request server tunnel start');
    } finally {
      setDeviceActionLoadingId(null);
    }
  }

  async function runStartServerSshTerminal(deviceId: string, serverId: string) {
    setDeviceActionLoadingId(deviceId);

    try {
      const response = await requestStartServerSshPty(deviceId, serverId);
      const sessionId = response.sessionId;
      if (!sessionId) {
        throw new Error('Server SSH terminal did not return a session id');
      }
      setDeviceActionError(null);
      setSelectedDeviceId(deviceId);
      await refreshSnapshotData(deviceId);
      setActiveSshTerminals((previous) => [
        ...previous.filter((terminal) => !(terminal.deviceId === deviceId && terminal.serverId === serverId)),
        { deviceId, serverId, sessionId },
      ]);
      scheduleSnapshotFollowUpRefresh(deviceId);
    } catch (err) {
      setDeviceActionError(err instanceof Error ? err.message : 'Failed to request server SSH terminal');
    } finally {
      setDeviceActionLoadingId(null);
    }
  }

  async function runRequestStopServerTunnel(deviceId: string, serverId: string) {
    setDeviceActionLoadingId(deviceId);

    try {
      await requestStopServerTunnel(deviceId, serverId);
      setDeviceActionError(null);
      setSelectedDeviceId(deviceId);
      await refreshSnapshotData(deviceId);
      scheduleSnapshotFollowUpRefresh(deviceId);
    } catch (err) {
      setDeviceActionError(err instanceof Error ? err.message : 'Failed to request server tunnel stop');
    } finally {
      setDeviceActionLoadingId(null);
    }
  }

  useEffect(() => {
    void loadDevices();
    return () => {
      clearSnapshotRefreshTimers();
    };
  }, []);

  useEffect(() => {
    if (!selectedDeviceId) {
      setSelectedDeviceDetails(null);
      setSelectedDeviceError(null);
      setSelectedDeviceLoading(false);
      setRuntimeSummary(null);
      setRuntimeSummaryError(null);
      setRuntimeSummaryLoading(false);
      setRecentLogs([]);
      setRecentLogsError(null);
      setRecentLogsLoading(false);
      setSelectedTunnelServerId(null);
      setTunnelLogs([]);
      setTunnelLogsError(null);
      setTunnelLogsLoading(false);
      setCommands([]);
      setCommandsError(null);
      setCommandsLoading(false);
      setSelectedCommandId(null);
      setCommandAudit([]);
      setCommandAuditError(null);
      setCommandAuditLoading(false);
      setTransfers([]);
      setTransfersError(null);
      setTransfersLoading(false);
      setTransferActionLoading(false);
      setTransferStartLoading(false);
      setActiveTransferId(null);
      setTelemetry([]);
      setTelemetryError(null);
      setTelemetryLoading(false);
      setActiveSshTerminals([]);
      return;
    }

    void loadSelectedDevice(selectedDeviceId);
    void loadCommands(selectedDeviceId);
    void loadTelemetry(selectedDeviceId);
  }, [selectedDeviceId, telemetryTypeFilter, telemetryTextFilter, telemetryFromTsFilter, telemetryToTsFilter, recentLogsLimit, commandsLimit, telemetryLimit]);

  useEffect(() => {
    if (!selectedDeviceId || !selectedTunnelServerId) {
      setTunnelLogs([]);
      setTunnelLogsError(null);
      setTunnelLogsLoading(false);
      setTunnelLogsTotal(0);
      return;
    }

    void loadTunnelLogsOnly(selectedDeviceId, selectedTunnelServerId);
  }, [selectedDeviceId, selectedTunnelServerId]);

  useEffect(() => {
    if (!selectedDeviceId) {
      return;
    }

    const telemetrySub = subscribeTelemetryStream(selectedDeviceId, (entry) => {
      if (shouldRefreshRuntimeSummaryFromTelemetry(entry)) {
        void loadRuntimeSummaryOnly(selectedDeviceId);
      }
      if (shouldRefetchTelemetryListFromTelemetry(entry)) {
        void loadTelemetry(selectedDeviceId);
      }
      if (selectedTunnelServerId && shouldRefetchTelemetryListFromTelemetry(entry)) {
        void loadTunnelLogsOnly(selectedDeviceId, selectedTunnelServerId, { silent: true });
      }
    });

    const transfersSub = subscribeTransfersStream(selectedDeviceId, (transfer) => {
      if (transfer?.transferId) {
        upsertTransfer(transfer);
        return;
      }
      void loadTransfers(selectedDeviceId);
    });

    const commandsSub = subscribeCommandsStream(selectedDeviceId, () => {
      void loadCommands(selectedDeviceId, { silent: true });
    });

    return () => {
      telemetrySub.unsubscribe();
      transfersSub.unsubscribe();
      commandsSub.unsubscribe();
    };
  }, [selectedDeviceId, selectedTunnelServerId, telemetryTypeFilter, telemetryTextFilter, telemetryFromTsFilter, telemetryToTsFilter, recentLogsLimit, commandsLimit, telemetryLimit]);

  const telemetryExportUrl = selectedDeviceId
    ? buildTelemetryExportUrl(selectedDeviceId, {
        limit: 100,
        type: telemetryTypeFilter || undefined,
        q: telemetryTextFilter.trim() || undefined,
        fromTs: telemetryFromTsFilter.trim() || undefined,
        toTs: telemetryToTsFilter.trim() || undefined,
      })
    : null;

  return {
    devices,
    loading,
    error,
    selectedDeviceId,
    selectedDeviceDetails,
    selectedDeviceLoading,
    selectedDeviceError,
    runtimeSummary,
    runtimeSummaryLoading,
    runtimeSummaryError,
    recentLogs,
    recentLogsLoading,
    recentLogsError,
    selectedTunnelServerId,
    tunnelLogs,
    tunnelLogsLoading,
    tunnelLogsError,
    tunnelLogsTotal,
    loadMoreTunnelLogs,
    commands,
    commandsLoading,
    commandsError,
    selectedCommandId,
    commandAudit,
    commandAuditLoading,
    commandAuditError,
    transfers,
    transfersLoading,
    transfersError,
    transferActionLoading,
    transferStartLoading,
    activeTransferId,
    telemetry,
    telemetryLoading,
    telemetryError,
    telemetryTypeFilter,
    telemetryTextFilter,
    telemetryFromTsFilter,
    telemetryToTsFilter,
    deviceActionLoadingId,
    deviceActionError,
    telemetryExportUrl,
    setTelemetryTypeFilter,
    setTelemetryTextFilter,
    setTelemetryFromTsFilter,
    setTelemetryToTsFilter,
    refreshDevices: () => {
      void loadDevices();
    },
    refreshTransfers: () => {
      if (selectedDeviceId) {
        void loadTransfers(selectedDeviceId);
      }
    },
    stopTransfer: (transferId: string) => {
      void runTransferAction('stop', transferId);
    },
    dismissTransfer: (transferId: string) => {
      void runTransferAction('dismiss', transferId);
    },
    forceRemoveTransfer: (transferId: string) => {
      void runTransferAction('force-remove', transferId);
    },
    resumeTransfer: (transferId: string) => {
      void runTransferAction('resume', transferId);
    },
    startScpTransfer: (deviceId: string, direction: ScpTransferDirection, payload: ScpTransferPayload) => {
      void runStartScpTransfer(deviceId, direction, payload);
    },
    dismissFinishedTransfers: () => {
      if (!selectedDeviceId) {
        return;
      }
      setTransferActionLoading(true);
      setActiveTransferId(null);
      void dismissFinishedTransfers(selectedDeviceId)
        .then(() => loadTransfers(selectedDeviceId))
        .then(() => {
          setTransfersError(null);
        })
        .catch((err) => {
          setTransfersError(err instanceof Error ? err.message : 'Failed transfer action');
        })
        .finally(() => {
          setTransferActionLoading(false);
        });
    },
    refreshTelemetry: () => {
      if (selectedDeviceId) {
        void loadTelemetry(selectedDeviceId);
      }
    },
    refreshCommands: () => {
      if (selectedDeviceId) {
        void loadCommands(selectedDeviceId);
      }
    },
    selectCommand: (commandId: string) => {
      void selectCommand(commandId);
    },
    selectDevice: (deviceId: string) => {
      setDeviceActionError(null);
      setSelectedTunnelServerId(null);
      setSelectedDeviceId(deviceId);
    },
    requestStatusSnapshot: (deviceId: string) => {
      void runRequestStatusSnapshot(deviceId);
    },
    requestRecentLogs: (deviceId: string) => {
      void runRequestRecentLogs(deviceId);
    },
    selectTunnelServer: (serverId: string) => {
      setSelectedTunnelServerId(serverId);
    },
    refreshTunnelLogs: () => {
      if (selectedDeviceId && selectedTunnelServerId) {
        void loadTunnelLogsOnly(selectedDeviceId, selectedTunnelServerId);
      }
    },
    requestRestartOpenvpn: (deviceId: string) => {
      void runRequestRestartOpenvpn(deviceId);
    },
    requestRestartBoundaryAuth: (deviceId: string) => {
      void runRequestRestartBoundaryAuth(deviceId);
    },
    requestStartServerTunnel: (deviceId: string, serverId: string) => {
      void runRequestStartServerTunnel(deviceId, serverId);
    },
    requestStopServerTunnel: (deviceId: string, serverId: string) => {
      void runRequestStopServerTunnel(deviceId, serverId);
    },
    startServerSshTerminal: (deviceId: string, serverId: string) => {
      void runStartServerSshTerminal(deviceId, serverId);
    },
    activeSshTerminals,
    retryRuntimeSummary: () => {
      if (selectedDeviceId) {
        void loadRuntimeSummaryOnly(selectedDeviceId);
      }
    },
    recentLogsLimit,
    setRecentLogsLimit,
    commandsLimit,
    setCommandsLimit,
    transfersLimit,
    setTransfersLimit,
    telemetryLimit,
    setTelemetryLimit,
    retryRecentLogs: () => {
      if (selectedDeviceId) {
        void loadRecentLogsOnly(selectedDeviceId);
      }
    },
  };
}
