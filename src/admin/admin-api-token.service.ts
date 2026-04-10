import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { hashSecret } from '../config/secrets';

export const ADMIN_API_TOKEN_SCOPES = [
  'device:read',
  'device:control',
  'logs:read',
  'logs:export',
  'device:record',
] as const;

export type AdminApiTokenScope = (typeof ADMIN_API_TOKEN_SCOPES)[number];

export type AdminApiTokenRecord = {
  tokenId: string;
  label: string;
  scopes: AdminApiTokenScope[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

type CreateAdminApiTokenInput = {
  label: string;
  scopes: AdminApiTokenScope[];
  ttlDays?: number;
};

@Injectable()
export class AdminApiTokenService {
  private readonly defaultTtlDays = 90;
  private readonly maxTtlDays = 365;

  constructor(private readonly databaseService: DatabaseService) {
    this.pruneExpired();
  }

  createToken(input: CreateAdminApiTokenInput): AdminApiTokenRecord & { token: string } {
    this.pruneExpired();
    const now = Date.now();
    const ttlDays = this.normalizeTtlDays(input.ttlDays);
    const tokenId = randomUUID();
    const token = this.generateToken();
    const record: AdminApiTokenRecord = {
      tokenId,
      label: input.label.trim(),
      scopes: this.normalizeScopes(input.scopes),
      createdAt: now,
      expiresAt: now + ttlDays * 24 * 60 * 60 * 1000,
      lastUsedAt: null,
      revokedAt: null,
    };

    this.databaseService.connection
      .prepare(
        `
          INSERT INTO admin_api_tokens (
            tokenId,
            tokenHash,
            label,
            scopesJson,
            createdAt,
            expiresAt,
            lastUsedAt,
            revokedAt
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        record.tokenId,
        hashSecret(token),
        record.label,
        JSON.stringify(record.scopes),
        record.createdAt,
        record.expiresAt,
        record.lastUsedAt,
        record.revokedAt,
      );

    return {
      ...record,
      token,
    };
  }

  listTokens(): AdminApiTokenRecord[] {
    this.pruneExpired();
    const rows = this.databaseService.connection
      .prepare(
        `
          SELECT tokenId, label, scopesJson, createdAt, expiresAt, lastUsedAt, revokedAt
          FROM admin_api_tokens
          ORDER BY createdAt DESC
        `,
      )
      .all() as Array<{
        tokenId: string;
        label: string;
        scopesJson: string;
        createdAt: number;
        expiresAt: number;
        lastUsedAt: number | null;
        revokedAt: number | null;
      }>;

    return rows.map((row) => this.mapRow(row));
  }

  revokeToken(tokenId: string): AdminApiTokenRecord | null {
    this.pruneExpired();
    const existing = this.findById(tokenId);
    if (!existing) {
      return null;
    }
    if (existing.revokedAt) {
      return existing;
    }
    const revokedAt = Date.now();
    this.databaseService.connection
      .prepare(`UPDATE admin_api_tokens SET revokedAt = ? WHERE tokenId = ?`)
      .run(revokedAt, tokenId);
    return this.findById(tokenId);
  }

  authenticateToken(token: string): AdminApiTokenRecord | null {
    this.pruneExpired();
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT tokenId, label, scopesJson, createdAt, expiresAt, lastUsedAt, revokedAt
          FROM admin_api_tokens
          WHERE tokenHash = ?
        `,
      )
      .get(hashSecret(token)) as
      | {
          tokenId: string;
          label: string;
          scopesJson: string;
          createdAt: number;
          expiresAt: number;
          lastUsedAt: number | null;
          revokedAt: number | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const record = this.mapRow(row);
    if (record.revokedAt || record.expiresAt <= Date.now()) {
      return null;
    }

    const lastUsedAt = Date.now();
    this.databaseService.connection
      .prepare(`UPDATE admin_api_tokens SET lastUsedAt = ? WHERE tokenId = ?`)
      .run(lastUsedAt, record.tokenId);

    return {
      ...record,
      lastUsedAt,
    };
  }

  private findById(tokenId: string): AdminApiTokenRecord | null {
    const row = this.databaseService.connection
      .prepare(
        `
          SELECT tokenId, label, scopesJson, createdAt, expiresAt, lastUsedAt, revokedAt
          FROM admin_api_tokens
          WHERE tokenId = ?
        `,
      )
      .get(tokenId) as
      | {
          tokenId: string;
          label: string;
          scopesJson: string;
          createdAt: number;
          expiresAt: number;
          lastUsedAt: number | null;
          revokedAt: number | null;
        }
      | undefined;

    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: {
    tokenId: string;
    label: string;
    scopesJson: string;
    createdAt: number;
    expiresAt: number;
    lastUsedAt: number | null;
    revokedAt: number | null;
  }): AdminApiTokenRecord {
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

  private generateToken(): string {
    return `ccadm_${randomBytes(24).toString('base64url')}`;
  }

  private normalizeScopes(scopes: unknown[]): AdminApiTokenScope[] {
    const allowed = new Set<AdminApiTokenScope>(ADMIN_API_TOKEN_SCOPES);
    const normalized = Array.from(
      new Set(
        scopes
          .map((scope) => String(scope).trim())
          .filter((scope): scope is AdminApiTokenScope => allowed.has(scope as AdminApiTokenScope)),
      ),
    );
    return normalized.length ? normalized : ['device:read'];
  }

  private normalizeTtlDays(ttlDays?: number): number {
    if (!Number.isFinite(ttlDays) || !ttlDays || ttlDays <= 0) {
      return this.defaultTtlDays;
    }
    return Math.min(Math.max(Math.floor(ttlDays), 1), this.maxTtlDays);
  }

  private pruneExpired() {
    this.databaseService.connection
      .prepare(`DELETE FROM admin_api_tokens WHERE expiresAt <= ?`)
      .run(Date.now());
  }
}
