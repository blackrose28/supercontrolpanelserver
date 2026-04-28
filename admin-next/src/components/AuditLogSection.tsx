import { useState, useEffect } from 'react';
import { fetchAuditLog, type AuditEntry } from '../api/adminApi';

export function AuditLogSection() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadLog();
  }, []);

  async function loadLog() {
    setLoading(true);
    try {
      const data = await fetchAuditLog({ limit: 50 });
      setEntries(data);
      setError(null);
    } catch {
      setError('Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }

  function formatEvent(event: string): string {
    return event.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return (
    <div className="totp-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Audit Log</h2>
        <button
          onClick={loadLog}
          style={{ padding: '4px 12px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', color: '#dc2626', padding: '6px 10px', borderRadius: 4, marginBottom: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading && <p style={{ color: '#6b7280', fontSize: 13 }}>Loading...</p>}

      {!loading && entries.length === 0 && (
        <p style={{ color: '#6b7280', fontSize: 13 }}>No audit entries yet.</p>
      )}

      {entries.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
              <th style={{ padding: '4px 8px' }}>Time</th>
              <th style={{ padding: '4px 8px' }}>Event</th>
              <th style={{ padding: '4px 8px' }}>Actor</th>
              <th style={{ padding: '4px 8px' }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '4px 8px', color: '#6b7280', whiteSpace: 'nowrap', fontSize: 12 }}>
                  {new Date(entry.createdAt).toLocaleString()}
                </td>
                <td style={{ padding: '4px 8px', fontSize: 12 }}>
                  <span style={{
                    padding: '1px 6px',
                    borderRadius: 4,
                    fontSize: 11,
                    fontWeight: 600,
                    background: entry.event.includes('FAILED') || entry.event.includes('LOCKOUT')
                      ? '#fef2f2' : entry.event.includes('SUCCESS') ? '#f0fdf4' : '#f3f4f6',
                    color: entry.event.includes('FAILED') || entry.event.includes('LOCKOUT')
                      ? '#dc2626' : entry.event.includes('SUCCESS') ? '#059669' : '#374151',
                  }}>
                    {formatEvent(entry.event)}
                  </span>
                </td>
                <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: 12 }}>
                  {entry.actor || '—'}
                </td>
                <td style={{ padding: '4px 8px', color: '#6b7280', fontSize: 12, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.details ? JSON.stringify(entry.details) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
