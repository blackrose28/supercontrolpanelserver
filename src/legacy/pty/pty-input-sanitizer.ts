export function sanitizePtyInput(value: string): { data: string; filtered: boolean } {
  let filtered = false;
  const normalized = value.replace(/\r\n/g, '\n');
  let output = '';
  for (const char of normalized) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x1b) {
      filtered = true;
      continue;
    }
    if (code === 0x03 || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x7f) {
      output += char;
      continue;
    }
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x80 && code <= 0x9f)) {
      filtered = true;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdfff) {
      output += '\uFFFD';
      filtered = true;
      continue;
    }
    output += char;
  }
  return { data: output, filtered };
}
