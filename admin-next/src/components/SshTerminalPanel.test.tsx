import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const terminalWrites: string[] = [];
const terminalDataHandlers: Array<(data: string) => void> = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function Terminal() {
    return {
    cols: 120,
    rows: 32,
    loadAddon: vi.fn(),
    open: vi.fn(),
    resize: vi.fn(),
    write: vi.fn((data: string) => terminalWrites.push(data)),
    writeln: vi.fn((data: string) => terminalWrites.push(`${data}\n`)),
    onData: vi.fn((handler: (data: string) => void) => {
      terminalDataHandlers.push(handler);
      return { dispose: vi.fn() };
    }),
    dispose: vi.fn(),
  };
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(function FitAddon() { return { fit: vi.fn() }; }),
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { SshTerminalPanel } from './SshTerminalPanel';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  listeners: Record<string, Array<(event?: any) => void>> = {};

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: any) => void) {
    this.listeners[type] = [...(this.listeners[type] || []), listener];
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  emit(type: string, event?: any) {
    for (const listener of this.listeners[type] || []) {
      listener(event);
    }
  }
}

describe('SshTerminalPanel styling', () => {
  it('gives the xterm wrapper a definite height so the terminal canvas is not collapsed', () => {
    const css = readFileSync(resolve(__dirname, '../app.css'), 'utf8');
    const containerBlock = css.match(/\.ssh-xterm-container\s*{(?<body>[^}]*)}/)?.groups?.body || '';

    expect(containerBlock).toContain('min-height: var(--runtime-summary-terminal-viewport-height, 34rem);');
    expect(containerBlock).toMatch(/height:\s*var\(--runtime-summary-terminal-viewport-height,\s*34rem\)/);
    expect(containerBlock).not.toContain('40rem');
  });
});

describe('SshTerminalPanel', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    MockWebSocket.instances = [];
    terminalWrites.length = 0;
    terminalDataHandlers.length = 0;
  });

  it('attaches xterm to the SSH PTY websocket and sends terminal input', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-terminal' } as unknown as Element;
      }
      return null;
    });

    render(<SshTerminalPanel terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' }} />);

    expect(screen.getByLabelText('SSH Terminal')).toBeInTheDocument();
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toBe('ws://localhost:3000/admin/ws/pty');
    socket.emit('open');

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'pty_attach',
      payload: { deviceId: 'dev-1', sessionId: 'ssh-session-1', csrfToken: 'csrf-terminal' },
    });
    expect(JSON.parse(socket.sent[1])).toMatchObject({
      type: 'pty_resize',
      payload: { deviceId: 'dev-1', sessionId: 'ssh-session-1', cols: 120, rows: 32 },
    });

    socket.emit('message', {
      data: JSON.stringify({ type: 'pty_output', payload: { sessionId: 'ssh-session-1', data: 'hello from ssh' } }),
    });
    await waitFor(() => expect(terminalWrites).toContain('hello from ssh'));

    terminalDataHandlers[0]('uptime\r');

    expect(JSON.parse(socket.sent[2])).toEqual({
      type: 'pty_write',
      payload: { deviceId: 'dev-1', sessionId: 'ssh-session-1', data: 'uptime\r', csrfToken: 'csrf-terminal' },
    });
  });

  it('writes PTY output when the gateway uses pty-output and root-level fields', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-terminal' } as unknown as Element;
      }
      return null;
    });

    render(<SshTerminalPanel terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' }} />);

    const socket = MockWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', {
      data: JSON.stringify({
        type: 'pty-output',
        sessionId: 'ssh-session-1',
        data: 'echo ok',
      }),
    });
    await waitFor(() => expect(terminalWrites).toContain('echo ok'));
  });

  it('writes PTY output when payload is a JSON string', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-terminal' } as unknown as Element;
      }
      return null;
    });

    render(<SshTerminalPanel terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' }} />);

    const socket = MockWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', {
      data: JSON.stringify({
        type: 'pty_output',
        payload: JSON.stringify({ sessionId: 'ssh-session-1', data: 'nested string payload' }),
      }),
    });
    await waitFor(() => expect(terminalWrites).toContain('nested string payload'));
  });

  it('writes PTY output when data is a UTF-8 byte array', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-terminal' } as unknown as Element;
      }
      return null;
    });

    render(<SshTerminalPanel terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' }} />);

    const socket = MockWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', {
      data: JSON.stringify({
        type: 'pty_output',
        payload: { sessionId: 'ssh-session-1', data: [72, 105] },
      }),
    });
    await waitFor(() => expect(terminalWrites).toContain('Hi'));
  });

  it('writes PTY output from a binary ArrayBuffer websocket frame', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-terminal' } as unknown as Element;
      }
      return null;
    });

    render(<SshTerminalPanel terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' }} />);

    const socket = MockWebSocket.instances[0];
    socket.emit('open');

    const json = JSON.stringify({
      type: 'pty_output',
      payload: { sessionId: 'ssh-session-1', data: 'binary frame ok' },
    });
    const u8 = new TextEncoder().encode(json);
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

    socket.emit('message', { data: buf });
    await waitFor(() => expect(terminalWrites).toContain('binary frame ok'));
  });

  it('writes PTY output even when payload sessionId does not match the terminal (socket is already scoped)', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-terminal' } as unknown as Element;
      }
      return null;
    });

    render(<SshTerminalPanel terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'remote-session' }} />);

    const socket = MockWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', {
      data: JSON.stringify({
        type: 'pty_output',
        payload: { sessionId: 'some-other-id', data: 'still shown' },
      }),
    });
    await waitFor(() => expect(terminalWrites).toContain('still shown'));
  });

  it('keeps the websocket attached when rerendered with the same terminal identity', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-terminal' } as unknown as Element;
      }
      return null;
    });

    const terminal = { deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' };
    const { rerender } = render(<SshTerminalPanel terminal={terminal} />);
    const socket = MockWebSocket.instances[0];
    socket.emit('open');

    rerender(<SshTerminalPanel terminal={{ ...terminal }} />);
    terminalDataHandlers[0]('a');

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['pty_attach', 'pty_resize', 'pty_write']);
    expect(JSON.parse(socket.sent[2])).toEqual({
      type: 'pty_write',
      payload: { deviceId: 'dev-1', sessionId: 'ssh-session-1', data: 'a', csrfToken: 'csrf-terminal' },
    });
  });

  it('does not reconnect when only onTerminalClosed callback identity changes', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });
    vi.spyOn(document, 'querySelector').mockImplementation((selector: string) => {
      if (selector === 'meta[name="csrf-token"]') {
        return { getAttribute: () => 'csrf-terminal' } as unknown as Element;
      }
      return null;
    });

    const terminal = { deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' };
    const { rerender } = render(<SshTerminalPanel terminal={terminal} onTerminalClosed={() => {}} />);
    const socket = MockWebSocket.instances[0];
    socket.emit('open');

    rerender(<SshTerminalPanel terminal={terminal} onTerminalClosed={() => {}} />);
    terminalDataHandlers[0]('a');

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['pty_attach', 'pty_resize', 'pty_write']);
  });

  it('does not write transient connection text into terminal scrollback', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });

    render(<SshTerminalPanel terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' }} />);

    expect(terminalWrites).not.toContain('Connecting to SSH terminal…\n');
  });

  it('does not send synthetic Enter when the PTY attaches without output', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });

    render(<SshTerminalPanel terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' }} />);

    const socket = MockWebSocket.instances[0];
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({ type: 'pty_opened', payload: { sessionId: 'ssh-session-1', state: 'open' } }),
    });

    await waitFor(() => expect(screen.getByText('open')).toBeInTheDocument());

    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['pty_attach', 'pty_resize']);
  });

  it('stops forwarding input after the PTY is reported missing', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });

    render(<SshTerminalPanel terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'stale-session-1' }} />);

    const socket = MockWebSocket.instances[0];
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({
        type: 'pty_error',
        payload: { sessionId: 'stale-session-1', code: 'PTY_NOT_FOUND', message: 'PTY session not found' },
      }),
    });

    await waitFor(() => expect(screen.getByText('closed')).toBeInTheDocument());
    terminalDataHandlers[0]('uptime\r');

    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['pty_attach', 'pty_resize']);
  });

  it('notifies the parent when the PTY is reported missing so stale terminals can be pruned', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });
    const onTerminalClosed = vi.fn();

    render(
      <SshTerminalPanel
        terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'stale-session-1' }}
        onTerminalClosed={onTerminalClosed}
      />,
    );

    const socket = MockWebSocket.instances[0];
    socket.emit('open');
    socket.emit('message', {
      data: JSON.stringify({
        type: 'pty_error',
        payload: { sessionId: 'stale-session-1', code: 'PTY_SESSION_NOT_ACTIVE', message: 'PTY session is not active' },
      }),
    });

    await waitFor(() => expect(onTerminalClosed).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      serverId: 'srv-1',
      sessionId: 'stale-session-1',
      reasonCode: 'PTY_SESSION_NOT_ACTIVE',
    }));
  });
});
