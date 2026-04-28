import { getAdminCsrfToken } from '../api/adminApi';

export async function logout(): Promise<void> {
  const csrfToken = getAdminCsrfToken();
  const response = await fetch('/admin/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken }),
  });
  if (response.ok || response.redirected) {
    window.location.assign('/admin/login');
  }
}
