/**
 * Input buffer for the admin SSH terminal panel.
 *
 * Accumulates keystrokes locally and provides instant display text.
 * Flushes the buffer to the server on Enter, special keys, or via
 * manual drain (debounce timer).
 *
 * This replaces the speculative echo approach — the input line is a separate
 * DOM element, so there is no prediction/reconciliation with pty_output.
 */

export interface PushResult {
  /** Current text to show in the input line overlay. */
  display: string;
  /** Accumulated buffer to send as a batch pty_write, or null if nothing to flush. */
  flush: string | null;
  /** Special key data to send immediately after flush, or null. */
  immediate: string | null;
}

function isPrintable(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x20 && code <= 0x7e) || code >= 0x80;
}

function isEnter(ch: string): boolean {
  return ch === '\r' || ch === '\n';
}

function isBackspace(ch: string): boolean {
  return ch === '\x7f' || ch === '\b';
}

function isEscapeSequence(data: string): boolean {
  return data.length > 0 && data.charCodeAt(0) === 0x1b;
}

function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  // Exclude \r, \n (Enter), \b and \x7f (Backspace) — handled separately
  return code < 0x20 && code !== 0x0d && code !== 0x0a && code !== 0x08;
}

export class PtyInputBuffer {
  /** Raw keystroke buffer (what gets sent to the server). */
  private buffer = '';
  /** Display-friendly version (printable chars only, with backspace edits applied). */
  private display = '';

  /** Current text shown in the input line overlay. */
  get displayText(): string {
    return this.display;
  }

  /**
   * Push a keystroke (or pasted text) into the buffer.
   *
   * Returns what to do:
   * - `display`: updated input line text
   * - `flush`: batch data to send as pty_write (if triggered)
   * - `immediate`: special key to send right after flush (if any)
   */
  push(data: string): PushResult {
    if (!data) {
      return { display: this.display, flush: null, immediate: null };
    }

    // Check for Enter anywhere in the input — triggers immediate flush
    for (let i = 0; i < data.length; i++) {
      if (isEnter(data[i])) {
        // Everything before Enter goes into the buffer
        const before = data.slice(0, i);
        if (before) {
          this.appendPrintable(before);
        }
        // Flush buffer + the Enter character
        const flushed = this.buffer + data[i];
        this.buffer = '';
        this.display = '';
        return { display: '', flush: flushed, immediate: null };
      }
    }

    // Single character analysis
    const firstChar = data[0];

    // Escape sequences (arrow keys, etc.) — flush buffer + send immediately
    if (isEscapeSequence(data)) {
      const flush = this.buffer || null;
      this.buffer = '';
      this.display = '';
      return { display: '', flush, immediate: data };
    }

    // Control characters (Ctrl+C, Ctrl+D, Tab, etc.) — flush buffer + send immediately
    if (data.length === 1 && (isControlChar(firstChar) || firstChar === '\t')) {
      const flush = this.buffer || null;
      this.buffer = '';
      this.display = '';
      return { display: '', flush, immediate: data };
    }

    // Backspace
    if (data.length === 1 && isBackspace(firstChar)) {
      if (this.display.length > 0) {
        // Remove last char from display and buffer
        this.display = this.display.slice(0, -1);
        this.buffer = this.buffer.slice(0, -1);
        return { display: this.display, flush: null, immediate: null };
      }
      // Buffer is empty — send backspace immediately (server handles it)
      return { display: '', flush: null, immediate: data };
    }

    // Printable characters — buffer them
    this.appendPrintable(data);
    return { display: this.display, flush: null, immediate: null };
  }

  /**
   * Drain the buffer (called on debounce timer expiry).
   * Returns the accumulated data to send, or null if empty.
   */
  drain(): string | null {
    if (!this.buffer) return null;
    const data = this.buffer;
    this.buffer = '';
    this.display = '';
    return data;
  }

  /** Clear buffer and display without sending anything. */
  clear(): void {
    this.buffer = '';
    this.display = '';
  }

  private appendPrintable(data: string): void {
    for (const ch of data) {
      if (isPrintable(ch)) {
        this.buffer += ch;
        this.display += ch;
      }
    }
  }
}
