import { Injectable } from '@nestjs/common';
import { FileTransferStore } from './file-transfer.store';

export type FileOpQuotaCheckResult =
  | {
      ok: true;
      warning: null | {
        code: 'quota_warning';
        message: string;
        tenantId: string;
        usedBytes: number;
        budgetBytes: number;
        thresholdPct: number;
      };
    }
  | {
      ok: false;
      code: 'quota_exceeded';
      message: string;
      tenantId: string;
      usedBytes: number;
      budgetBytes: number;
      thresholdPct: number;
      retryAfterMs: number;
    };

@Injectable()
export class FileOpQuotaService {
  constructor(
    private readonly fileTransferStore: FileTransferStore,
  ) {}

  checkTransferStartQuota(): FileOpQuotaCheckResult {
    const tenantId = this.defaultTenantId();
    const budgetBytes = this.dailyBudgetBytes();
    if (budgetBytes <= 0) {
      return { ok: true, warning: null };
    }

    const usedBytes = this.fileTransferStore.sumTransferredBytesSince(startOfUtcDayIso());
    const usedRatio = usedBytes / budgetBytes;

    if (usedRatio >= 1) {
      return {
        ok: false,
        code: 'quota_exceeded',
        message: 'Daily transfer byte budget exhausted for the default tenant',
        tenantId,
        usedBytes,
        budgetBytes,
        thresholdPct: 100,
        retryAfterMs: msUntilNextUtcDay(),
      };
    }

    if (usedRatio >= this.warningThresholdRatio()) {
      return {
        ok: true,
        warning: {
          code: 'quota_warning',
          message: 'Daily transfer byte budget is above the warning threshold for the default tenant',
          tenantId,
          usedBytes,
          budgetBytes,
          thresholdPct: Math.round(this.warningThresholdRatio() * 100),
        },
      };
    }

    return { ok: true, warning: null };
  }

  private defaultTenantId() {
    return process.env.CC_DEFAULT_TENANT_ID?.trim() || 'default';
  }

  private dailyBudgetBytes() {
    return parseNonNegativeInt(process.env.CC_FILE_OP_DAILY_BUDGET_BYTES, 0);
  }

  private warningThresholdRatio() {
    const pct = parseNonNegativeInt(process.env.CC_FILE_OP_DAILY_BUDGET_WARNING_PCT, 80);
    return Math.min(Math.max(pct, 1), 99) / 100;
  }
}

function startOfUtcDayIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function msUntilNextUtcDay() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(1, next.getTime() - now.getTime());
}

function parseNonNegativeInt(raw: string | undefined, fallback: number) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}
