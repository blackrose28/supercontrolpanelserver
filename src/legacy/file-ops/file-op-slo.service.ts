import { Injectable } from '@nestjs/common';
import { FileTransferStore } from './file-transfer.store';
import { FileTransferRecord } from './file-transfer.types';

export interface FileTransferSloSummary {
  deviceId: string | null;
  windowHours: number;
  windowStart: string;
  windowEnd: string;
  completedTransferCount: number;
  throughputSampleCount: number;
  throughputP50Bps: number | null;
  throughputP95Bps: number | null;
  progressCadenceSampleCount: number;
  progressUpdateHzP50: number | null;
  progressUpdateHzP95: number | null;
  finalizeAttemptCount: number;
  finalizeSuccessCount: number;
  finalizeSuccessRate: number | null;
}

@Injectable()
export class FileOpSloService {
  constructor(
    private readonly fileTransferStore: FileTransferStore,
  ) {}

  getSummary(input?: { deviceId?: string; windowHours?: number }): FileTransferSloSummary {
    const windowHours = normalizeWindowHours(input?.windowHours);
    const now = new Date();
    const windowStartDate = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
    const deviceId = typeof input?.deviceId === 'string' && input.deviceId.trim().length
      ? input.deviceId.trim()
      : null;
    const records = this.fileTransferStore.listCompletedSince(windowStartDate.toISOString(), deviceId ?? undefined);

    const throughputSamples = records
      .map((record) => record.throughputBps)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);

    const progressCadenceSamples = records
      .map((record) => computeProgressCadenceHz(record))
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);

    const finalizeAttemptCount = records.filter((record) => record.finalizeSeen).length;
    const finalizeSuccessCount = records.filter((record) => record.finalizeSeen && record.state === 'succeeded').length;

    return {
      deviceId,
      windowHours,
      windowStart: windowStartDate.toISOString(),
      windowEnd: now.toISOString(),
      completedTransferCount: records.length,
      throughputSampleCount: throughputSamples.length,
      throughputP50Bps: percentile(throughputSamples, 50),
      throughputP95Bps: percentile(throughputSamples, 95),
      progressCadenceSampleCount: progressCadenceSamples.length,
      progressUpdateHzP50: percentile(progressCadenceSamples, 50),
      progressUpdateHzP95: percentile(progressCadenceSamples, 95),
      finalizeAttemptCount,
      finalizeSuccessCount,
      finalizeSuccessRate: finalizeAttemptCount > 0 ? roundMetric(finalizeSuccessCount / finalizeAttemptCount) : null,
    };
  }
}

function normalizeWindowHours(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 24;
  }
  return Math.min(Math.max(Math.floor(value), 1), 24 * 30);
}

function computeProgressCadenceHz(record: FileTransferRecord): number | null {
  if (record.progressEventCount < 2 || !record.firstProgressAt || !record.lastProgressAt) {
    return null;
  }
  const firstMs = Date.parse(record.firstProgressAt);
  const lastMs = Date.parse(record.lastProgressAt);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || lastMs <= firstMs) {
    return null;
  }
  const seconds = (lastMs - firstMs) / 1000;
  if (seconds <= 0) {
    return null;
  }
  return roundMetric((record.progressEventCount - 1) / seconds);
}

function percentile(values: number[], pct: number): number | null {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return roundMetric(sorted[rank]);
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}
