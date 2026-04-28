import { hashSync, compareSync, getRounds } from 'bcryptjs';

function requireSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalSecret(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const BCRYPT_ROUNDS = 12;

function isBcryptHash(value: string): boolean {
  try {
    return getRounds(value) > 0;
  } catch {
    return false;
  }
}

let _adminPasswordHash: string | null = null;

export function initAdminPasswordHash(): void {
  const preHashed = process.env.CC_ADMIN_PASSWORD_HASH?.trim();
  if (preHashed && isBcryptHash(preHashed)) {
    _adminPasswordHash = preHashed;
    return;
  }
  if (preHashed) {
    console.warn('[CC] CC_ADMIN_PASSWORD_HASH is set but is not a valid bcrypt hash; falling back to CC_ADMIN_PASSWORD');
  }

  const rawPassword = process.env.CC_ADMIN_PASSWORD?.trim();
  if (!rawPassword) {
    throw new Error('CC_ADMIN_PASSWORD is required');
  }

  if (isBcryptHash(rawPassword)) {
    _adminPasswordHash = rawPassword;
    return;
  }

  console.warn(
    '[CC] Plain-text CC_ADMIN_PASSWORD detected. The password has been hashed and stored in memory. ' +
      'Consider setting CC_ADMIN_PASSWORD_HASH with a bcrypt hash in production.',
  );
  _adminPasswordHash = hashSync(rawPassword, BCRYPT_ROUNDS);
}

export function getAdminPasswordHash(): string | null {
  return _adminPasswordHash;
}

export function verifyAdminPassword(password: string | null | undefined): boolean {
  if (!password || !_adminPasswordHash) {
    return false;
  }
  return compareSync(password, _adminPasswordHash);
}

export function getAdminPassword(): string {
  return requireSecret('CC_ADMIN_PASSWORD');
}

export function getAdminApiToken(): string | undefined {
  return optionalSecret('CC_ADMIN_API_TOKEN');
}

export function getBootstrapToken(): string {
  return requireSecret('CC_BOOTSTRAP_TOKEN');
}

export function validateAuthConfig() {
  initAdminPasswordHash();

  const adminApiToken = getAdminApiToken();
  const bootstrapToken = getBootstrapToken();

  if (bootstrapToken.length < 16) {
    console.warn(
      '[CC] Warning: CC_BOOTSTRAP_TOKEN is shorter than 16 characters; use a stronger secret.',
    );
  }

  if (adminApiToken && adminApiToken.length < 16) {
    console.warn(
      '[CC] Warning: CC_ADMIN_API_TOKEN is shorter than 16 characters; use a stronger secret.',
    );
  }
}
