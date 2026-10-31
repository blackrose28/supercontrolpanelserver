import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileOpsController } from './file-ops.controller';

describe('FileOpsController transfer history', () => {
  const deviceStore = {
    getDevice: vi.fn(),
  } as any;
  const fileTransferStore = {
    listByDevice: vi.fn(),
  } as any;
  const fileOpSloService = {} as any;
  const agentGateway = {} as any;
  const adminSessions = {
    isValid: vi.fn(() => true),
  } as any;
  const adminApiTokens = {
    authenticateToken: vi.fn(() => null),
  } as any;

  let controller: FileOpsController;

  beforeEach(() => {
    vi.clearAllMocks();
    deviceStore.getDevice.mockReturnValue({ deviceId: 'dev-1' });
    fileTransferStore.listByDevice.mockReturnValue([
      { transferId: 'tr-1', deviceId: 'dev-1', direction: 'upload', state: 'running' },
    ]);
    controller = new FileOpsController(
      deviceStore,
      fileTransferStore,
      fileOpSloService,
      agentGateway,
      adminSessions,
      adminApiTokens,
    );
  });

  it('returns transfer history in the admin UI response envelope', () => {
    const result = controller.listTransfers(
      undefined,
      'cc_admin_session=session',
      'dev-1',
      '25',
    );

    expect(result).toEqual({
      items: [{ transferId: 'tr-1', deviceId: 'dev-1', direction: 'upload', state: 'running' }],
    });
    expect(fileTransferStore.listByDevice).toHaveBeenCalledWith('dev-1', 25);
  });
});
