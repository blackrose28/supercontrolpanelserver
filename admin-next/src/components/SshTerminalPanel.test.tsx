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
  it('gives the xterm wrapper a definite height and padding so the terminal canvas is not collapsed', () => {
    const css = readFileSync(resolve(__dirname, '../styles/terminal.css'), 'utf8');
    const wrapperBlock = css.match(/\.ssh-xterm-wrapper\s*{(?<body>[^}]*)}/)?.groups?.body || '';

    expect(wrapperBlock).toContain('min-height: var(--runtime-summary-terminal-viewport-height, 34rem);');
    expect(wrapperBlock).toMatch(/height:\s*var\(--runtime-summary-terminal-viewport-height,\s*34rem\)/);
    expect(wrapperBlock).toContain('padding: 0.75rem;');
    expect(wrapperBlock).not.toContain('40rem');
  });

  it('ensures the container inside the wrapper has no padding or direct height limits', () => {
    const css = readFileSync(resolve(__dirname, '../styles/terminal.css'), 'utf8');
    const containerBlock = css.match(/\.ssh-xterm-container\s*{(?<body>[^}]*)}/)?.groups?.body || '';
    expect(containerBlock).not.toContain('padding:');
    expect(containerBlock).not.toMatch(/(?<!-)\bheight\b/);
  });

  it('ensures the inner xterm element and viewport match the terminal theme background', () => {
    const css = readFileSync(resolve(__dirname, '../styles/terminal.css'), 'utf8');
    const xtermBlock = css.match(/\.ssh-xterm-container\s+\.xterm,\s*\.ssh-xterm-container\s+\.xterm-viewport\s*{(?<body>[^}]*)}/)?.groups?.body || '';
    expect(xtermBlock).not.toContain('padding:');
    expect(xtermBlock).toContain('background-color: #0f172a !important;');
  });

  it('has an input line with monospace font and dark background', () => {
    const css = readFileSync(resolve(__dirname, '../styles/terminal.css'), 'utf8');
    const inputLineBlock = css.match(/\.ssh-input-line\s*{(?<body>[^}]*)}/)?.groups?.body || '';
    expect(inputLineBlock).toContain('font-family: ui-monospace');
    expect(inputLineBlock).toContain('background: #0d1425');
    expect(inputLineBlock).toContain('border-top:');
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

  it('attaches xterm to the SSH PTY websocket and renders the input line', async () => {
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
    expect(screen.getByTestId('ssh-input-line-srv-1')).toBeInTheDocument();
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
  });

  it('writes PTY output directly to xterm (no local echo reconciliation)', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });

    render(<SshTerminalPanel terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' }} />);

    const socket = MockWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', {
      data: JSON.stringify({ type: 'pty_output', payload: { sessionId: 'ssh-session-1', data: 'hello from ssh' } }),
    });
    await waitFor(() => expect(terminalWrites).toContain('hello from ssh'));
  });

  it('writes PTY output when the gateway uses pty-output and root-level fields', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });

    render(<SshTerminalPanel terminal={{ deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' }} />);

    const socket = MockWebSocket.instances[0];
    socket.emit('open');

    socket.emit('message', {
      data: JSON.stringify({ type: 'pty-output', sessionId: 'ssh-session-1', data: 'echo ok' }),
    });
    await waitFor(() => expect(terminalWrites).toContain('echo ok'));
  });

  it('writes PTY output when payload is a JSON string', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
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

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not reconnect when only onTerminalClosed callback identity changes', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket as any);
    Object.defineProperty(window, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      configurable: true,
    });

    const terminal = { deviceId: 'dev-1', serverId: 'srv-1', sessionId: 'ssh-session-1' };
    const { rerender } = render(<SshTerminalPanel terminal={terminal} onTerminalClosed={() => {}} />);
    const socket = MockWebSocket.instances[0];
    socket.emit('open');

    rerender(<SshTerminalPanel terminal={terminal} onTerminalClosed={() => {}} />);

    expect(MockWebSocket.instances).toHaveLength(1);
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

  // ─── Input line + batching tests ────────────────────────────

  it('does NOT write user input to xterm directly (no local echo in terminal)', async () => {
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

    // Type characters — should NOT appear in xterm (only in input line)
    terminalDataHandlers[0]('abc');
    expect(terminalWrites).toHaveLength(0);
  });

  it('shows typed characters in the input line overlay', async () => {
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

    terminalDataHandlers[0]('hello');
    await waitFor(() => {
      expect(screen.getByTestId('ssh-input-line-srv-1').textContent).toContain('hello');
    });
  });

  it('batches printable input and sends on Enter', async () => {
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

    // Type printable chars — should NOT send yet
    terminalDataHandlers[0]('ls');
    const writesAfterTyping = socket.sent.filter((s) => JSON.parse(s).type === 'pty_write');
    expect(writesAfterTyping).toHaveLength(0);

    // Press Enter — should batch-send 'ls\r'
    terminalDataHandlers[0]('\r');
    const writesAfterEnter = socket.sent.filter((s) => JSON.parse(s).type === 'pty_write');
    expect(writesAfterEnter).toHaveLength(1);
    expect(JSON.parse(writesAfterEnter[0]).payload.data).toBe('ls\r');
  });

  it('clears input line after Enter', async () => {
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

    terminalDataHandlers[0]('pwd');
    terminalDataHandlers[0]('\r');

    await waitFor(() => {
      const inputLine = screen.getByTestId('ssh-input-line-srv-1');
      const textSpan = inputLine.querySelector('.ssh-input-line-text');
      expect(textSpan?.textContent).toBe('');
    });
  });

  it('flushes buffer and sends special keys immediately (arrow keys)', async () => {
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

    // Type some chars then press Up arrow
    terminalDataHandlers[0]('abc');
    terminalDataHandlers[0]('\x1b[A');

    const writes = socket.sent.filter((s) => JSON.parse(s).type === 'pty_write');
    // Should have 2 writes: batch flush 'abc' + immediate arrow key
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0]).payload.data).toBe('abc');
    expect(JSON.parse(writes[1]).payload.data).toBe('\x1b[A');
  });

  it('handles Backspace in the input line (removes last char)', async () => {
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

    terminalDataHandlers[0]('abc');
    terminalDataHandlers[0]('\x7f'); // backspace

    await waitFor(() => {
      expect(screen.getByTestId('ssh-input-line-srv-1').textContent).toContain('ab');
    });

    // Should not have sent anything to the server yet
    const writes = socket.sent.filter((s) => JSON.parse(s).type === 'pty_write');
    expect(writes).toHaveLength(0);
  });
});
