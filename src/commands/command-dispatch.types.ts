import { AdminAuthPrincipal } from '../admin/admin-auth';

export type DispatchSafeResult = {
  ok: boolean;
  reason?: string;
  reqSeq?: number;
  requestedAt?: string;
};

export type DispatchSafeInput = {
  deviceId: string;
  commandType: string;
  requestedCommandId?: string;
  payload: unknown;
  payloadSummary: string;
  principal: AdminAuthPrincipal;
  dispatch: (commandId: string) => DispatchSafeResult;
};

export type ServiceDispatchSafeInput = Omit<DispatchSafeInput, 'commandType'> & {
  commandType: DispatchSafeInput['commandType'] | string;
};
