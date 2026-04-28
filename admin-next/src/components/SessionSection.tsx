import { useState, useEffect } from 'react';
import { fetchSessions, revokeSession, revokeAllSessions, type SessionEntry } from '../api/adminApi';

export function SessionSection() {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    loadSessions();
  }, []);

  async function loadSessions() {
    setLoading(true);
    try {
      const data = await fetchSessions();
      setSessions(data);
      setError(null);
    } catch {
      setError('Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }

  async function handleRevoke(tokenHash: string) {
    setRevoking(tokenHash);
    try {
      await revokeSession(tokenHash);
      setSessions((prev) => prev.filter((s) => s.tokenHash !== tokenHash));
    } catch {
      setError('Failed to revoke session');
    } finally {
      setRevoking(null);
    }
  }

  async function handleRevokeAll() {
    if (!window.confirm('Sign out all other sessions? Your current session will remain active.')) return;
    setLoading(true);
    try {
      await revokeAllSessions();
      await loadSessions();
    } catch {
      setError('Failed to revoke sessions');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="totp-section">
      <h2>Active Sessions</h2>

      {error && (
        <div style={{ background: '#fef2f2', color: '#dc2626', padding: '8px 12px', borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {loading && <p style={{ color: '#6b7280' }}>Loading...</p>}

      {!loading && sessions.length === 0 && (
        <p style={{ color: '#6b7280' }}>No active sessions.</p>
      )}

      {sessions.length > 0 && (
        <div>
          <button
            onClick={handleRevokeAll}
            style={{ padding: '6px 14px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, marginBottom: 12 }}
          >
            Sign Out All Other Sessions
          </button>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Created</th>
                <th style={{ padding: '6px 8px' }}>Expires</th>
                <th style={{ padding: '6px 8px' }}>IP</th>
                <th style={{ padding: '6px 8px' }}>User Agent</th>
                <th style={{ padding: '6px 8px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.tokenHash} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '6px 8px', color: '#6b7280' }}>{new Date(s.createdAt).toLocaleString()}</td>
                  <td style={{ padding: '6px 8px', color: '#6b7280' }}>{new Date(s.expiresAt).toLocaleString()}</td>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{s.ip || '—'}</td>
                  <td style={{ padding: '6px 8px', color: '#6b7280', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.userAgent || '—'}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <button
                      onClick={() => handleRevoke(s.tokenHash)}
                      disabled={revoking === s.tokenHash}
                      style={{ padding: '4px 10px', background: 'transparent', border: '1px solid #dc2626', color: '#dc2626', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
                    >
                      {revoking === s.tokenHash ? 'Revoking...' : 'Revoke'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
