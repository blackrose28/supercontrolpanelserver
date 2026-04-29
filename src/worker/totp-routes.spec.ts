import Database from 'better-sqlite3';
import { generateSync, NobleCryptoPlugin } from 'otplib';
import { afterEach, describe, expect, it } from 'vitest';
import worker from './index';
import { D1_SCHEMA_SQL } from './db/d1-schema';

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

type TestEnv = {
  CC_DB: TestD1Database;
  CC_ADMIN_PASSWORD: string;
  CC_BOOTSTRAP_TOKEN: string;
  now: () => number;
  sessionTokenFactory: () => string;
  csrfTokenFactory: () => string;
};

function extractCookies(response: Response): Record<string, string> {
  const setCookie = response.headers.get('set-cookie') || '';
  return Object.fromEntries(setCookie
    .split(/,(?=\s*cc_admin_)/)
    .map((cookie) => cookie.trim().split(';')[0].split('=').map(decodeURIComponent) as [string, string]));
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; ');
}

describe('Worker TOTP routes', () => {
  const databases: TestD1Database[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  function createEnv() {
    const db = new TestD1Database();
    databases.push(db);
    return {
      CC_DB: db,
      CC_ADMIN_PASSWORD: 'correct-password',
      CC_BOOTSTRAP_TOKEN: 'test-bootstrap-token-with-32-chars-min',
      now: () => Date.parse('2026-04-29T00:00:00.000Z'),
      sessionTokenFactory: () => 'session-token-1',
      csrfTokenFactory: () => 'csrf-token-1',
    } satisfies TestEnv;
  }

  function request(path: string, env: TestEnv, init: RequestInit = {}) {
    return worker.fetch(new Request(`https://cc.example.test${path}`, init), env as any);
  }

  async function login(env: TestEnv) {
    const response = await request('/admin/login', env, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    const cookies = extractCookies(response);
    return { cookie: cookieHeader(cookies), csrfToken: cookies.cc_admin_csrf };
  }

  it('reports status, starts setup, verifies setup, and returns recovery codes', async () => {
    const env = createEnv();
    const { cookie, csrfToken } = await login(env);

    const initialStatus = await request('/admin/totp/status', env, { headers: { cookie } });
    await expect(initialStatus.json()).resolves.toEqual({ enabled: false });

    const setup = await request('/admin/totp/setup', env, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ csrfToken }),
    });
    expect(setup.status).toBe(200);
    const setupBody = await setup.json() as { secret: string; qrDataUrl: string };
    expect(setupBody.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setupBody.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    const totpCode = generateSync({ secret: setupBody.secret, crypto: cryptoPlugin });
    const verify = await request('/admin/totp/verify-setup', env, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ csrfToken, totpCode }),
    });
    expect(verify.status).toBe(200);
    await expect(verify.json()).resolves.toEqual({ enabled: true });

    const enabledStatus = await request('/admin/totp/status', env, { headers: { cookie } });
    await expect(enabledStatus.json()).resolves.toEqual({ enabled: true });

    const recovery = await request('/admin/totp/recovery-codes', env, { headers: { cookie } });
    expect(recovery.status).toBe(200);
    const recoveryBody = await recovery.json() as { codes: string[] };
    expect(recoveryBody.codes).toHaveLength(8);
  });

  it('requires csrf for setup mutations and rejects invalid setup codes', async () => {
    const env = createEnv();
    const { cookie, csrfToken } = await login(env);

    const missingCsrf = await request('/admin/totp/setup', env, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({}) });
    expect(missingCsrf.status).toBe(403);

    await request('/admin/totp/setup', env, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ csrfToken }) });
    const invalid = await request('/admin/totp/verify-setup', env, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ csrfToken, totpCode: '000000' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('regenerates recovery codes and disables TOTP with a valid code', async () => {
    const env = createEnv();
    const { cookie, csrfToken } = await login(env);
    const setup = await request('/admin/totp/setup', env, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ csrfToken }) });
    const setupBody = await setup.json() as { secret: string };
    const totpCode = generateSync({ secret: setupBody.secret, crypto: cryptoPlugin });
    await request('/admin/totp/verify-setup', env, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ csrfToken, totpCode }) });

    const first = await (await request('/admin/totp/recovery-codes', env, { headers: { cookie } })).json() as { codes: string[] };
    const regen = await request('/admin/totp/regenerate-recovery-codes', env, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ csrfToken }) });
    expect(regen.status).toBe(200);
    const second = await regen.json() as { codes: string[] };
    expect(second.codes).toHaveLength(8);
    expect(second.codes).not.toEqual(first.codes);

    const disable = await request('/admin/totp/disable', env, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ csrfToken, totpCode: generateSync({ secret: setupBody.secret, crypto: cryptoPlugin }) }),
    });
    expect(disable.status).toBe(200);
    await expect(disable.json()).resolves.toEqual({ enabled: false });
  });
});
