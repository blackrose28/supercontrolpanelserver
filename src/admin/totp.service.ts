import { Injectable } from '@nestjs/common';
import { generateSecret, verifySync, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';
import { toDataURL } from 'qrcode';
import { createCipheriv, createDecipheriv, randomBytes, randomInt, createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { hashSecret } from '../config/secrets';

const OTP_ISSUER = 'cc-admin';
const OTP_LABEL = 'admin';

const cryptoPlugin = new NobleCryptoPlugin();
const base32Plugin = new ScureBase32Plugin();

function deriveEncryptionKey(): Buffer {
  const raw = process.env.CC_TOTP_ENCRYPTION_KEY || process.env.CC_BOOTSTRAP_TOKEN || 'fallback-key';
  return createHash('sha256').update(raw).digest();
}

function encryptSecret(plaintext: string): string {
  const key = deriveEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const result = Buffer.concat([iv, encrypted, authTag]);
  return result.toString('base64');
}

function decryptSecret(encoded: string): string | null {
  try {
    const key = deriveEncryptionKey();
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.length < 28) return null;
    const iv = buffer.subarray(0, 12);
    const encrypted = buffer.subarray(12, buffer.length - 16);
    const authTag = buffer.subarray(buffer.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

function verifyToken(token: string, secret: string): boolean {
  try {
    const result = verifySync({ token, secret, crypto: cryptoPlugin });
    return result.valid;
  } catch {
    return false;
  }
}

@Injectable()
export class TotpService {
  private pendingSecret: string | null = null;
  private pendingRecoveryCodes: string[] | null = null;

  constructor(private readonly databaseService: DatabaseService) {}

  async generateSetup(): Promise<{ secret: string; qrDataUrl: string }> {
    const secret = generateSecret({ crypto: cryptoPlugin, base32: base32Plugin, length: 20 });
    this.pendingSecret = secret;

    const otpauth = `otpauth://totp/${OTP_LABEL}?secret=${secret}&issuer=${OTP_ISSUER}`;
    const qrDataUrl = await toDataURL(otpauth);

    return { secret, qrDataUrl };
  }

  verifyAndEnable(token: string): boolean {
    return this.verifyAndEnableInternal(token);
  }

  private verifyAndEnableInternal(token: string, generateCodes: boolean = true): boolean {
    if (!this.pendingSecret) {
      return false;
    }

    if (!verifyToken(token, this.pendingSecret)) {
      return false;
    }

    const encrypted = encryptSecret(this.pendingSecret);
    const now = Date.now();

    this.databaseService.connection
      .prepare('DELETE FROM admin_totp')
      .run();

    this.databaseService.connection
      .prepare(
        'INSERT INTO admin_totp (id, encryptedSecret, enabled, createdAt) VALUES (1, ?, 1, ?)',
      )
      .run(encrypted, now);

    if (generateCodes) {
      this.pendingRecoveryCodes = this.generateRecoveryCodesInternal();
    }

    this.pendingSecret = null;
    return true;
  }

  getRecoveryCodes(): string[] {
    return this.pendingRecoveryCodes ?? [];
  }

  regenerateRecoveryCodes(): string[] {
    this.pendingRecoveryCodes = this.generateRecoveryCodesInternal();
    return [...this.pendingRecoveryCodes];
  }

  verifyRecoveryCode(code: string): boolean {
    if (!code) return false;

    const hash = this.hashRecoveryCode(code);
    const row = this.databaseService.connection
      .prepare('SELECT used FROM admin_totp_recovery WHERE codeHash = ?')
      .get(hash) as { used: number } | undefined;

    if (!row || row.used) {
      return false;
    }

    this.databaseService.connection
      .prepare('UPDATE admin_totp_recovery SET used = 1 WHERE codeHash = ?')
      .run(hash);

    return true;
  }

  private generateRecoveryCodesInternal(): string[] {
    this.databaseService.connection
      .prepare('DELETE FROM admin_totp_recovery')
      .run();

    const codes: string[] = [];
    const stmt = this.databaseService.connection.prepare(
      'INSERT INTO admin_totp_recovery (codeHash, used) VALUES (?, 0)',
    );

    for (let i = 0; i < 8; i++) {
      const code = this.generateRecoveryCode();
      codes.push(code);
      stmt.run(this.hashRecoveryCode(code));
    }

    return codes;
  }

  private generateRecoveryCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 10; i++) {
      code += chars[randomInt(0, chars.length)];
    }
    // Format as XXXX-XXXX-XX
    return `${code.substring(0, 4)}-${code.substring(4, 8)}-${code.substring(8, 10)}`;
  }

  private hashRecoveryCode(code: string): string {
    return hashSecret(code);
  }

  verify(token: string): boolean {
    const secret = this.getDecryptedSecret();
    if (!secret) {
      return false;
    }
    return verifyToken(token, secret);
  }

  disable(token: string): boolean {
    const secret = this.getDecryptedSecret();
    if (!secret) {
      return false;
    }

    if (!verifyToken(token, secret)) {
      return false;
    }

    this.databaseService.connection
      .prepare('DELETE FROM admin_totp')
      .run();

    return true;
  }

  isEnabled(): boolean {
    const row = this.databaseService.connection
      .prepare('SELECT enabled FROM admin_totp WHERE id = 1 AND enabled = 1')
      .get() as { enabled: number } | undefined;

    return !!row;
  }

  private getDecryptedSecret(): string | null {
    const row = this.databaseService.connection
      .prepare('SELECT encryptedSecret FROM admin_totp WHERE id = 1 AND enabled = 1')
      .get() as { encryptedSecret: string } | undefined;

    if (!row) {
      return null;
    }

    return decryptSecret(row.encryptedSecret);
  }
}
