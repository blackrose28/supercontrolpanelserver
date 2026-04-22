import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AdminController } from './admin.controller';

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
    );
  });

  function createRes() {
    return {
      redirect: vi.fn(),
      render: vi.fn(),
      cookie: vi.fn(),
    } as any;
  }

  it('keeps /admin/devices behavior for unauthorized requests', () => {
    adminSessions.isValid.mockReturnValue(false);
    const res = createRes();

    controller.html(undefined, undefined, res);

    expect(res.redirect).toHaveBeenCalledWith('/admin/login');
    expect(res.render).not.toHaveBeenCalled();
  });

  it('keeps /admin/devices behavior for authorized requests', () => {
    adminSessions.isValid.mockReturnValue(true);
    const res = createRes();

    controller.html(undefined, 'cc_admin_session=ok', res);

    expect(res.render).toHaveBeenCalledWith('devices', expect.objectContaining({
      csrfToken: expect.any(String),
      adminApiScopes: expect.any(Array),
      meta: expect.any(String),
    }));
  });

});
