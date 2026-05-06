import { hashSecret } from './worker-secrets';
import { D1LikeDatabase } from './d1-device-store';

export const WORKER_ADMIN_API_TOKEN_SCOPES = [
  'device:read',
  'device:control',
  'logs:read',
  'logs:export',
  'device:record',
  'audit:read',
] as const;

export type WorkerAdminApiTokenScope = (typeof WORKER_ADMIN_API_TOKEN_SCOPES)[number];

export type WorkerAdminApiTokenRecord = {
  tokenId: string;
  label: string;
  scopes: WorkerAdminApiTokenScope[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

type CreateWorkerAdminApiTokenInput = {
  label: string;
  scopes: WorkerAdminApiTokenScope[];
  ttlDays?: number;
};

type TokenRow = {
  tokenId: string;
  label: string;
  scopesJson: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

type TokenStoreOptions = {
  now?: () => number;
  tokenIdFactory?: () => string;
  tokenFactory?: () => string;
};

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomAdminToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return `ccadm_${base64Url(bytes)}`;
}

export class D1AdminApiTokenStore {
  private readonly now: () => number;
  private readonly tokenIdFactory: () => string;
  private readonly tokenFactory: () => string;
  private readonly defaultTtlDays = 90;
  private readonly maxTtlDays = 365;

  constructor(private readonly db: D1LikeDatabase, opts: TokenStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.tokenIdFactory = opts.tokenIdFactory ?? (() => globalThis.crypto.randomUUID());
    this.tokenFactory = opts.tokenFactory ?? randomAdminToken;
  }

  async createToken(input: CreateWorkerAdminApiTokenInput): Promise<WorkerAdminApiTokenRecord & { token: string }> {
    await this.pruneExpired();
    const now = this.now();
    const ttlDays = this.normalizeTtlDays(input.ttlDays);
    const token = this.tokenFactory();
    const record: WorkerAdminApiTokenRecord = {
      tokenId: this.tokenIdFactory(),
      label: input.label.trim(),
      scopes: this.normalizeScopes(input.scopes),
      createdAt: now,
      expiresAt: now + ttlDays * 24 * 60 * 60 * 1000,
      lastUsedAt: null,
      revokedAt: null,
    };

    await this.db
      .prepare(`
        INSERT INTO admin_api_tokens (tokenId, tokenHash, label, scopesJson, createdAt, expiresAt, lastUsedAt, revokedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(record.tokenId, await hashSecret(token), record.label, JSON.stringify(record.scopes), record.createdAt, record.expiresAt, null, null)
      .run();

    return { ...record, token };
  }

  async listTokens(): Promise<WorkerAdminApiTokenRecord[]> {
    await this.pruneExpired();
    const { results = [] } = await this.db
      .prepare('SELECT tokenId, label, scopesJson, createdAt, expiresAt, lastUsedAt, revokedAt FROM admin_api_tokens ORDER BY createdAt DESC')
      .all<TokenRow>();
    return results.map((row) => this.mapRow(row));
  }

  async revokeToken(tokenId: string): Promise<WorkerAdminApiTokenRecord | null> {
    await this.pruneExpired();
    const existing = await this.findById(tokenId);
    if (!existing) {
      return null;
    }
    if (existing.revokedAt) {
      return existing;
    }
    await this.db.prepare('UPDATE admin_api_tokens SET revokedAt = ? WHERE tokenId = ?').bind(this.now(), tokenId).run();
    return this.findById(tokenId);
  }

  async authenticateToken(token: string): Promise<WorkerAdminApiTokenRecord | null> {
    await this.pruneExpired();
    const row = await this.db
      .prepare('SELECT tokenId, label, scopesJson, createdAt, expiresAt, lastUsedAt, revokedAt FROM admin_api_tokens WHERE tokenHash = ?')
      .bind(await hashSecret(token))
      .first<TokenRow>();
    if (!row) {
      return null;
    }
    const record = this.mapRow(row);
    if (record.revokedAt || record.expiresAt <= this.now()) {
      return null;
    }
    const lastUsedAt = this.now();
    await this.db.prepare('UPDATE admin_api_tokens SET lastUsedAt = ? WHERE tokenId = ?').bind(lastUsedAt, record.tokenId).run();
    return { ...record, lastUsedAt };
  }

  private async findById(tokenId: string): Promise<WorkerAdminApiTokenRecord | null> {
    const row = await this.db
      .prepare('SELECT tokenId, label, scopesJson, createdAt, expiresAt, lastUsedAt, revokedAt FROM admin_api_tokens WHERE tokenId = ?')
      .bind(tokenId)
      .first<TokenRow>();
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: TokenRow): WorkerAdminApiTokenRecord {
    let parsedScopes: unknown = [];
    try {
      parsedScopes = JSON.parse(row.scopesJson);
    } catch {
      parsedScopes = [];
    }
    return {
      tokenId: row.tokenId,
      label: row.label,
      scopes: this.normalizeScopes(Array.isArray(parsedScopes) ? parsedScopes : []),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt ?? null,
      revokedAt: row.revokedAt ?? null,
    };
  }

  private normalizeScopes(scopes: unknown[]): WorkerAdminApiTokenScope[] {
    const allowed = new Set<WorkerAdminApiTokenScope>(WORKER_ADMIN_API_TOKEN_SCOPES);
    const normalized = Array.from(new Set(scopes.map((scope) => String(scope).trim()).filter((scope): scope is WorkerAdminApiTokenScope => allowed.has(scope as WorkerAdminApiTokenScope))));
    return normalized.length ? normalized : ['device:read'];
  }

  private normalizeTtlDays(ttlDays?: number): number {
    if (!Number.isFinite(ttlDays) || !ttlDays || ttlDays <= 0) {
      return this.defaultTtlDays;
    }
    return Math.min(Math.max(Math.floor(ttlDays), 1), this.maxTtlDays);
  }

  private async pruneExpired(): Promise<void> {
    await this.db.prepare('DELETE FROM admin_api_tokens WHERE expiresAt <= ?').bind(this.now()).run();
  }
}
