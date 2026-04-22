import { redactTelemetryPayload } from '../logs/log-redaction';
import { FileTransferState } from './file-transfer.types';

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isFinishedTransferState(state: FileTransferState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'canceled';
}

export function sanitizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  return redactTelemetryPayload(value);
}

export function normalizePositiveInteger(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

export function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num) && num >= 0 ? num : fallback;
}

export function normalizeNullableNonNegativeNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}
