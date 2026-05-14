import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  fetchPtySessions,
  fetchRuntimeSummary,
  subscribeTelemetryStream,
  fetchTunnelLogs,
  requestStartServerSshPty,
  requestStartServerTunnel,
  requestStopServerTunnel,
  type RuntimeSummary,
  type TelemetryEntry,
  type TunnelLogEntry,
} from '../api/adminApi';
import { SshTerminalPanel } from '../components/SshTerminalPanel';
import { formatTimestamp } from '../utils/formatTimestamp';

/** Poll tunnel logs while the tunnel is running (telemetry match can miss when CC remote session id ≠ summary session id). */
export const TUNNEL_LOG_POLL_INTERVAL_MS = 2000;

type ActiveTerminal = { deviceId: string; serverId: string; sessionId: string };
type TunnelLogsLoadMode = 'full' | 'refresh';

function formatTunnelLogMessage(data: unknown): string {
  const value = typeof data === 'string' ? data : String(data ?? '');
  if (value.length === 0) {
    return '[empty log payload]';
  }
  if (value.trim().length === 0) {
    return `[whitespace-only log payload: ${JSON.stringify(value)}]`;
  }
  return value;
}

export function ServerRuntimePage() {
  const { deviceId = '', serverId = '' } = useParams();
  const [runtimeSummary, setRuntimeSummary] = useState<RuntimeSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tunnelLogs, setTunnelLogs] = useState<TunnelLogEntry[]>([]);
  const [tunnelLogsLoading, setTunnelLogsLoading] = useState(false);
  const [tunnelLogsError, setTunnelLogsError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [activeTerminal, setActiveTerminal] = useState<ActiveTerminal | null>(null);
  /** Tunnel sessionId captured directly from telemetry. Updated synchronously when a
   *  `function-status` event for this tunnel arrives, so it's available before the
   *  async `loadRuntime()` round-trip finishes. Without this, the first pty-output
   *  events after Start Tunnel race ahead of the summary refresh and don't match. */
  const tunnelSessionIdRef = useRef<string>('');

  useEffect(() => {
    const sid = String(runtimeSummary?.functions?.[`server-tunnel-${serverId}`]?.sessionId ?? '').trim();
    if (sid) {
      tunnelSessionIdRef.current = sid;
    }
  }, [runtimeSummary, serverId]);

  const loadRuntime = useCallback(async () => {
    if (!deviceId || !serverId) {
      setError('Missing device or server in URL');
      return;
    }

    setLoading(true);
    try {
      const summary = await fetchRuntimeSummary(deviceId);
      setRuntimeSummary(summary);
      setError(null);
    } catch (err) {
      setRuntimeSummary(null);
      setError(err instanceof Error ? err.message : 'Failed to load runtime summary');
    } finally {
      setLoading(false);
    }
  }, [deviceId, serverId]);

  const loadTunnelLogs = useCallback(async (mode: TunnelLogsLoadMode = 'full') => {
    if (!deviceId || !serverId) {
      return;
    }

    if (mode === 'full') {
      setTunnelLogsLoading(true);
    }
    try {
      const payload = await fetchTunnelLogs(deviceId, serverId, 200, 0);
      const newestFirstEntries = [...payload.entries].sort((left, right) => {
        const leftTime = Date.parse(left.ts || '') || 0;
        const rightTime = Date.parse(right.ts || '') || 0;
        return rightTime - leftTime;
      });
      setTunnelLogs(newestFirstEntries);
      setTunnelLogsError(null);
    } catch (err) {
      setTunnelLogs([]);
      if (mode === 'full') {
        setTunnelLogsError(err instanceof Error ? err.message : 'Failed to load tunnel logs');
      }
    } finally {
      if (mode === 'full') {
        setTunnelLogsLoading(false);
      }
    }
  }, [deviceId, serverId]);

  const loadActiveTerminal = useCallback(async () => {
    if (!deviceId || !serverId) {
      return;
    }
    try {
      const sessions = await fetchPtySessions(deviceId);
      const candidate = sessions.find((session) => {
        const matchesServer = String(session.serverId || '').trim() === serverId;
        const state = String(session.state || '').toLowerCase();
        return matchesServer && (state === 'open' || state === 'opening');
      });
      if (candidate?.sessionId) {
        setActiveTerminal({ deviceId, serverId, sessionId: candidate.sessionId });
      } else {
        setActiveTerminal(null);
      }
    } catch {
      setActiveTerminal(null);
    }
  }, [deviceId, serverId]);

  const selectedServer = useMemo(() => (
    runtimeSummary?.inventory?.servers?.find((server) => String(server.id || '').trim() === serverId) || null
  ), [runtimeSummary, serverId]);
  const serverName = String(selectedServer?.name || serverId || 'Server');
  const tunnelState = String(runtimeSummary?.functions?.[`server-tunnel-${serverId}`]?.state || '').toLowerCase();
  const tunnelRunning = tunnelState === 'running';

  useEffect(() => {
    void Promise.all([loadRuntime(), loadTunnelLogs('full'), loadActiveTerminal()]);
  }, [loadRuntime, loadTunnelLogs, loadActiveTerminal]);

  useEffect(() => {
    if (!tunnelRunning || !deviceId || !serverId) {
      return;
    }
    const id = window.setInterval(() => {
      void loadTunnelLogs('refresh');
    }, TUNNEL_LOG_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [tunnelRunning, deviceId, serverId, loadTunnelLogs]);

  useEffect(() => {
    if (!deviceId || !serverId) {
      return;
    }

    const telemetrySub = subscribeTelemetryStream(deviceId, (entry: TelemetryEntry | undefined) => {
      const eventType = typeof entry?.type === 'string' ? entry.type.trim().toLowerCase() : '';
      const tunnelKey = `server-tunnel-${serverId}`;
      const entrySessionId = typeof entry?.sessionId === 'string' ? entry.sessionId.trim() : '';
      const entryFunctionId = typeof entry?.functionId === 'string' ? entry.functionId.trim() : '';
      // function-status carries the canonical sessionId for this tunnel — capture it
      // synchronously so subsequent pty-output events (which have functionId=null) can
      // match by sessionId without waiting for a runtime-summary fetch to round-trip.
      if (eventType === 'function-status' && entryFunctionId === tunnelKey && entrySessionId) {
        tunnelSessionIdRef.current = entrySessionId;
      }
      const tunnelSessionId = tunnelSessionIdRef.current;
      const tunnelPtyTelemetry =
        eventType === 'pty-output'
        || eventType === 'pty-exit'
        || eventType === 'pty_output'
        || eventType === 'pty_exit';
      if (tunnelPtyTelemetry) {
        const matchesTunnelFunction = entryFunctionId === tunnelKey;
        const matchesTunnelSession = Boolean(tunnelSessionId) && entrySessionId === tunnelSessionId;
        if (matchesTunnelFunction || matchesTunnelSession) {
          void loadTunnelLogs('refresh');
        }
      }
      if (eventType === 'function-status' || eventType === 'status_snapshot' || eventType === 'inventory') {
        void loadRuntime();
      }
    });

    return () => {
      telemetrySub.unsubscribe();
    };
  }, [deviceId, serverId, loadRuntime, loadTunnelLogs]);

  async function handleStartTunnel() {
    if (!deviceId || !serverId) {
      return;
    }
    setActionLoading(true);
    try {
      await requestStartServerTunnel(deviceId, serverId);
      await Promise.all([loadRuntime(), loadTunnelLogs('full')]);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleStopTunnel() {
    if (!deviceId || !serverId) {
      return;
    }
    setActionLoading(true);
    try {
      await requestStopServerTunnel(deviceId, serverId);
      await Promise.all([loadRuntime(), loadTunnelLogs('full')]);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleStartSshTerminal() {
    if (!deviceId || !serverId) {
      return;
    }
    setActionLoading(true);
    try {
      const response = await requestStartServerSshPty(deviceId, serverId);
      if (response.sessionId) {
        setActiveTerminal({ deviceId, serverId, sessionId: response.sessionId });
      } else {
        await loadActiveTerminal();
      }
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <main className="panel-section runtime-summary-section">
      <div className="runtime-summary-header">
        <div>
          <h1>{serverName} runtime</h1>
          <p className="runtime-summary-subtitle">Device {deviceId}</p>
          <p className="runtime-summary-subtitle">Tunnel state: {tunnelRunning ? 'running' : 'stopped'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {runtimeSummary?.updatedAt ? <span className="command-state-badge">Updated {formatTimestamp(runtimeSummary.updatedAt)}</span> : null}
          <Link className="runtime-toolbar-button" to="/">
            Back to dashboard
          </Link>
        </div>
      </div>

      {loading && !runtimeSummary ? <p>Loading runtime summary…</p> : null}
      {error ? <p>{error}</p> : null}

      <div className="runtime-summary-tunnel-actions">
        {tunnelRunning ? (
          <button type="button" className="runtime-toolbar-button" disabled={actionLoading} onClick={handleStopTunnel}>
            {actionLoading ? 'Requesting…' : 'Stop tunnel'}
          </button>
        ) : (
          <button type="button" className="runtime-toolbar-button runtime-toolbar-button-primary" disabled={actionLoading} onClick={handleStartTunnel}>
            {actionLoading ? 'Requesting…' : 'Start tunnel'}
          </button>
        )}
        <button type="button" className="runtime-toolbar-button runtime-toolbar-button-primary" disabled={actionLoading} onClick={handleStartSshTerminal}>
          {actionLoading ? 'Requesting…' : 'Start SSH terminal'}
        </button>
      </div>

      <div className="runtime-summary-live-workspace">
        <section aria-label="Tunnel logs" className="runtime-summary-message-card runtime-summary-live-pane runtime-summary-live-pane-logs">
          <h2>Tunnel logs</h2>
          {tunnelLogsLoading ? <p>Loading tunnel logs…</p> : null}
          {tunnelLogsError ? <p>{tunnelLogsError}</p> : null}
          {!tunnelLogsLoading && tunnelLogs.length === 0 ? <p>No logs yet.</p> : null}
          {tunnelLogs.length > 0 ? (
            <ul className="runtime-summary-function-list runtime-summary-live-log-list">
              {tunnelLogs.map((entry, index) => (
                <li key={`${entry.ts || 'log'}-${index}`} className="runtime-summary-function-item">
                  <div>
                    <strong>{formatTimestamp(entry.ts)}</strong>
                    <p className="runtime-summary-function-message">{formatTunnelLogMessage(entry.data)}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <div className="runtime-summary-live-pane runtime-summary-live-pane-terminal">
          <SshTerminalPanel
            title={`SSH terminal for ${serverName}`}
            terminal={activeTerminal}
            onTerminalClosed={(terminal) => {
              if (activeTerminal?.sessionId === terminal.sessionId) {
                setActiveTerminal(null);
              }
            }}
          />
        </div>
      </div>
    </main>
  );
}
