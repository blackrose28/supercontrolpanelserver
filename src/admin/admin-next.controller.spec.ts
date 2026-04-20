import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminNextController } from './admin-next.controller';

describe('AdminNextController', () => {
  const adminSessions = {
    isValid: vi.fn(),
  } as any;

  let controller: AdminNextController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new AdminNextController(adminSessions);
  });

  function createRes() {
    return {
      redirect: vi.fn(),
      render: vi.fn(),
      cookie: vi.fn(),
      setHeader: vi.fn(),
    } as any;
  }

  it('renders admin-next shell for authorized session', () => {
    adminSessions.isValid.mockReturnValue(true);
    const res = createRes();

    controller.index(undefined, 'cc_admin_session=ok', res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.render).toHaveBeenCalledWith('admin-next', expect.objectContaining({
      csrfToken: expect.any(String),
      scriptSrc: expect.stringMatching(/^\/admin-next\/(assets\/.*\.js|index\.js)$/),
      stylesheets: expect.any(Array),
    }));

    const renderPayload = res.render.mock.calls[0][1];
    expect(renderPayload.scriptSrc).not.toBe('/admin-next/index.js');
  });

  it('redirects to login for unauthorized session', () => {
    adminSessions.isValid.mockReturnValue(false);
    const res = createRes();

    controller.index(undefined, undefined, res);

    expect(res.redirect).toHaveBeenCalledWith('/admin/login');
    expect(res.render).not.toHaveBeenCalled();
  });

  it('serves shell for nested /admin-next paths', () => {
    adminSessions.isValid.mockReturnValue(true);
    const res = createRes();

    controller.fallback('devices/abc', undefined, 'cc_admin_session=ok', res);

    expect(res.render).toHaveBeenCalledWith('admin-next', expect.objectContaining({
      csrfToken: expect.any(String),
    }));
  });
});
