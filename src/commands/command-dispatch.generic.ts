import { AdminAuthPrincipal } from '../admin/admin-auth';
import { AgentGateway } from '../agent/agent.gateway';
import { readRequiredServerId } from './command-dispatch.parsers';
import { DispatchSafeInput } from './command-dispatch.types';

export type DispatchGenericDeps = {
  agentGateway: AgentGateway;
  dispatchSafeCommand: (input: DispatchSafeInput) => Record<string, unknown>;
};

export function dispatchGenericCommandGroup(input: {
  deviceId: string;
  commandType: string;
  requestedCommandId?: string;
  payload: unknown;
  principal: AdminAuthPrincipal;
}, deps: DispatchGenericDeps) {
  const { deviceId, commandType, requestedCommandId, payload, principal } = input;

  switch (commandType) {
    case 'request_status_snapshot':
      return deps.dispatchSafeCommand({
        deviceId,
        commandType,
        requestedCommandId,
        payload: null,
        payloadSummary: 'Request fresh status snapshot',
        principal,
        dispatch: (commandId) => deps.agentGateway.requestStatusSnapshot(deviceId, commandId),
      });
    case 'request_inventory':
      return deps.dispatchSafeCommand({
        deviceId,
        commandType,
        requestedCommandId,
        payload: null,
        payloadSummary: 'Request inventory',
        principal,
        dispatch: (commandId) => deps.agentGateway.requestInventory(deviceId, commandId),
      });
    case 'request_recent_logs':
      return deps.dispatchSafeCommand({
        deviceId,
        commandType,
        requestedCommandId,
        payload: null,
        payloadSummary: 'Request recent logs',
        principal,
        dispatch: (commandId) => deps.agentGateway.requestRecentLogs(deviceId, commandId),
      });
    case 'restart_openvpn':
      return deps.dispatchSafeCommand({
        deviceId,
        commandType,
        requestedCommandId,
        payload: null,
        payloadSummary: 'Restart OpenVPN',
        principal,
        dispatch: (commandId) => deps.agentGateway.requestRestartOpenvpn(deviceId, commandId),
      });
    case 'restart_boundary_auth':
      return deps.dispatchSafeCommand({
        deviceId,
        commandType,
        requestedCommandId,
        payload: null,
        payloadSummary: 'Restart Boundary auth',
        principal,
        dispatch: (commandId) => deps.agentGateway.requestRestartBoundaryAuth(deviceId, commandId),
      });
    case 'restart_server_tunnel': {
      const serverId = readRequiredServerId(payload);
      return deps.dispatchSafeCommand({
        deviceId,
        commandType,
        requestedCommandId,
        payload: { serverId },
        payloadSummary: `Restart server tunnel for ${serverId}`,
        principal,
        dispatch: (commandId) => deps.agentGateway.requestRestartServerTunnel(deviceId, serverId, commandId),
      });
    }
    case 'restart_server_ssh': {
      const serverId = readRequiredServerId(payload);
      return deps.dispatchSafeCommand({
        deviceId,
        commandType,
        requestedCommandId,
        payload: { serverId },
        payloadSummary: `Restart server SSH for ${serverId}`,
        principal,
        dispatch: (commandId) => deps.agentGateway.requestRestartServerSsh(deviceId, serverId, commandId),
      });
    }
    default:
      return null;
  }
}
