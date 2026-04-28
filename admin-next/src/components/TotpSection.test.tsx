import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { TotpSection } from './TotpSection';

vi.mock('../api/adminApi', () => ({
  fetchTotpStatus: vi.fn(),
  setupTotp: vi.fn(),
  verifyTotpSetup: vi.fn(),
  disableTotp: vi.fn(),
  fetchRecoveryCodes: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
}));

import * as api from '../api/adminApi';

describe('TotpSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fetchTotpStatus).mockResolvedValue({ enabled: false });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows "Enable 2FA" button when 2FA is disabled', async () => {
    render(<TotpSection />);

    await waitFor(() => {
      expect(screen.getByText('Enable 2FA')).toBeDefined();
    });
  });

  it('shows "2FA is enabled" when TOTP is active', async () => {
    vi.mocked(api.fetchTotpStatus).mockResolvedValue({ enabled: true });
    render(<TotpSection />);

    await waitFor(() => {
      expect(screen.getByText('2FA is enabled')).toBeDefined();
    });
  });

  it('starts setup flow when Enable 2FA is clicked', async () => {
    vi.mocked(api.setupTotp).mockResolvedValue({
      secret: 'TESTSECRET123',
      qrDataUrl: 'data:image/png;base64,test',
    });
    render(<TotpSection />);

    await waitFor(() => screen.getByText('Enable 2FA'));
    fireEvent.click(screen.getByText('Enable 2FA'));

    await waitFor(() => {
      expect(screen.getByText(/TESTSECRET123/)).toBeDefined();
      expect(screen.getByText('Verify & Enable')).toBeDefined();
    });
  });

  it('shows disable form when Disable 2FA is clicked', async () => {
    vi.mocked(api.fetchTotpStatus).mockResolvedValue({ enabled: true });
    render(<TotpSection />);

    await waitFor(() => screen.getByText('Disable 2FA'));
    fireEvent.click(screen.getByText('Disable 2FA'));

    await waitFor(() => {
      expect(screen.getByText('Confirm Disable')).toBeDefined();
    });
  });
});
