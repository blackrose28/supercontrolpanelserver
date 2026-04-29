import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { D1_SCHEMA_SQL } from './d1-schema';
import { D1AdminApiTokenStore } from './d1-admin-api-token-store';

class TestD1PreparedStatement {
  private params: unknown[] = [];
  constructor(private readonly statement: Database.Statement) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  async run() { this.statement.run(...this.params); return { success: true }; }
  async first<T = unknown>() { return (this.statement.get(...this.params) ?? null) as T | null; }
  async all<T = unknown>() { return { results: this.statement.all(...this.params) as T[] }; }
}

class TestD1Database {
  readonly sqlite = new Database(':memory:');
  constructor() { this.sqlite.exec(D1_SCHEMA_SQL); }
  prepare(sql: string) { return new TestD1PreparedStatement(this.sqlite.prepare(sql)); }
  close() { this.sqlite.close(); }
}

describe('D1AdminApiTokenStore', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  function createStore(now = 2_000_000) {
    const db = new TestD1Database();
    databases.push(db);
    return new D1AdminApiTokenStore(db, {
      now: () => now,
      tokenIdFactory: () => 'token-id-1',
      tokenFactory: () => 'ccadm_plain-token',
    });
  }

  it('creates, lists, and authenticates hashed API tokens', async () => {
    const store = createStore();

    const created = await store.createToken({ label: ' Operators ', scopes: ['device:read', 'logs:export'], ttlDays: 1 });

    expect(created).toMatchObject({ tokenId: 'token-id-1', label: 'Operators', token: 'ccadm_plain-token' });
    expect(created.scopes).toEqual(['device:read', 'logs:export']);
    const listed = await store.listTokens();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('token');
    await expect(store.authenticateToken('ccadm_plain-token')).resolves.toMatchObject({ tokenId: 'token-id-1' });
  });

  it('normalizes invalid scopes and clamps ttl days', async () => {
    const store = createStore();

    const created = await store.createToken({ label: 'Default Scope', scopes: ['bad-scope' as any], ttlDays: 999 });

    expect(created.scopes).toEqual(['device:read']);
    expect(created.expiresAt - created.createdAt).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it('revokes tokens and rejects revoked or expired tokens', async () => {
    const db = new TestD1Database();
    databases.push(db);
    let now = 3_000_000;
    const store = new D1AdminApiTokenStore(db, {
      now: () => now,
      tokenIdFactory: () => 'token-id-2',
      tokenFactory: () => 'ccadm_revoke-token',
    });

    const created = await store.createToken({ label: 'Short', scopes: ['device:read'], ttlDays: 1 });
    await expect(store.authenticateToken(created.token)).resolves.toMatchObject({ tokenId: created.tokenId });

    const revoked = await store.revokeToken(created.tokenId);
    expect(revoked?.revokedAt).toBeTruthy();
    await expect(store.authenticateToken(created.token)).resolves.toBeNull();

    now += 2 * 24 * 60 * 60 * 1000;
    await expect(store.listTokens()).resolves.toHaveLength(0);
  });
});
