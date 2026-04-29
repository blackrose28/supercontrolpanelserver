import { generateSecret, NobleCryptoPlugin, ScureBase32Plugin, verifySync } from 'otplib';
import { toDataURL } from 'qrcode';
import { D1LikeDatabase } from './d1-device-store';
import { hashSecret, sha256Hex } from './worker-secrets';

export type WorkerRateLimitCheckResult = { ok: true } | { ok: false; retryAfterMs: number };

type RateLimitBucket = { count: number; resetAt: number };

type RateLimitOptions = { now?: () => number };

export class D1RateLimitStore {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly now: () => number;

  constructor(private readonly db: D1LikeDatabase, opts: RateLimitOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async initialize(): Promise<void> {
    await this.restoreFromDb();
    await this.pruneExpiredDb();
  }

  async checkDetailed(key: string, limit: number, windowMs: number): Promise<WorkerRateLimitCheckResult> {
    const now = this.now();
    const current = this.buckets.get(key);

    if (!current || current.resetAt <= now) {
      const bucket = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
      await this.persistBucket(key, bucket);
      return { ok: true };
    }

    if (current.count >= limit) {
      return { ok: false, retryAfterMs: Math.max(1, current.resetAt - now) };
    }

    current.count += 1;
    this.buckets.set(key, current);
    await this.persistBucket(key, current);
    return { ok: true };
  }

  private async persistBucket(key: string, bucket: RateLimitBucket): Promise<void> {
    await this.db.prepare(`
      INSERT INTO rate_limit_buckets (key, count, resetAt)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET count = excluded.count, resetAt = excluded.resetAt
    `).bind(key, bucket.count, bucket.resetAt).run();
  }

  private async restoreFromDb(): Promise<void> {
    const { results = [] } = await this.db.prepare('SELECT key, count, resetAt FROM rate_limit_buckets WHERE resetAt > ?')
      .bind(this.now()).all<{ key: string; count: number; resetAt: number }>();
    for (const row of results) {
      this.buckets.set(row.key, { count: row.count, resetAt: row.resetAt });
    }
  }

  private async pruneExpiredDb(): Promise<void> {
    await this.db.prepare('DELETE FROM rate_limit_buckets WHERE resetAt <= ?').bind(this.now()).run();
  }
}

const OTP_ISSUER = 'cc-admin';
const OTP_LABEL = 'admin';
const cryptoPlugin = new NobleCryptoPlugin();
const base32Plugin = new ScureBase32Plugin();

type TotpOptions = {
  now?: () => number;
  encryptionKeyMaterial?: string;
  recoveryCodeFactory?: (index: number) => string;
};

async function deriveAesKey(material: string): Promise<CryptoKey> {
  const hex = await sha256Hex(material || 'fallback-key');
  const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function encryptSecret(plaintext: string, material: string): Promise<string> {
  const key = await deriveAesKey(material);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return base64Encode(combined);
}

async function decryptSecret(encoded: string, material: string): Promise<string | null> {
  try {
    const combined = base64Decode(encoded);
    if (combined.length < 29) return null;
    const iv = combined.slice(0, 12);
    const encrypted = combined.slice(12);
    const key = await deriveAesKey(material);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

function verifyToken(token: string, secret: string): boolean {
  try {
    return verifySync({ token, secret, crypto: cryptoPlugin }).valid;
  } catch {
    return false;
  }
}

function defaultRecoveryCode(index: number): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 10; i++) {
    code += chars[bytes[i % bytes.length] % chars.length];
  }
  return `${code.substring(0, 4)}-${code.substring(4, 8)}-${code.substring(8, 10)}`;
}

export class D1TotpStore {
  private pendingSecret: string | null = null;
  private pendingRecoveryCodes: string[] | null = null;
  private recoveryGeneration = 0;
  private readonly now: () => number;
  private readonly encryptionKeyMaterial: string;
  private readonly recoveryCodeFactory: (index: number) => string;

  constructor(private readonly db: D1LikeDatabase, opts: TotpOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.encryptionKeyMaterial = opts.encryptionKeyMaterial ?? 'fallback-key';
    this.recoveryCodeFactory = opts.recoveryCodeFactory ?? defaultRecoveryCode;
  }

  async generateSetup(): Promise<{ secret: string; qrDataUrl: string }> {
    const secret = generateSecret({ crypto: cryptoPlugin, base32: base32Plugin, length: 20 });
    this.pendingSecret = secret;
    const otpauth = `otpauth://totp/${OTP_LABEL}?secret=${secret}&issuer=${OTP_ISSUER}`;
    const qrDataUrl = await toDataURL(otpauth);
    return { secret, qrDataUrl };
  }

  async verifyAndEnable(token: string): Promise<boolean> {
    if (!this.pendingSecret || !verifyToken(token, this.pendingSecret)) {
      return false;
    }

    const encrypted = await encryptSecret(this.pendingSecret, this.encryptionKeyMaterial);
    await this.db.prepare('DELETE FROM admin_totp').run();
    await this.db.prepare('INSERT INTO admin_totp (id, encryptedSecret, enabled, createdAt) VALUES (1, ?, 1, ?)')
      .bind(encrypted, this.now()).run();
    this.pendingRecoveryCodes = await this.generateRecoveryCodesInternal();
    this.pendingSecret = null;
    return true;
  }

  getRecoveryCodes(): string[] {
    return this.pendingRecoveryCodes ? [...this.pendingRecoveryCodes] : [];
  }

  async regenerateRecoveryCodes(): Promise<string[]> {
    this.pendingRecoveryCodes = await this.generateRecoveryCodesInternal();
    return [...this.pendingRecoveryCodes];
  }

  async verifyRecoveryCode(code: string): Promise<boolean> {
    if (!code) return false;
    const codeHash = await hashSecret(code);
    const row = await this.db.prepare('SELECT used FROM admin_totp_recovery WHERE codeHash = ?').bind(codeHash).first<{ used?: number }>();
    if (!row || row.used) return false;
    await this.db.prepare('UPDATE admin_totp_recovery SET used = 1 WHERE codeHash = ?').bind(codeHash).run();
    return true;
  }

  async verify(token: string): Promise<boolean> {
    const secret = await this.getDecryptedSecret();
    return secret ? verifyToken(token, secret) : false;
  }

  async disable(token: string): Promise<boolean> {
    const secret = await this.getDecryptedSecret();
    if (!secret || !verifyToken(token, secret)) return false;
    await this.db.prepare('DELETE FROM admin_totp').run();
    return true;
  }

  async isEnabled(): Promise<boolean> {
    const row = await this.db.prepare('SELECT enabled FROM admin_totp WHERE id = 1 AND enabled = 1').first<{ enabled?: number }>();
    return Boolean(row?.enabled);
  }

  private async getDecryptedSecret(): Promise<string | null> {
    const row = await this.db.prepare('SELECT encryptedSecret FROM admin_totp WHERE id = 1 AND enabled = 1').first<{ encryptedSecret?: string }>();
    return row?.encryptedSecret ? decryptSecret(row.encryptedSecret, this.encryptionKeyMaterial) : null;
  }

  private async generateRecoveryCodesInternal(): Promise<string[]> {
    await this.db.prepare('DELETE FROM admin_totp_recovery').run();
    this.recoveryGeneration += 1;
    const codes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const code = this.recoveryCodeFactory(i + this.recoveryGeneration * 1000);
      codes.push(code);
      await this.db.prepare('INSERT INTO admin_totp_recovery (codeHash, used) VALUES (?, 0)').bind(await hashSecret(code)).run();
    }
    return codes;
  }
}
