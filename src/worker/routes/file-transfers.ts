import type { WorkerEnv } from '../types';
import { D1FileTransferStore, D1RemoteBrowserSessionStore } from '../db/d1-file-op-store';
import { D1CommandStore } from '../db/d1-command-store';
import { nowMs, makeUuid } from '../env-helpers';
import { jsonResponse, clampNumber, sseFrame, sseStreamResponse, streamPollMs } from '../http';
import {
  requireAdminAndDevice,
  requireAdminDeviceFromBody,
  adminActorType,
  adminActorId,
} from '../auth';
import type { AdminPrincipal } from '../types';
import { publicCommand, notifyAgentDurableObject } from '../agent-transport';

export function isFinishedTransferState(state: string): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'canceled';
}

async function requireTransferFromBody(request: Request, env: WorkerEnv): Promise<{ db: any; store: D1FileTransferStore; deviceId: string; transferId: string; transfer: Awaited<ReturnType<D1FileTransferStore['get']>>; principal: AdminPrincipal } | Response> {
  const required = await requireAdminDeviceFromBody(request, env);
  if (required instanceof Response) return required;
  const transferId = typeof required.body.transferId === 'string' ? required.body.transferId.trim() : '';
  if (!transferId) return jsonResponse({ error: 'transferId is required' }, { status: 400 });
  const store = new D1FileTransferStore(required.db);
  const transfer = await store.get(transferId);
  if (!transfer || transfer.deviceId !== required.deviceId) return jsonResponse({ error: 'Transfer not found' }, { status: 404 });
  return { db: required.db, store, deviceId: required.deviceId, transferId, transfer, principal: required.principal };
}

export async function handleListFileTransfers(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'), ['device:read']);
  if (required instanceof Response) return required;
  const limit = clampNumber(url.searchParams.get('limit'), 100, 1, 1000);
  return jsonResponse({ items: await new D1FileTransferStore(required.db).listByDevice(required.deviceId, limit) });
}

export async function handleDismissFileTransfer(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireTransferFromBody(request, env);
  if (required instanceof Response) return required;
  if (!isFinishedTransferState(required.transfer!.state)) {
    return jsonResponse({ code: 'transfer_not_finished', message: 'Only finished transfers can be dismissed' }, { status: 409 });
  }
  await required.store.deleteAny(required.transferId);
  return jsonResponse({ ok: true, transferId: required.transferId });
}

export async function handleForceRemoveFileTransfer(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireTransferFromBody(request, env);
  if (required instanceof Response) return required;
  await required.store.deleteAny(required.transferId);
  return jsonResponse({ ok: true, transferId: required.transferId, forced: !isFinishedTransferState(required.transfer!.state) });
}

export async function handleStopFileTransfer(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireTransferFromBody(request, env);
  if (required instanceof Response) return required;
  if (isFinishedTransferState(required.transfer!.state)) {
    return jsonResponse({ code: 'transfer_already_finished', message: 'Transfer is already finished' }, { status: 409 });
  }
  const now = new Date(nowMs(env)).toISOString();
  const actorType = adminActorType(required.principal);
  const actorId = adminActorId(required.principal);
  const commands = new D1CommandStore(required.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(env), commandId: makeUuid(env), deviceId: required.deviceId,
    commandType: 'stop_file_transfer', actorType, actorId,
    payload: { transferId: required.transferId },
    payloadSummary: `Stop file transfer ${required.transferId}`, submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(required.deviceId);
  command = await commands.markDispatched(command.commandId, reqSeq, now);
  const transfer = await required.store.markState(required.transferId, 'canceled', now, { message: 'Stop requested by admin' });
  await notifyAgentDurableObject(env, required.deviceId, publicCommand(command), now);
  return jsonResponse({ ok: true, transferId: required.transferId, state: transfer.state, command });
}

export async function handleDismissFinishedFileTransfers(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminDeviceFromBody(request, env);
  if (required instanceof Response) return required;
  const result = await new D1FileTransferStore(required.db).deleteFinishedByDevice(required.deviceId);
  return jsonResponse({ ok: true, deletedCount: result.deletedCount });
}

export async function handleTransfersStream(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const required = await requireAdminAndDevice(request, env, url.searchParams.get('deviceId'), ['device:read']);
  if (required instanceof Response) return required;
  const store = new D1FileTransferStore(required.db);
  const limit = clampNumber(url.searchParams.get('limit'), 100, 1, 500);
  const transfers = await store.listByDevice(required.deviceId, limit);
  let seen = new Map(transfers.map((transfer) => [transfer.transferId, JSON.stringify(transfer)]));
  return sseStreamResponse([], {
    intervalMs: streamPollMs(env),
    next: async () => {
      const current = await store.listByDevice(required.deviceId, limit);
      const nextSeen = new Map<string, string>();
      const changed = current.filter((transfer) => {
        const serialized = JSON.stringify(transfer);
        nextSeen.set(transfer.transferId, serialized);
        if (seen.get(transfer.transferId) === serialized) return false;
        return true;
      });
      seen = nextSeen;
      return changed.reverse().map((transfer) => sseFrame('file_transfer', transfer));
    },
  });
}

export const remoteBrowserCommandByPath: Record<string, { commandType: string; requiresPath: boolean; closes?: boolean; updatesCurrentPath?: boolean }> = {
  '/v1/file-ops/remote-browser/list': { commandType: 'list_remote_browser_children', requiresPath: true, updatesCurrentPath: true },
  '/v1/file-ops/remote-browser/stat': { commandType: 'stat_remote_browser_path', requiresPath: true },
  '/v1/file-ops/remote-browser/mkdir': { commandType: 'create_remote_browser_directory', requiresPath: true },
  '/v1/file-ops/remote-browser/delete': { commandType: 'delete_remote_browser_path', requiresPath: true },
  '/v1/file-ops/remote-browser/close': { commandType: 'close_remote_browser', requiresPath: false, closes: true },
};

export async function handleOpenRemoteBrowser(request: Request, env: WorkerEnv): Promise<Response> {
  const required = await requireAdminDeviceFromBody(request, env);
  if (required instanceof Response) return required;
  const serverId = typeof required.body.serverId === 'string' ? required.body.serverId.trim() : '';
  if (!serverId) return jsonResponse({ error: 'serverId is required' }, { status: 400 });
  const rootPath = typeof required.body.rootPath === 'string' && required.body.rootPath.trim() ? required.body.rootPath.trim() : null;
  const now = new Date(nowMs(env)).toISOString();
  const actorType = adminActorType(required.principal);
  const actorId = adminActorId(required.principal);
  const browserId = typeof required.body.browserId === 'string' && required.body.browserId.trim() ? required.body.browserId.trim() : makeUuid(env);
  const browser = await new D1RemoteBrowserSessionStore(required.db).createOpening({
    id: makeUuid(env), browserSessionId: browserId, deviceId: required.deviceId,
    serverId, actorType, actorId, openedAt: now, rootPath,
  });
  const commandId = makeUuid(env);
  const commands = new D1CommandStore(required.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(env), commandId, deviceId: required.deviceId,
    commandType: 'open_remote_browser', actorType, actorId,
    payload: { browserId, serverId, rootPath },
    payloadSummary: `Open remote browser ${browserId}`, submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(required.deviceId);
  command = await commands.markDispatched(commandId, reqSeq, now);
  await notifyAgentDurableObject(env, required.deviceId, publicCommand(command), now);
  return jsonResponse({
    browserId: browser.browserSessionId, deviceId: browser.deviceId,
    serverId: browser.serverId, state: browser.state,
    rootPath: browser.rootPath, command,
  });
}

export async function handleRemoteBrowserCommand(request: Request, env: WorkerEnv, routePath: string): Promise<Response> {
  const config = remoteBrowserCommandByPath[routePath];
  const required = await requireAdminDeviceFromBody(request, env);
  if (required instanceof Response) return required;
  const browserId = typeof required.body.browserId === 'string' ? required.body.browserId.trim() : '';
  if (!browserId) return jsonResponse({ error: 'browserId is required' }, { status: 400 });
  const path = typeof required.body.path === 'string' && required.body.path.trim() ? required.body.path.trim() : '';
  if (config.requiresPath && !path) return jsonResponse({ error: 'path is required' }, { status: 400 });
  const store = new D1RemoteBrowserSessionStore(required.db);
  const existing = await store.get(browserId);
  if (!existing || existing.deviceId !== required.deviceId) return jsonResponse({ error: 'Remote browser session not found' }, { status: 404 });
  if (!['opening', 'open'].includes(existing.state)) return jsonResponse({ error: 'Remote browser session is not active' }, { status: 409 });
  const now = new Date(nowMs(env)).toISOString();
  const actorType = adminActorType(required.principal);
  const actorId = adminActorId(required.principal);
  const payload: Record<string, unknown> = { browserId };
  if (path) payload.path = path;
  if (routePath.endsWith('/delete')) payload.recursive = Boolean(required.body.recursive);
  const commands = new D1CommandStore(required.db);
  let command = await commands.createQueuedCommand({
    id: makeUuid(env), commandId: makeUuid(env), deviceId: required.deviceId,
    commandType: config.commandType, actorType, actorId, payload,
    payloadSummary: `${config.commandType} ${browserId}`, submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(required.deviceId);
  command = await commands.markDispatched(command.commandId, reqSeq, now);
  await notifyAgentDurableObject(env, required.deviceId, publicCommand(command), now);
  const browser = config.closes
    ? await store.markClosed(browserId, now, 'Admin closed remote browser session')
    : config.updatesCurrentPath
      ? await store.noteActivity(browserId, now, path)
      : await store.noteActivity(browserId, now);
  return jsonResponse({ ok: true, browserId, state: browser.state, command });
}

export async function handleStartScpTransfer(request: Request, env: WorkerEnv, direction: 'upload' | 'download'): Promise<Response> {
  const required = await requireAdminDeviceFromBody(request, env);
  if (required instanceof Response) return required;
  const serverId = typeof required.body.serverId === 'string' ? required.body.serverId.trim() : '';
  const localPath = typeof required.body.localPath === 'string' ? required.body.localPath.trim() : '';
  const remotePath = typeof required.body.remotePath === 'string' ? required.body.remotePath.trim() : '';
  if (!serverId) return jsonResponse({ error: 'serverId is required' }, { status: 400 });
  if (!localPath) return jsonResponse({ error: 'localPath is required' }, { status: 400 });
  if (!remotePath) return jsonResponse({ error: 'remotePath is required' }, { status: 400 });
  const now = new Date(nowMs(env)).toISOString();
  const actorType = adminActorType(required.principal);
  const actorId = adminActorId(required.principal);
  const transferId = typeof required.body.transferId === 'string' && required.body.transferId.trim() ? required.body.transferId.trim() : makeUuid(env);
  const transfer = await new D1FileTransferStore(required.db).create({
    id: makeUuid(env), transferId, deviceId: required.deviceId,
    serverId, direction, actorType, actorId,
    localPath, remotePath, recursive: Boolean(required.body.recursive), ts: now,
  });
  const commandId = makeUuid(env);
  const commandType = direction === 'upload' ? 'start_scp_upload' : 'start_scp_download';
  const payload = { transferId, serverId, localPath, remotePath, recursive: Boolean(required.body.recursive) };
  const commands = new D1CommandStore(required.db);
  let command = await commands.createQueuedCommand({
    id: commandId, commandId, deviceId: required.deviceId,
    commandType, actorType, actorId, payload,
    payloadSummary: `${commandType} ${transferId}`, submittedAt: now,
  });
  const reqSeq = await commands.nextReqSeq(required.deviceId);
  command = await commands.markDispatched(commandId, reqSeq, now);
  const updated = await new D1FileTransferStore(required.db).attachCommand(transferId, commandId, reqSeq, now);
  await notifyAgentDurableObject(env, required.deviceId, publicCommand(command), now);
  return jsonResponse(updated ?? transfer);
}
