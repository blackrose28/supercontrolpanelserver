import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as bcryptjs from 'bcryptjs';
import {
  initAdminPasswordHash,
  getAdminPasswordHash,
  verifyAdminPassword,
} from './auth';

const validPassword = 'my-super-secret-admin-password-123';

describe('auth - password hashing', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CC_ADMIN_PASSWORD;
    delete process.env.CC_ADMIN_PASSWORD_HASH;
  });

  afterEach(() => {
    delete process.env.CC_ADMIN_PASSWORD;
    delete process.env.CC_ADMIN_PASSWORD_HASH;
  });

  describe('initAdminPasswordHash', () => {
    it('hashes plaintext CC_ADMIN_PASSWORD on init', () => {
      process.env.CC_ADMIN_PASSWORD = validPassword;
      delete process.env.CC_ADMIN_PASSWORD_HASH;

      initAdminPasswordHash();

      const hash = getAdminPasswordHash();
      expect(hash).toBeTruthy();
      expect(hash).not.toBe(validPassword);
      // Should be a valid bcrypt hash
      expect(hash).toMatch(/^\$2[aby]\$\d+\$/);
    });

    it('verifies the hashed password correctly', () => {
      process.env.CC_ADMIN_PASSWORD = validPassword;
      delete process.env.CC_ADMIN_PASSWORD_HASH;

      initAdminPasswordHash();

      const hash = getAdminPasswordHash();
      expect(verifyAdminPassword(validPassword)).toBe(true);
      expect(verifyAdminPassword('wrong-password')).toBe(false);
    });

    it('detects a pre-existing bcrypt hash from CC_ADMIN_PASSWORD and uses it directly', () => {
      const preHashed = bcryptjs.hashSync(validPassword, 10);
      process.env.CC_ADMIN_PASSWORD = preHashed;
      delete process.env.CC_ADMIN_PASSWORD_HASH;

      initAdminPasswordHash();

      const hash = getAdminPasswordHash();
      expect(hash).toBe(preHashed);
      expect(verifyAdminPassword(validPassword)).toBe(true);
      expect(verifyAdminPassword('wrong-password')).toBe(false);
    });

    it('uses CC_ADMIN_PASSWORD_HASH env var if set, over CC_ADMIN_PASSWORD', () => {
      const preHashed = bcryptjs.hashSync(validPassword, 10);
      process.env.CC_ADMIN_PASSWORD = 'plaintext-that-should-be-ignored';
      process.env.CC_ADMIN_PASSWORD_HASH = preHashed;

      initAdminPasswordHash();

      const hash = getAdminPasswordHash();
      expect(hash).toBe(preHashed);
      expect(verifyAdminPassword(validPassword)).toBe(true);
      expect(verifyAdminPassword('plaintext-that-should-be-ignored')).toBe(false);
    });

    it('throws a clear error when CC_ADMIN_PASSWORD is missing entirely', () => {
      delete process.env.CC_ADMIN_PASSWORD;
      delete process.env.CC_ADMIN_PASSWORD_HASH;

      expect(() => initAdminPasswordHash()).toThrow(
        /CC_ADMIN_PASSWORD is required/i,
      );
    });
  });

  describe('verifyAdminPassword', () => {
    it('returns false when password hash has not been initialized', () => {
      expect(verifyAdminPassword('anything')).toBe(false);
    });

    it('returns true for matching password after init', () => {
      process.env.CC_ADMIN_PASSWORD = validPassword;
      initAdminPasswordHash();
      expect(verifyAdminPassword(validPassword)).toBe(true);
    });

    it('returns false for empty/null passwords', () => {
      process.env.CC_ADMIN_PASSWORD = validPassword;
      initAdminPasswordHash();
      expect(verifyAdminPassword('')).toBe(false);
      expect(verifyAdminPassword(null as any)).toBe(false);
      expect(verifyAdminPassword(undefined as any)).toBe(false);
    });
  });

  describe('verification safety', () => {
    it('rejects wrong passwords differently from the correct one', () => {
      process.env.CC_ADMIN_PASSWORD = validPassword;
      initAdminPasswordHash();

      expect(verifyAdminPassword(validPassword)).toBe(true);
      expect(verifyAdminPassword('wrong')).toBe(false);
      expect(verifyAdminPassword(validPassword + 'extra')).toBe(false);
      expect(verifyAdminPassword('')).toBe(false);
      expect(verifyAdminPassword(null as any)).toBe(false);
    });
  });

  describe('backward compatibility', () => {
    it('logs a migration message when upgrading from plaintext', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.CC_ADMIN_PASSWORD = validPassword;
      delete process.env.CC_ADMIN_PASSWORD_HASH;

      initAdminPasswordHash();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('hashed and stored in memory'),
      );
      warnSpy.mockRestore();
    });

    it('does not log migration message when password is already a bcrypt hash', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const preHashed = bcryptjs.hashSync(validPassword, 10);
      process.env.CC_ADMIN_PASSWORD = preHashed;
      delete process.env.CC_ADMIN_PASSWORD_HASH;

      initAdminPasswordHash();

      const migrationCalls = warnSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === 'string' && call[0].includes('hashed and stored'),
      );
      expect(migrationCalls).toHaveLength(0);
      warnSpy.mockRestore();
    });
  });
});
