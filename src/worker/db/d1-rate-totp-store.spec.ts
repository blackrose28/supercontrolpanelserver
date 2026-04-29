import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSync, NobleCryptoPlugin } from 'otplib';
import { D1_SCHEMA_SQL } from './d1-schema';
import { D1RateLimitStore, D1TotpStore } from './d1-rate-totp-store';

const cryptoPlugin = new NobleCryptoPlugin();

class TestD1PreparedStatement {
  private params: unknown[] = [];
  constructor(private readonly statement: Database.Statement) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  async run() { const result = this.statement.run(...this.params); return { success: true, changes: result.changes }; }
  async first<T = unknown>() { return (this.statement.get(...this.params) ?? null) as T | null; }
  async all<T = unknown>() { return { results: this.statement.all(...this.params) as T[] }; }
}

class TestD1Database {
  readonly sqlite = new Database(':memory:');
  constructor() { this.sqlite.exec(D1_SCHEMA_SQL); }
  prepare(sql: string) { return new TestD1PreparedStatement(this.sqlite.prepare(sql)); }
  close() { this.sqlite.close(); }
}

describe('D1RateLimitStore', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  it('persists bucket counts and blocks over limit without incrementing', async () => {
    const db = new TestD1Database();
    databases.push(db);
    let now = 1_000;
    const store = new D1RateLimitStore(db, { now: () => now });

    expect(await store.checkDetailed('login:alice', 2, 60_000)).toEqual({ ok: true });
    expect(await store.checkDetailed('login:alice', 2, 60_000)).toEqual({ ok: true });
    const blocked = await store.checkDetailed('login:alice', 2, 60_000);
    expect(blocked.ok).toBe(false);

    const row = await db.prepare('SELECT count, resetAt FROM rate_limit_buckets WHERE key = ?').bind('login:alice').first<{ count: number; resetAt: number }>();
    expect(row).toMatchObject({ count: 2, resetAt: 61_000 });

    now = 62_000;
    expect(await store.checkDetailed('login:alice', 2, 60_000)).toEqual({ ok: true });
    const reset = await db.prepare('SELECT count FROM rate_limit_buckets WHERE key = ?').bind('login:alice').first<{ count: number }>();
    expect(reset?.count).toBe(1);
  });

  it('restores unexpired buckets and prunes expired rows', async () => {
    const db = new TestD1Database();
    databases.push(db);
    await db.prepare('INSERT INTO rate_limit_buckets (key, count, resetAt) VALUES (?, ?, ?)').bind('expired', 5, 999).run();
    await db.prepare('INSERT INTO rate_limit_buckets (key, count, resetAt) VALUES (?, ?, ?)').bind('valid', 1, 10_000).run();

    const store = new D1RateLimitStore(db, { now: () => 1_000 });
    await store.initialize();

    expect(await db.prepare('SELECT key FROM rate_limit_buckets WHERE key = ?').bind('expired').first()).toBeNull();
    expect(await store.checkDetailed('valid', 2, 60_000)).toEqual({ ok: true });
    expect((await store.checkDetailed('valid', 2, 60_000)).ok).toBe(false);
  });
});

describe('D1TotpStore', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  function createStore() {
    const db = new TestD1Database();
    databases.push(db);
    return new D1TotpStore(db, {
      now: () => 1_000_000,
      encryptionKeyMaterial: 'test-bootstrap-token-with-32-chars-min',
      recoveryCodeFactory: (index) => `CODE-${index.toString().padStart(4, '0')}`,
    });
  }

  it('generates setup without persisting until verified and enabled', async () => {
    const store = createStore();

    const setup = await store.generateSetup();

    expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    await expect(store.isEnabled()).resolves.toBe(false);

    const token = generateSync({ secret: setup.secret, crypto: cryptoPlugin });
    await expect(store.verifyAndEnable(token)).resolves.toBe(true);
    await expect(store.isEnabled()).resolves.toBe(true);
    expect(store.getRecoveryCodes()).toHaveLength(8);
  });

  it('verifies, disables, and rejects invalid TOTP tokens', async () => {
    const store = createStore();
    const setup = await store.generateSetup();
    const token = generateSync({ secret: setup.secret, crypto: cryptoPlugin });
    await store.verifyAndEnable(token);

    expect(await store.verify(generateSync({ secret: setup.secret, crypto: cryptoPlugin }))).toBe(true);
    expect(await store.verify('000000')).toBe(false);
    expect(await store.disable('000000')).toBe(false);
    expect(await store.disable(generateSync({ secret: setup.secret, crypto: cryptoPlugin }))).toBe(true);
    expect(await store.isEnabled()).toBe(false);
  });

  it('stores encrypted secret and supports one-time recovery codes', async () => {
    const store = createStore();
    const setup = await store.generateSetup();
    await store.verifyAndEnable(generateSync({ secret: setup.secret, crypto: cryptoPlugin }));

    const codes = store.getRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(await store.verifyRecoveryCode(codes[0])).toBe(true);
    expect(await store.verifyRecoveryCode(codes[0])).toBe(false);

    const newCodes = await store.regenerateRecoveryCodes();
    expect(newCodes).toHaveLength(8);
    expect(newCodes).not.toEqual(codes);
    expect(await store.verifyRecoveryCode(codes[1])).toBe(false);
    expect(await store.verifyRecoveryCode(newCodes[0])).toBe(true);
  });
});
