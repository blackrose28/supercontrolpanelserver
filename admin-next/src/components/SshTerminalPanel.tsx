import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

type SshTerminalPanelProps = {
  terminal: { deviceId: string; serverId: string; sessionId: string } | null;
  title?: string;
  onTerminalClosed?: (event: { deviceId: string; serverId: string; sessionId: string; reasonCode?: string }) => void;
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

function normalizeWsMessageType(type: unknown): string {
  return typeof type === 'string' ? type.trim().toLowerCase().replace(/-/g, '_') : '';
}

function coerceTerminalData(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return '';
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const nums = value.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    if (nums.length === value.length && value.length > 0) {
      try {
        return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(nums));
      } catch {
        return '';
      }
    }
  }
  return '';
}

/** Prefer `data`, then common alternate keys / UTF-8 byte arrays from some gateways. */
function mergePtyOutputData(nested: Record<string, unknown>, root: Record<string, unknown>): string {
  return (
    coerceTerminalData(nested.data)
    || coerceTerminalData(nested.output)
    || coerceTerminalData(nested.chunk)
    || coerceTerminalData(nested.text)
    || coerceTerminalData(root.data)
    || coerceTerminalData(root.output)
  );
}

/** Merge envelope root + payload so admin PTY frames stay compatible across gateways. */
function ptyFieldsFromSocketMessage(message: unknown): {
  msgType: string;
  sessionId: string;
  data: string;
  payload: Record<string, unknown>;
} {
  const root = message && typeof message === 'object' ? (message as Record<string, unknown>) : {};
  let nested: Record<string, unknown> = {};
  const rawPayload = root.payload;
  if (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
    nested = rawPayload as Record<string, unknown>;
  } else if (typeof rawPayload === 'string') {
    try {
      const parsed = JSON.parse(rawPayload) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        nested = parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore */
    }
  }
  const sessionFromNested = typeof nested.sessionId === 'string' ? nested.sessionId : '';
  const sessionFromRoot = typeof root.sessionId === 'string' ? root.sessionId : '';
  const sessionFromNestedId = typeof nested.id === 'string' ? nested.id : '';
  const sessionFromRootId = typeof root.id === 'string' ? root.id : '';
  const sessionId = sessionFromNested || sessionFromRoot || sessionFromNestedId || sessionFromRootId;
  const data = mergePtyOutputData(nested, root);
  const rawType = root.type ?? nested.type;
  return {
    msgType: normalizeWsMessageType(rawType),
    sessionId,
    data,
    payload: nested,
  };
}

function isNonViewArrayBufferLike(raw: unknown): raw is ArrayBuffer {
  if (raw == null || typeof raw !== 'object') {
    return false;
  }
  if (ArrayBuffer.isView(raw)) {
    return false;
  }
  const tag = Object.prototype.toString.call(raw);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

async function webSocketMessageToUtf8(raw: unknown): Promise<string> {
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof Blob !== 'undefined' && raw instanceof Blob) {
    return raw.text();
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    return new TextDecoder('utf-8', { fatal: false }).decode(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }
  if (isNonViewArrayBufferLike(raw)) {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(raw));
  }
  return String(raw ?? '');
}

export function SshTerminalPanel({ terminal, title = 'SSH Terminal', onTerminalClosed }: SshTerminalPanelProps) {
  const [state, setState] = useState('idle');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onTerminalClosedRef = useRef(onTerminalClosed);

  useEffect(() => {
    onTerminalClosedRef.current = onTerminalClosed;
  }, [onTerminalClosed]);

  useEffect(() => {
    if (!terminal || !containerRef.current) {
      setState('idle');
      return undefined;
    }

    let cleanedUp = false;

    const xterm = new Terminal({
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cursorBlink: true,
      convertEol: true,
      scrollback: 10_000,
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
    if (!xterm.cols || !xterm.rows) {
      xterm.resize(DEFAULT_COLS, DEFAULT_ROWS);
    }

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        if (cleanedUp) {
          return;
        }
        try {
          fitAddon.fit();
        } catch {
          /* ignore */
        }
        if (!xterm.cols || !xterm.rows) {
          xterm.resize(DEFAULT_COLS, DEFAULT_ROWS);
        }
      });
      resizeObserver.observe(containerRef.current);
    }

    queueMicrotask(() => {
      if (cleanedUp) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        /* ignore */
      }
      if (!xterm.cols || !xterm.rows) {
        xterm.resize(DEFAULT_COLS, DEFAULT_ROWS);
      }
    });
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    let inputEnabled = true;

    const socket = new WebSocket(getPtyWebSocketUrl());
    socketRef.current = socket;
    setState('connecting');

    const dataDisposable = xterm.onData((data) => {
      if (inputEnabled && socket.readyState === WebSocket.OPEN) {
        sendPtyInput(socket, terminal, data);
      }
    });

    socket.addEventListener('open', () => {
      setState('attaching');
      console.log(
        `[PTY-TRACE] xterm: ws open — sending pty_attach deviceId=${terminal.deviceId} sessionId=${terminal.sessionId}`,
      );
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
      void (async () => {
        const rawText = await webSocketMessageToUtf8(event.data);
        let message: unknown;
        try {
          message = JSON.parse(rawText);
        } catch {
          console.warn('[PTY-TRACE] xterm: dropping non-JSON ws frame', rawText.slice(0, 80));
          return;
        }
        if (cleanedUp) {
          return;
        }
        const { msgType, sessionId: msgSessionId, data, payload } = ptyFieldsFromSocketMessage(message);
        const rootRec = message && typeof message === 'object' ? message as Record<string, unknown> : {};
        console.log(
          `[PTY-TRACE] xterm: received ws frame type=${msgType} sessionId=${msgSessionId} bytes=${typeof data === 'string' ? data.length : 0}`,
        );
        // Do not filter by sessionId: this socket is already scoped by pty_attach; mismatched ids in
        // relayed frames (local vs remote) would otherwise drop all output and local echo is off.
        if (msgType === 'pty_output' && typeof data === 'string') {
          console.log(`[PTY-TRACE] xterm: writing ${data.length} bytes to xterm`);
          xterm.write(data);
          setState('open');
        } else if (msgType === 'pty_attached') {
          setState('open');
        } else if (msgType === 'pty_opened') {
          setState(String((payload.state as string) || 'open'));
        } else if (msgType === 'pty_exit') {
          inputEnabled = false;
          setState('closed');
          onTerminalClosedRef.current?.({ deviceId: terminal.deviceId, serverId: terminal.serverId, sessionId: terminal.sessionId });
          xterm.writeln('\r\nSSH terminal closed.');
        } else if (msgType === 'pty_error') {
          const code = typeof payload.code === 'string'
            ? payload.code
            : (typeof rootRec.code === 'string' ? rootRec.code : '');
          if (code === 'PTY_NOT_FOUND' || code === 'PTY_SESSION_NOT_FOUND' || code === 'PTY_SESSION_NOT_ACTIVE') {
            inputEnabled = false;
            setState('closed');
            onTerminalClosedRef.current?.({ deviceId: terminal.deviceId, serverId: terminal.serverId, sessionId: terminal.sessionId, reasonCode: code });
            if (socket.readyState === WebSocket.OPEN) {
              socket.close();
            }
          } else {
            setState('error');
          }
          const errMsg = typeof payload.message === 'string'
            ? payload.message
            : (typeof rootRec.message === 'string' ? rootRec.message : '');
          xterm.writeln(`\r\n${errMsg || code || 'PTY error'}\r\n`);
        }
      })();
    });

    socket.addEventListener('close', () => setState('closed'));
    socket.addEventListener('error', () => {
      if (cleanedUp) return;
      setState('error');
      xterm.writeln('\r\nSSH terminal websocket error.\r\n');
    });

    return () => {
      cleanedUp = true;
      resizeObserver?.disconnect();
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
