import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { generateSync, NobleCryptoPlugin } from 'otplib';
import { DatabaseService } from '../database/database.service';
import { TotpService } from './totp.service';

const cryptoPlugin = new NobleCryptoPlugin();

function generateToken(secret: string): string {
  return generateSync({ secret, crypto: cryptoPlugin });
}

function createDatabaseService(): DatabaseService {
  class MockDatabaseService extends DatabaseService {
    private readonly db: Database;
    constructor() {
      super();
      this.db = new Database(':memory:');
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS admin_totp (
          id INTEGER PRIMARY KEY,
          encryptedSecret TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_totp_recovery (
          codeHash TEXT PRIMARY KEY,
          used INTEGER NOT NULL DEFAULT 0
        );
      `);
    }
    get connection(): Database {
      return this.db;
    }
  }
  return new MockDatabaseService();
}

describe('TotpService', () => {
  let db: DatabaseService;
  let svc: TotpService;

  beforeEach(() => {
    db = createDatabaseService();
    process.env.CC_BOOTSTRAP_TOKEN = 'test-bootstrap-token-with-32-chars-min';
    svc = new TotpService(db);
  });

  afterEach(() => {
    (db.connection as Database).close();
    delete process.env.CC_BOOTSTRAP_TOKEN;
  });

  describe('generateSetup', () => {
    it('returns a TOTP secret and QR code data URL', async () => {
      const setup = await svc.generateSetup();

      expect(setup.secret).toBeTruthy();
      expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
      expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    });

    it('generates a different secret on each call', async () => {
      const a = await svc.generateSetup();
      const b = await svc.generateSetup();

      expect(a.secret).not.toBe(b.secret);
    });

    it('does not persist the setup until verifyAndEnable is called', async () => {
      await svc.generateSetup();
      expect(svc.isEnabled()).toBe(false);
    });
  });

  describe('verifyAndEnable', () => {
    it('stores the secret and enables 2FA on valid TOTP code', async () => {
      const setup = await svc.generateSetup();
      const validToken = generateToken(setup.secret);

      const result = svc.verifyAndEnable(validToken);
      expect(result).toBe(true);
      expect(svc.isEnabled()).toBe(true);
    });

    it('rejects an invalid TOTP code', async () => {
      await svc.generateSetup();
      const result = svc.verifyAndEnable('000000');
      expect(result).toBe(false);
      expect(svc.isEnabled()).toBe(false);
    });

    it('rejects when no pending setup exists', () => {
      const result = svc.verifyAndEnable('123456');
      expect(result).toBe(false);
    });

    it('encrypts the secret at rest in the database', async () => {
      const setup = await svc.generateSetup();
      const validToken = generateToken(setup.secret);

      svc.verifyAndEnable(validToken);

      const row = db.connection
        .prepare('SELECT encryptedSecret, enabled FROM admin_totp WHERE id = 1')
        .get() as { encryptedSecret: string; enabled: number } | undefined;

      expect(row).toBeTruthy();
      expect(row!.enabled).toBe(1);
      expect(row!.encryptedSecret).not.toBe(setup.secret);
      expect(row!.encryptedSecret).not.toContain(setup.secret);
    });
  });

  describe('verify', () => {
    it('returns false when 2FA is not enabled', () => {
      expect(svc.verify('123456')).toBe(false);
    });

    it('verifies a valid TOTP token after setup', async () => {
      const setup = await svc.generateSetup();
      const validToken = generateToken(setup.secret);
      svc.verifyAndEnable(validToken);

      const nextToken = generateToken(setup.secret);
      expect(svc.verify(nextToken)).toBe(true);
    });

    it('rejects an invalid TOTP token', async () => {
      const setup = await svc.generateSetup();
      svc.verifyAndEnable(generateToken(setup.secret));

      expect(svc.verify('000000')).toBe(false);
    });
  });

  describe('disable', () => {
    it('disables 2FA with a valid token', async () => {
      const setup = await svc.generateSetup();
      const validToken = generateToken(setup.secret);
      svc.verifyAndEnable(validToken);
      expect(svc.isEnabled()).toBe(true);

      const currentToken = generateToken(setup.secret);
      const disabled = svc.disable(currentToken);
      expect(disabled).toBe(true);
      expect(svc.isEnabled()).toBe(false);
    });

    it('rejects disable with an invalid token', async () => {
      const setup = await svc.generateSetup();
      svc.verifyAndEnable(generateToken(setup.secret));

      const disabled = svc.disable('000000');
      expect(disabled).toBe(false);
      expect(svc.isEnabled()).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('returns false by default', () => {
      expect(svc.isEnabled()).toBe(false);
    });

    it('returns true after successful setup', async () => {
      const setup = await svc.generateSetup();
      svc.verifyAndEnable(generateToken(setup.secret));
      expect(svc.isEnabled()).toBe(true);
    });
  });

  describe('recovery codes', () => {
    it('returns recovery codes after successful setup', async () => {
      const setup = await svc.generateSetup();
      const result = svc.verifyAndEnable(generateToken(setup.secret));
      expect(result).toBe(true);

      const codes = svc.getRecoveryCodes();
      expect(codes).toHaveLength(8);
      for (const code of codes) {
        expect(code).toBeTruthy();
        expect(typeof code).toBe('string');
      }
    });

    it('verifies a valid recovery code', async () => {
      const setup = await svc.generateSetup();
      svc.verifyAndEnable(generateToken(setup.secret));
      const codes = svc.getRecoveryCodes();

      expect(svc.verifyRecoveryCode(codes[0])).toBe(true);
    });

    it('rejects an invalid recovery code', async () => {
      const setup = await svc.generateSetup();
      svc.verifyAndEnable(generateToken(setup.secret));

      expect(svc.verifyRecoveryCode('INVALID-CODE')).toBe(false);
    });

    it('a recovery code can only be used once', async () => {
      const setup = await svc.generateSetup();
      svc.verifyAndEnable(generateToken(setup.secret));
      const codes = svc.getRecoveryCodes();

      expect(svc.verifyRecoveryCode(codes[0])).toBe(true);
      // Same code should fail on second use
      expect(svc.verifyRecoveryCode(codes[0])).toBe(false);
    });

    it('regenerating recovery codes invalidates old ones', async () => {
      const setup = await svc.generateSetup();
      svc.verifyAndEnable(generateToken(setup.secret));
      const oldCodes = svc.getRecoveryCodes();

      // Regenerate
      const newCodes = svc.regenerateRecoveryCodes();
      expect(newCodes).toHaveLength(8);
      expect(newCodes).not.toEqual(oldCodes);

      // Old codes should be invalid
      expect(svc.verifyRecoveryCode(oldCodes[0])).toBe(false);
      // New codes should work
      expect(svc.verifyRecoveryCode(newCodes[0])).toBe(true);
    });
  });
});
