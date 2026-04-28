import { useState } from 'react';
import { logout } from '../api/logout';

export function LogoutButton() {
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    try {
      await logout();
    } catch {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleLogout}
      disabled={loading}
      style={{
        marginLeft: 16,
        padding: '6px 14px',
        background: 'transparent',
        border: '1px solid #9ca3af',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: 13,
        color: '#6b7280',
      }}
    >
      {loading ? 'Logging out...' : 'Logout'}
    </button>
  );
}
