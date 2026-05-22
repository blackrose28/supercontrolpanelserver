import { WorkerAdminApiTokenScope } from './db/d1-admin-api-token-store';

export type WorkerEnv = {
  CC_DB?: unknown;
  CC_BOOTSTRAP_TOKEN?: string;
  CC_ADMIN_API_TOKEN?: string;
  CC_ADMIN_PASSWORD?: string;
  CC_TOTP_ENCRYPTION_KEY?: string;
  CC_AGENT_DO?: DurableObjectNamespaceLike;
  CC_ADMIN_PTY_HUB?: DurableObjectNamespaceLike;
  now?: () => number;
  uuid?: () => string;
  sessionTokenFactory?: () => string;
  csrfTokenFactory?: () => string;
  streamPollMs?: number;
  requestSlowLogMs?: number;
};

export type AdminPrincipal =
  | { kind: 'session' }
  | { kind: 'env-token' }
  | { kind: 'db-token'; tokenId: string; scopes: WorkerAdminApiTokenScope[] };

export type DurableObjectNamespaceLike = {
  idFromName: (name: string) => unknown;
  get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
};

export type DurableObjectStateLike = {
  acceptWebSocket?: (socket: WebSocket, tags?: string[]) => void;
  getWebSockets?: (tag?: string) => WebSocket[];
};

export type WorkerExecutionContext = {
  waitUntil?: (promise: Promise<unknown>) => void;
  passThroughOnException?: () => void;
};
