const HASH_PREFIX = 'sha256:';

export function isHashedSecret(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(HASH_PREFIX);
}

export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SHA-256 support is required');
  }

  const data = new TextEncoder().encode(value);
  const digest = await subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashSecret(value: string): Promise<string> {
  return `${HASH_PREFIX}${await sha256Hex(value)}`;
}

export async function normalizeStoredSecret(value: string | undefined | null): Promise<string> {
  if (!value) {
    return '';
  }
  return isHashedSecret(value) ? value : hashSecret(value);
}
