import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  fetchPtySessions,
  fetchRuntimeSummary,
  fetchTunnelLogs,
  requestStartServerSshPty,
  requestStartServerTunnel,
  requestStopServerTunnel,
  type RuntimeSummary,
  type TunnelLogEntry,
} from '../api/adminApi';
import { SshTerminalPanel } from '../components/SshTerminalPanel';
import { formatTimestamp } from '../utils/formatTimestamp';

type ActiveTerminal = { deviceId: string; serverId: string; sessionId: string };

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

  const loadTunnelLogs = useCallback(async () => {
    if (!deviceId || !serverId) {
      return;
    }

    setTunnelLogsLoading(true);
    try {
      const payload = await fetchTunnelLogs(deviceId, serverId, 200, 0);
      setTunnelLogs(payload.entries);
      setTunnelLogsError(null);
    } catch (err) {
      setTunnelLogs([]);
      setTunnelLogsError(err instanceof Error ? err.message : 'Failed to load tunnel logs');
    } finally {
      setTunnelLogsLoading(false);
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

  useEffect(() => {
    void Promise.all([loadRuntime(), loadTunnelLogs(), loadActiveTerminal()]);
  }, [loadRuntime, loadTunnelLogs, loadActiveTerminal]);

  const selectedServer = useMemo(() => (
    runtimeSummary?.inventory?.servers?.find((server) => String(server.id || '').trim() === serverId) || null
  ), [runtimeSummary, serverId]);
  const serverName = String(selectedServer?.name || serverId || 'Server');
  const tunnelState = String(runtimeSummary?.functions?.[`server-tunnel-${serverId}`]?.state || '').toLowerCase();
  const tunnelRunning = tunnelState === 'running';

  async function handleStartTunnel() {
    if (!deviceId || !serverId) {
      return;
    }
    setActionLoading(true);
    try {
      await requestStartServerTunnel(deviceId, serverId);
      await Promise.all([loadRuntime(), loadTunnelLogs()]);
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
      await Promise.all([loadRuntime(), loadTunnelLogs()]);
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

      <section aria-label="Tunnel logs" className="runtime-summary-message-card">
        <h2>Tunnel logs</h2>
        {tunnelLogsLoading ? <p>Loading tunnel logs…</p> : null}
        {tunnelLogsError ? <p>{tunnelLogsError}</p> : null}
        {!tunnelLogsLoading && tunnelLogs.length === 0 ? <p>No logs yet.</p> : null}
        {tunnelLogs.length > 0 ? (
          <ul className="runtime-summary-function-list">
            {tunnelLogs.map((entry, index) => (
              <li key={`${entry.ts || 'log'}-${index}`} className="runtime-summary-function-item">
                <div>
                  <strong>{formatTimestamp(entry.ts)}</strong>
                  <p className="runtime-summary-function-message">{String(entry.data || '')}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <SshTerminalPanel
        title={`SSH terminal for ${serverName}`}
        terminal={activeTerminal}
        onTerminalClosed={(terminal) => {
          if (activeTerminal?.sessionId === terminal.sessionId) {
            setActiveTerminal(null);
          }
        }}
      />
    </main>
  );
}
