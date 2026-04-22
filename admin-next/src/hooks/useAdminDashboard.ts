import { useEffect, useRef, useState } from 'react';
import {
  buildTelemetryExportUrl,
  fetchCommandAudit,
  fetchCommands,
  fetchDeviceDetails,
  fetchDevices,
  fetchRecentLogs,
  fetchRuntimeSummary,
  fetchTelemetry,
  fetchTransfers,
  requestRecentLogs,
  requestStatusSnapshot,
  stopTransfer,
  dismissTransfer,
  forceRemoveTransfer,
  dismissFinishedTransfers,
  resumeTransfer,
  type CommandAuditEntry,
  type CommandHistoryEntry,
  type RecentLogEntry,
  type RuntimeSummary,
  type TelemetryEntry,
  type TransferEntry,
  subscribeTelemetryStream,
  subscribeTransfersStream,
} from '../api/adminApi';import type { DeviceSummary } from '../types/device';

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
      setActiveTransferId(null);
      setTelemetry([]);
      setTelemetryError(null);
      setTelemetryLoading(false);
      return;
    }

    void loadSelectedDevice(selectedDeviceId);
    void loadCommands(selectedDeviceId);
    void loadTelemetry(selectedDeviceId);
  }, [selectedDeviceId, telemetryTypeFilter, telemetryTextFilter, telemetryFromTsFilter, telemetryToTsFilter, recentLogsLimit, commandsLimit, telemetryLimit]);

  useEffect(() => {
    if (!selectedDeviceId) {
      return;
    }

    const telemetrySub = subscribeTelemetryStream(selectedDeviceId, () => {
      void loadTelemetry(selectedDeviceId);
    });

    const transfersSub = subscribeTransfersStream(selectedDeviceId, () => {
      void loadTransfers(selectedDeviceId);
    });

    const commandsInterval = window.setInterval(() => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      void loadCommands(selectedDeviceId, { silent: true });
    }, 15000);

    return () => {
      telemetrySub.unsubscribe();
      transfersSub.unsubscribe();
      window.clearInterval(commandsInterval);
    };
  }, [selectedDeviceId, telemetryTypeFilter, telemetryTextFilter, telemetryFromTsFilter, telemetryToTsFilter, recentLogsLimit, commandsLimit, telemetryLimit]);

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
      setSelectedDeviceId(deviceId);
    },
    requestStatusSnapshot: (deviceId: string) => {
      void runRequestStatusSnapshot(deviceId);
    },
    requestRecentLogs: (deviceId: string) => {
      void runRequestRecentLogs(deviceId);
    },
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
