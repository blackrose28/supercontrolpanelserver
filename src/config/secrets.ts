import { createHash } from 'node:crypto';

const HASH_PREFIX = 'sha256:';

export function hashSecret(value: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(value).digest('hex')}`;
}

export function isHashedSecret(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(HASH_PREFIX);
}

export function normalizeStoredSecret(value: string | undefined | null): string {
  if (!value) {
    return '';
  }
  return isHashedSecret(value) ? value : hashSecret(value);
}
