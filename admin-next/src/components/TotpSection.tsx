import { useState, useEffect } from 'react';
import {
  fetchTotpStatus,
  setupTotp,
  verifyTotpSetup,
  disableTotp,
  fetchRecoveryCodes,
  regenerateRecoveryCodes,
} from '../api/adminApi';

type Props = Record<string, never>;

export function TotpSection(_props: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Setup flow state
  const [setupData, setSetupData] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [totpInput, setTotpInput] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Disable flow state
  const [showDisable, setShowDisable] = useState(false);
  const [disableInput, setDisableInput] = useState('');

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    try {
      const status = await fetchTotpStatus();
      setEnabled(status.enabled);
    } catch {
      setError('Failed to load 2FA status');
    }
  }

  async function handleStartSetup() {
    setError(null);
    setLoading(true);
    try {
      const data = await setupTotp();
      setSetupData(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Setup failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifySetup() {
    if (totpInput.length !== 6) return;
    setError(null);
    setLoading(true);
    try {
      await verifyTotpSetup(totpInput);
      setEnabled(true);
      setSetupData(null);
      setTotpInput('');
      // Fetch recovery codes after setup
      const rc = await fetchRecoveryCodes();
      setRecoveryCodes(rc.codes);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleDisable() {
    if (disableInput.length !== 6) return;
    setError(null);
    setLoading(true);
    try {
      await disableTotp(disableInput);
      setEnabled(false);
      setShowDisable(false);
      setDisableInput('');
      setRecoveryCodes(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disable 2FA');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegenerateCodes() {
    setError(null);
    setLoading(true);
    try {
      const rc = await regenerateRecoveryCodes();
      setRecoveryCodes(rc.codes);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Regeneration failed');
    } finally {
      setLoading(false);
    }
  }

  function handleCancelSetup() {
    setSetupData(null);
    setTotpInput('');
    setRecoveryCodes(null);
    setError(null);
  }

  function handleDissmissRecovery() {
    setRecoveryCodes(null);
  }

  if (enabled === null) {
    return (
      <div className="totp-section">
        <h2>Two-Factor Authentication</h2>
        <p style={{ color: '#6b7280' }}>Loading...</p>
      </div>
    );
  }

  return (
    <div className="totp-section">
      <h2>Two-Factor Authentication</h2>

      {error && (
        <div style={{ background: '#fef2f2', color: '#dc2626', padding: '8px 12px', borderRadius: 6, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {!enabled && !setupData && (
        <div>
          <p style={{ color: '#6b7280' }}>2FA is not enabled. Add an extra layer of security to your admin account.</p>
          <button
            onClick={handleStartSetup}
            disabled={loading}
            style={{ padding: '10px 20px', background: '#2563eb', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}
          >
            {loading ? 'Starting...' : 'Enable 2FA'}
          </button>
        </div>
      )}

      {enabled && !setupData && !showDisable && (
        <div>
          <p style={{ color: '#059669', fontWeight: 600 }}>2FA is enabled</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setShowDisable(true)}
              style={{ padding: '8px 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}
            >
              Disable 2FA
            </button>
            <button
              onClick={handleRegenerateCodes}
              disabled={loading}
              style={{ padding: '8px 16px', background: '#6b7280', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}
            >
              Regenerate Recovery Codes
            </button>
          </div>
        </div>
      )}

      {showDisable && (
        <div style={{ marginTop: 12 }}>
          <p style={{ color: '#dc2626', fontWeight: 600 }}>Enter your current TOTP code to disable 2FA.</p>
          <input
            type="text"
            maxLength={6}
            placeholder="000000"
            value={disableInput}
            onChange={(e) => setDisableInput(e.target.value.replace(/\D/g, ''))}
            style={{ padding: '8px 12px', fontSize: 18, width: '120px', textAlign: 'center', letterSpacing: 4, borderRadius: 8, border: '1px solid #d1d5db', marginRight: 8 }}
          />
          <button
            onClick={handleDisable}
            disabled={loading || disableInput.length !== 6}
            style={{ padding: '8px 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}
          >
            {loading ? 'Disabling...' : 'Confirm Disable'}
          </button>
          <button
            onClick={() => { setShowDisable(false); setDisableInput(''); }}
            style={{ marginLeft: 8, padding: '8px 16px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}
          >
            Cancel
          </button>
        </div>
      )}

      {setupData && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontWeight: 600 }}>Step 1: Scan this QR code with your authenticator app</p>
          <img
            src={setupData.qrDataUrl}
            alt="TOTP QR Code"
            style={{ display: 'block', margin: '12px 0', border: '1px solid #e5e7eb', borderRadius: 8 }}
          />
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
            Or enter this secret manually: <code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 }}>{setupData.secret}</code>
          </p>

          <p style={{ fontWeight: 600 }}>Step 2: Enter the 6-digit code from your app</p>
          <input
            type="text"
            maxLength={6}
            placeholder="000000"
            value={totpInput}
            onChange={(e) => setTotpInput(e.target.value.replace(/\D/g, ''))}
            style={{ padding: '8px 12px', fontSize: 18, width: '120px', textAlign: 'center', letterSpacing: 4, borderRadius: 8, border: '1px solid #d1d5db', marginRight: 8 }}
          />
          <button
            onClick={handleVerifySetup}
            disabled={loading || totpInput.length !== 6}
            style={{ padding: '8px 20px', background: '#059669', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}
          >
            {loading ? 'Verifying...' : 'Verify & Enable'}
          </button>
          <button
            onClick={handleCancelSetup}
            style={{ marginLeft: 8, padding: '8px 20px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}
          >
            Cancel
          </button>
        </div>
      )}

      {recoveryCodes && recoveryCodes.length > 0 && (
        <div style={{ marginTop: 16, background: '#fefce8', padding: '12px 16px', borderRadius: 8, border: '1px solid #fde68a' }}>
          <p style={{ fontWeight: 600, color: '#92400e', marginTop: 0 }}>
            Recovery Codes — save these somewhere safe!
          </p>
          <p style={{ fontSize: 13, color: '#92400e', marginBottom: 8 }}>
            Each code can be used once to bypass 2FA if you lose access to your authenticator app.
          </p>
          <div style={{ fontFamily: 'monospace', fontSize: 14, background: '#fff', padding: '8px 12px', borderRadius: 6 }}>
            {recoveryCodes.map((code) => (
              <div key={code}>{code}</div>
            ))}
          </div>
          <button
            onClick={handleDissmissRecovery}
            style={{ marginTop: 8, padding: '6px 16px', background: '#92400e', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
          >
            I've saved these
          </button>
        </div>
      )}
    </div>
  );
}
