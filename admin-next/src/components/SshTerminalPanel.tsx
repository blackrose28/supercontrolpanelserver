import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

type SshTerminalPanelProps = {
  terminal: { deviceId: string; serverId: string; sessionId: string } | null;
  title?: string;
};

function getCsrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content')?.trim() || '';
}

function getPtyWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/admin/ws/pty`;
}

function sendPtyInput(socket: WebSocket, activeTerminal: NonNullable<SshTerminalPanelProps['terminal']>, data: string) {
  socket.send(JSON.stringify({
    type: 'pty_write',
    payload: {
      deviceId: activeTerminal.deviceId,
      sessionId: activeTerminal.sessionId,
      data,
      csrfToken: getCsrfToken(),
    },
  }));
}

export function SshTerminalPanel({ terminal, title = 'SSH Terminal' }: SshTerminalPanelProps) {
  const [state, setState] = useState('idle');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  useEffect(() => {
    if (!terminal || !containerRef.current) {
      setState('idle');
      return undefined;
    }

    const xterm = new Terminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#0f172a',
        foreground: '#dbeafe',
      },
    });
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);
    try {
      fitAddon.fit();
    } catch {
      // Fit can fail in jsdom or hidden containers; keep the requested PTY size.
    }
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    let cleanedUp = false;

    const socket = new WebSocket(getPtyWebSocketUrl());
    socketRef.current = socket;
    setState('connecting');

    const dataDisposable = xterm.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        sendPtyInput(socket, terminal, data);
      }
    });

    socket.addEventListener('open', () => {
      setState('attaching');
      socket.send(JSON.stringify({
        type: 'pty_attach',
        payload: {
          deviceId: terminal.deviceId,
          sessionId: terminal.sessionId,
          csrfToken: getCsrfToken(),
        },
      }));
      socket.send(JSON.stringify({
        type: 'pty_resize',
        payload: {
          deviceId: terminal.deviceId,
          sessionId: terminal.sessionId,
          cols: xterm.cols || DEFAULT_COLS,
          rows: xterm.rows || DEFAULT_ROWS,
          csrfToken: getCsrfToken(),
        },
      }));
    });

    socket.addEventListener('message', (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const payload = message?.payload && typeof message.payload === 'object' ? message.payload : {};
      if (payload.sessionId && payload.sessionId !== terminal.sessionId) {
        return;
      }
      if (message?.type === 'pty_output' && typeof payload.data === 'string') {
        xterm.write(payload.data);
        setState('open');
      } else if (message?.type === 'pty_opened') {
        setState(String(payload.state || 'open'));
      } else if (message?.type === 'pty_exit') {
        setState('closed');
        xterm.writeln('\r\nSSH terminal closed.');
      } else if (message?.type === 'pty_error') {
        setState('error');
        xterm.writeln(`\r\n${payload.message || payload.code || 'PTY error'}\r\n`);
      }
    });

    socket.addEventListener('close', () => setState('closed'));
    socket.addEventListener('error', () => {
      if (cleanedUp) return;
      setState('error');
      xterm.writeln('\r\nSSH terminal websocket error.\r\n');
    });

    return () => {
      cleanedUp = true;
      dataDisposable.dispose();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'pty_detach',
          payload: {
            deviceId: terminal.deviceId,
            sessionId: terminal.sessionId,
            csrfToken: getCsrfToken(),
          },
        }));
      }
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.close();
      }
      xterm.dispose();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      if (xtermRef.current === xterm) {
        xtermRef.current = null;
      }
      if (fitAddonRef.current === fitAddon) {
        fitAddonRef.current = null;
      }
    };
  }, [terminal?.deviceId, terminal?.serverId, terminal?.sessionId]);

  if (!terminal) {
    return null;
  }

  return (
    <section className="ssh-terminal-section" aria-label={title}>
      <div className="ssh-terminal-header">
        <div>
          <h4>{title}</h4>
          <p className="runtime-summary-subtitle">Interactive PTY for server {terminal.serverId}.</p>
        </div>
        <span className="command-state-badge">{state}</span>
      </div>
      <div ref={containerRef} className="ssh-xterm-container" data-testid={`ssh-xterm-${terminal.serverId}`} />
    </section>
  );
}
