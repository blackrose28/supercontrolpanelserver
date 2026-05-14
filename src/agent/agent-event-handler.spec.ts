import { describe, expect, it, vi } from 'vitest';
import {
  handleAgentFunctionStatus,
  handleAgentPtyExit,
  handleAgentPtyOutput,
} from './agent-event-handler';

function makeDeps() {
  return {
    logStore: { append: vi.fn() } as any,
    ptySessionStore: {
      noteOutput: vi.fn(),
      markClosed: vi.fn(() => ({ sessionId: 'ignored', deviceId: 'ignored', closedAt: null })),
    } as any,
    ptyHub: { appendOutput: vi.fn(), broadcast: vi.fn() } as any,
    ptyAudit: { append: vi.fn() } as any,
  };
}

describe('agent-event-handler — canonical sessionId device verification', () => {
  it('handleAgentPtyOutput rejects ccpty ids whose embedded device != client', () => {
    const deps = makeDeps();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    handleAgentPtyOutput({
      envelope: {
        type: 'pty-output',
        sessionId: 'ccpty:other-device:loc-x',
        payload: { data: 'leaked' },
      },
      client: { deviceId: 'authenticated-device' },
      logStore: deps.logStore,
      ptySessionStore: deps.ptySessionStore,
      ptyHub: deps.ptyHub,
    });

    expect(deps.logStore.append).not.toHaveBeenCalled();
    expect(deps.ptyHub.broadcast).not.toHaveBeenCalled();
    expect(deps.ptyHub.appendOutput).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Rejected pty-output from authenticated-device'));
    warn.mockRestore();
  });

  it('handleAgentPtyOutput accepts ccpty ids that match the agent', () => {
    const deps = makeDeps();
    handleAgentPtyOutput({
      envelope: {
        type: 'pty-output',
        sessionId: 'ccpty:agent-1:loc-x',
        payload: { data: 'hello' },
        seq: 7,
      },
      client: { deviceId: 'agent-1' },
      logStore: deps.logStore,
      ptySessionStore: deps.ptySessionStore,
      ptyHub: deps.ptyHub,
    });

    expect(deps.logStore.append).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'agent-1', sessionId: 'ccpty:agent-1:loc-x' }),
    );
    expect(deps.ptyHub.broadcast).toHaveBeenCalledWith(
      'ccpty:agent-1:loc-x',
      expect.objectContaining({ type: 'pty_output' }),
    );
  });

  it('handleAgentPtyOutput passes through legacy local-only ids', () => {
    const deps = makeDeps();
    handleAgentPtyOutput({
      envelope: {
        type: 'pty-output',
        payload: { id: 'pty-7', data: 'legacy' },
      },
      client: { deviceId: 'agent-1' },
      logStore: deps.logStore,
      ptySessionStore: deps.ptySessionStore,
      ptyHub: deps.ptyHub,
    });

    expect(deps.logStore.append).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-7' }),
    );
  });

  it('handleAgentPtyExit rejects spoofed ccpty ids', () => {
    const deps = makeDeps();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    handleAgentPtyExit({
      envelope: {
        type: 'pty-exit',
        sessionId: 'ccpty:other-device:loc-x',
        payload: { exitCode: 0 },
      },
      client: { deviceId: 'authenticated-device' },
      logStore: deps.logStore,
      ptySessionStore: deps.ptySessionStore,
      ptyAudit: deps.ptyAudit,
      ptyHub: deps.ptyHub,
    });

    expect(deps.logStore.append).not.toHaveBeenCalled();
    expect(deps.ptySessionStore.markClosed).not.toHaveBeenCalled();
    expect(deps.ptyAudit.append).not.toHaveBeenCalled();
    expect(deps.ptyHub.broadcast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Rejected pty-exit from authenticated-device'));
    warn.mockRestore();
  });

  it('handleAgentFunctionStatus rejects spoofed ccpty ids', () => {
    const logAppend = vi.fn();
    const sendMessage = vi.fn();
    const advanceRestart = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    handleAgentFunctionStatus({
      envelope: {
        type: 'function-status',
        sessionId: 'ccpty:other-device:loc-x',
        payload: { functionId: 'server-ssh-srv-1', state: 'running' },
      },
      client: { deviceId: 'authenticated-device' },
      logStore: { append: logAppend } as any,
      redactTelemetryPayload: (p: unknown) => p,
      sendMessage,
      advanceRestartCommandFromFunctionStatus: advanceRestart,
    });

    expect(logAppend).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(advanceRestart).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Rejected function-status from authenticated-device'),
    );
    warn.mockRestore();
  });
});
