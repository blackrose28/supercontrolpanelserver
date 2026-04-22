import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CommandRecord, CommandStore, CommandState } from './command.store';
import { DeviceStore } from '../devices/device.store';

@Injectable()
export class CommandTimeoutService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private readonly scanIntervalMs: number;
  private readonly dispatchTimeoutMs: number;
  private readonly executionTimeoutMs: number;
  private readonly lostAgentGraceMs: number;

  constructor(
    private readonly commandStore: CommandStore,
    private readonly deviceStore: DeviceStore,
  ) {
    this.scanIntervalMs = readPositiveInt(process.env.CC_COMMAND_TIMEOUT_SCAN_MS, 5000);
    this.dispatchTimeoutMs = readPositiveInt(process.env.CC_COMMAND_DISPATCH_TIMEOUT_MS, 15000);
    this.executionTimeoutMs = readPositiveInt(process.env.CC_COMMAND_EXECUTION_TIMEOUT_MS, 60000);
    this.lostAgentGraceMs = readPositiveInt(process.env.CC_COMMAND_LOST_AGENT_GRACE_MS, 10000);
  }

  onModuleInit() {
    this.runSweep();
    this.timer = setInterval(() => this.runSweep(), this.scanIntervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private runSweep() {
    this.reconcileLostAgents();
    this.failTimedOutState('dispatched');
    this.failTimedOutState('executing');
  }

  private reconcileLostAgents() {
    const disconnectedDevices = this.deviceStore
      .getAllDevices()
      .filter((device) => device.status === 'disconnected');

    for (const device of disconnectedDevices) {
      const disconnectedAt = Date.parse(device.lastSeenAt);
      if (!Number.isFinite(disconnectedAt) || Date.now() - disconnectedAt <= this.lostAgentGraceMs) {
        continue;
      }

      const commands = this.commandStore
        .listCommands({
          deviceId: device.id,
          limit: 500,
        })
        .filter((command) => command.state === 'dispatched' || command.state === 'executing');

      for (const command of commands) {
        const finishedAt = new Date().toISOString();
        const reasonCode = 'LOST_AGENT';
        const reasonDetail =
          `Device ${device.id} remained disconnected for more than ${this.lostAgentGraceMs}ms while command was ${command.state}`;

        this.commandStore.markFailed(command.commandId, reasonCode, reasonDetail, finishedAt);
        this.commandStore.appendAuditIfMissing({
          id: randomUUID(),
          commandId: command.commandId,
          ts: finishedAt,
          eventType: 'reconciled',
          source: 'reconciler',
          summary: `${command.commandType} reconciled after agent disconnect`,
          details: {
            priorState: command.state,
            reasonCode,
            reasonDetail,
            deviceId: device.id,
            disconnectedAt: device.lastSeenAt,
          },
        });
        this.commandStore.appendAuditIfMissing({
          id: randomUUID(),
          commandId: command.commandId,
          ts: finishedAt,
          eventType: 'failed',
          source: 'reconciler',
          summary: `${command.commandType} failed because agent was lost`,
          details: {
            priorState: command.state,
            reasonCode,
            reasonDetail,
          },
        });
      }
    }
  }

  private failTimedOutState(state: Extract<CommandState, 'dispatched' | 'executing'>) {
    const commands = this.commandStore.listCommands({
      state,
      limit: 500,
    });

    for (const command of commands) {
      const timedOut = this.isTimedOut(command, state);
      if (!timedOut) {
        continue;
      }

      const finishedAt = new Date().toISOString();
      const reasonCode = state === 'dispatched' ? 'DISPATCH_TIMEOUT' : 'EXECUTION_TIMEOUT';
      const reasonDetail =
        state === 'dispatched'
          ? `No terminal update arrived within ${this.dispatchTimeoutMs}ms after dispatch`
          : `No terminal update arrived within ${this.executionTimeoutMs}ms after execution started`;

      this.commandStore.markFailed(command.commandId, reasonCode, reasonDetail, finishedAt);
      this.commandStore.appendAuditIfMissing({
        id: randomUUID(),
        commandId: command.commandId,
        ts: finishedAt,
        eventType: 'failed',
        source: 'reconciler',
        summary: `${command.commandType} timed out in ${state}`,
        details: {
          state,
          reasonCode,
          reasonDetail,
        },
      });
    }
  }

  private isTimedOut(
    command: CommandRecord,
    state: Extract<CommandState, 'dispatched' | 'executing'>,
  ): boolean {
    const reference =
      state === 'executing'
        ? command.executingAt || command.dispatchedAt || command.submittedAt
        : command.dispatchedAt || command.submittedAt;
    const startedAt = Date.parse(reference);
    if (!Number.isFinite(startedAt)) {
      return false;
    }

    const timeoutMs = state === 'executing' ? this.executionTimeoutMs : this.dispatchTimeoutMs;
    return Date.now() - startedAt > timeoutMs;
  }
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
