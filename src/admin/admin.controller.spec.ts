import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AdminController } from './admin.controller';
import { initAdminPasswordHash } from '../config/auth';

describe('AdminController admin pages', () => {
  const deviceStore = {
    getAllDevices: vi.fn(() => [
      { id: 'dev-1', status: 'connected' },
      { id: 'dev-2', status: 'disconnected' },
    ]),
  } as any;

  const logStore = {
    getAllRuntimeSummaries: vi.fn(() => []),
  } as any;

  const fileTransferStore = {
    listActive: vi.fn(() => []),
  } as any;

  const adminSessions = {
    isValid: vi.fn(),
  } as any;

  const adminApiTokens = {
    listTokens: vi.fn(() => []),
  } as any;

  const rateLimitService = {
    check: vi.fn(),
    loginLimit: vi.fn(() => 5),
    loginWindowMs: vi.fn(() => 60_000),
  } as any;

  const lockoutService = {
    checkLockout: vi.fn(() => ({ allowed: true, retryAfterMs: 0, failureCount: 0, lockedOut: false })),
    recordFailure: vi.fn(),
    resetLockout: vi.fn(),
  } as any;

  const totpService = {
    generateSetup: vi.fn(),
    verifyAndEnable: vi.fn(),
    verify: vi.fn(),
    disable: vi.fn(),
    isEnabled: vi.fn(),
  } as any;

  const auditService = {
    log: vi.fn(),
    list: vi.fn(() => []),
  } as any;

  let controller: AdminController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AdminController(
      deviceStore,
      logStore,
      fileTransferStore,
      adminSessions,
      adminApiTokens,
      rateLimitService,
      lockoutService,
      totpService,
      auditService,
    );
  });

  afterEach(() => {
    delete process.env.CC_ADMIN_PASSWORD;
  });

  function createRes() {
    return {
      redirect: vi.fn(),
      render: vi.fn(),
      cookie: vi.fn(),
      clearCookie: vi.fn(),
    } as any;
  }

  function createReq() {
    return {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as any;
  }

  it('redirects to root after successful login', () => {
    const res = createRes();
    const csrfCookie = 'cc_admin_csrf=test-token';
    process.env.CC_ADMIN_PASSWORD = 'admin';
    initAdminPasswordHash();
    adminSessions.createSession = vi.fn(() => 'session-token');
    adminSessions.getTtlMs = vi.fn(() => 60_000);

    controller.login('admin', 'test-token', csrfCookie, createReq(), res);

    expect(res.redirect).toHaveBeenCalledWith('/');
  });

  describe('TOTP endpoints', () => {
    it('GET /admin/totp/status returns enabled=false when TOTP not set up', () => {
      totpService.isEnabled.mockReturnValue(false);
      adminSessions.isValid.mockReturnValue(true);

      const result = controller.getTotpStatus('cc_admin_session=ok');

      expect(result).toEqual({ enabled: false });
    });

    it('GET /admin/totp/status requires admin session', () => {
      adminSessions.isValid.mockReturnValue(false);

      expect(() => controller.getTotpStatus(undefined)).toThrow();
    });
  });

  describe('TOTP login flow', () => {
    it('returns totp-required when login succeeds and 2FA is enabled', () => {
      const res = createRes();
      const csrfCookie = 'cc_admin_csrf=test-token';
      process.env.CC_ADMIN_PASSWORD = 'admin';
      initAdminPasswordHash();
      totpService.isEnabled.mockReturnValue(true);

      controller.login('admin', 'test-token', csrfCookie, createReq(), res);

      // Should not create a full session yet
      expect(res.redirect).not.toHaveBeenCalledWith('/');
      // Should set a temporary cookie and redirect to TOTP page
      expect(res.cookie).toHaveBeenCalledWith(
        expect.stringContaining('totp'),
        expect.any(String),
        expect.objectContaining({ maxAge: expect.any(Number) }),
      );
    });

    it('creates session directly when 2FA is not enabled', () => {
      const res = createRes();
      const csrfCookie = 'cc_admin_csrf=test-token';
      process.env.CC_ADMIN_PASSWORD = 'admin';
      initAdminPasswordHash();
      totpService.isEnabled.mockReturnValue(false);
      adminSessions.createSession = vi.fn(() => 'session-token');
      adminSessions.getTtlMs = vi.fn(() => 60_000);

      controller.login('admin', 'test-token', csrfCookie, createReq(), res);

      expect(res.redirect).toHaveBeenCalledWith('/');
    });
  });
});
