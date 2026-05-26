import { describe, expect, it, beforeEach } from 'vitest';
import { PtyInputBuffer } from './input-buffer';

describe('PtyInputBuffer', () => {
  let buf: PtyInputBuffer;

  beforeEach(() => {
    buf = new PtyInputBuffer();
  });

  describe('push() with printable characters', () => {
    it('buffers printable chars and returns display text', () => {
      const result = buf.push('a');
      expect(result.display).toBe('a');
      expect(result.flush).toBeNull();
      expect(result.immediate).toBeNull();
    });

    it('accumulates multiple printable chars', () => {
      buf.push('h');
      buf.push('e');
      const result = buf.push('l');
      expect(result.display).toBe('hel');
    });

    it('handles pasted multi-character input', () => {
      const result = buf.push('hello');
      expect(result.display).toBe('hello');
      expect(result.flush).toBeNull();
    });

    it('buffers space as printable', () => {
      buf.push('hi');
      const result = buf.push(' ');
      expect(result.display).toBe('hi ');
      expect(result.flush).toBeNull();
    });
  });

  describe('push() with Enter', () => {
    it('flushes accumulated buffer + \\r on Enter', () => {
      buf.push('ls');
      const result = buf.push('\r');
      expect(result.flush).toBe('ls\r');
      expect(result.display).toBe('');
      expect(result.immediate).toBeNull();
    });

    it('flushes just \\r when buffer is empty', () => {
      const result = buf.push('\r');
      expect(result.flush).toBe('\r');
      expect(result.display).toBe('');
    });

    it('flushes on \\n as well', () => {
      buf.push('pwd');
      const result = buf.push('\n');
      expect(result.flush).toBe('pwd\n');
      expect(result.display).toBe('');
    });
  });

  describe('push() with Backspace', () => {
    it('removes last character from display', () => {
      buf.push('abc');
      const result = buf.push('\x7f');
      expect(result.display).toBe('ab');
      expect(result.flush).toBeNull();
    });

    it('handles 0x08 backspace variant', () => {
      buf.push('abc');
      const result = buf.push('\b');
      expect(result.display).toBe('ab');
    });

    it('does nothing when display is empty — sends backspace immediately', () => {
      const result = buf.push('\x7f');
      expect(result.display).toBe('');
      expect(result.immediate).toBe('\x7f');
    });

    it('multiple backspaces remove multiple chars', () => {
      buf.push('abc');
      buf.push('\x7f');
      const result = buf.push('\x7f');
      expect(result.display).toBe('a');
    });
  });

  describe('push() with special keys (immediate flush)', () => {
    it('flushes buffer and sends arrow key immediately', () => {
      buf.push('abc');
      const result = buf.push('\x1b[A'); // Up arrow
      expect(result.flush).toBe('abc');
      expect(result.immediate).toBe('\x1b[A');
      expect(result.display).toBe('');
    });

    it('sends arrow key immediately when buffer is empty', () => {
      const result = buf.push('\x1b[A');
      expect(result.flush).toBeNull();
      expect(result.immediate).toBe('\x1b[A');
      expect(result.display).toBe('');
    });

    it('flushes buffer and sends Tab immediately', () => {
      buf.push('ls ');
      const result = buf.push('\t');
      expect(result.flush).toBe('ls ');
      expect(result.immediate).toBe('\t');
      expect(result.display).toBe('');
    });

    it('flushes buffer and sends Ctrl+C immediately', () => {
      buf.push('long');
      const result = buf.push('\x03');
      expect(result.flush).toBe('long');
      expect(result.immediate).toBe('\x03');
      expect(result.display).toBe('');
    });

    it('sends Ctrl+D immediately', () => {
      const result = buf.push('\x04');
      expect(result.flush).toBeNull();
      expect(result.immediate).toBe('\x04');
    });

    it('sends Escape immediately', () => {
      const result = buf.push('\x1b');
      expect(result.flush).toBeNull();
      expect(result.immediate).toBe('\x1b');
    });
  });

  describe('drain()', () => {
    it('returns accumulated buffer and clears it', () => {
      buf.push('hello');
      const drained = buf.drain();
      expect(drained).toBe('hello');
      expect(buf.push('a').display).toBe('a'); // buffer was reset
    });

    it('returns null when buffer is empty', () => {
      expect(buf.drain()).toBeNull();
    });

    it('clears display text after drain', () => {
      buf.push('test');
      buf.drain();
      // After drain, pushing a new char starts fresh
      expect(buf.push('x').display).toBe('x');
    });
  });

  describe('clear()', () => {
    it('clears buffer and display', () => {
      buf.push('abc');
      buf.clear();
      expect(buf.drain()).toBeNull();
      expect(buf.push('x').display).toBe('x');
    });
  });

  describe('displayText getter', () => {
    it('returns current display text', () => {
      expect(buf.displayText).toBe('');
      buf.push('abc');
      expect(buf.displayText).toBe('abc');
    });

    it('reflects backspace changes', () => {
      buf.push('abc');
      buf.push('\x7f');
      expect(buf.displayText).toBe('ab');
    });

    it('is empty after flush', () => {
      buf.push('abc');
      buf.push('\r');
      expect(buf.displayText).toBe('');
    });
  });

  describe('mixed input with printable trailing after control', () => {
    it('handles printable chars after a paste that includes \\r', () => {
      // "ls\r" in one paste — should flush "ls\r"
      const result = buf.push('ls\r');
      expect(result.flush).toBe('ls\r');
      expect(result.display).toBe('');
    });
  });
});
