import { Injectable } from '@nestjs/common';
import { FileTransferStore } from './file-transfer.store';
import { RemoteBrowserSessionStore } from './remote-browser-session.store';

export type FileOpAdmissionResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number; message: string };

@Injectable()
export class FileOpAdmissionService {
  constructor(
    private readonly fileTransferStore: FileTransferStore,
    private readonly remoteBrowserSessionStore: RemoteBrowserSessionStore,
  ) {}

  checkTransferCapacity(deviceId: string): FileOpAdmissionResult {
    const activeGlobal = this.fileTransferStore.countActive();
    const activeByDevice = this.fileTransferStore.countActiveByDevice(deviceId);
    if (activeByDevice >= this.maxActiveTransfersPerDevice()) {
      return {
        ok: false,
        retryAfterMs: this.retryAfterMs(),
        message: 'Transfer capacity is saturated for this device',
      };
    }
    if (activeGlobal >= this.maxActiveTransfersGlobal()) {
      return {
        ok: false,
        retryAfterMs: this.retryAfterMs(),
        message: 'Transfer capacity is saturated',
      };
    }
    return { ok: true };
  }

  checkRemoteBrowserCapacity(deviceId: string): FileOpAdmissionResult {
    this.remoteBrowserSessionStore.expireStaleActive(
      new Date().toISOString(),
      this.remoteBrowserIdleTtlMs(),
      this.remoteBrowserOpeningTtlMs(),
    );
    const activeGlobal = this.remoteBrowserSessionStore.countActive();
    const activeByDevice = this.remoteBrowserSessionStore.countActiveByDevice(deviceId);
    if (activeByDevice >= this.maxActiveRemoteBrowsersPerDevice()) {
      return {
        ok: false,
        retryAfterMs: this.retryAfterMs(),
        message: 'Remote browser capacity is saturated for this device',
      };
    }
    if (activeGlobal >= this.maxActiveRemoteBrowsersGlobal()) {
      return {
        ok: false,
        retryAfterMs: this.retryAfterMs(),
        message: 'Remote browser capacity is saturated',
      };
    }
    return { ok: true };
  }

  private maxActiveTransfersPerDevice() {
    return this.parsePositiveInt(process.env.CC_FILE_OP_MAX_ACTIVE_TRANSFERS_PER_DEVICE, 2);
  }

  private maxActiveTransfersGlobal() {
    return this.parsePositiveInt(process.env.CC_FILE_OP_MAX_ACTIVE_TRANSFERS_GLOBAL, 8);
  }

  private maxActiveRemoteBrowsersPerDevice() {
    return this.parsePositiveInt(process.env.CC_FILE_OP_MAX_ACTIVE_REMOTE_BROWSERS_PER_DEVICE, 4);
  }

  private maxActiveRemoteBrowsersGlobal() {
    return this.parsePositiveInt(process.env.CC_FILE_OP_MAX_ACTIVE_REMOTE_BROWSERS_GLOBAL, 16);
  }

  private retryAfterMs() {
    return this.parsePositiveInt(process.env.CC_FILE_OP_RETRY_AFTER_MS, 5000);
  }

  private remoteBrowserIdleTtlMs() {
    return this.parsePositiveInt(process.env.CC_REMOTE_BROWSER_IDLE_TTL_MS, 15 * 60 * 1000);
  }

  private remoteBrowserOpeningTtlMs() {
    return this.parsePositiveInt(process.env.CC_REMOTE_BROWSER_OPENING_TTL_MS, 60 * 1000);
  }

  private parsePositiveInt(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1) {
      return fallback;
    }
    return Math.floor(value);
  }
}
