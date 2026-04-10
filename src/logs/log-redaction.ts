const TELEMETRY_REDACTION_RULES = [
  new RegExp(String.raw`(?<prefix>bearer\s+)[^\s"']+`, 'giu'),
  new RegExp(
    String.raw`(?<prefix>\b(?:password|passwd|otp|totp|token|secret|authorization)\b\s*(?:=|:)\s*)[^\r\n]+`,
    'gimu',
  ),
  new RegExp(
    String.raw`(?<prefix>\b(?:password|passwd|otp|totp|token|secret)\b\s+is\s+)[^\r\n]+`,
    'gimu',
  ),
];

const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'otpsecret',
  'oidcpassword',
  'oidcotpsecret',
  'mcpauthtoken',
  'ccagenttoken',
  'token',
  'secret',
  'authorization',
]);

export function redactTelemetryPayload<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        if (SENSITIVE_KEYS.has(key.toLowerCase())) {
          return [key, '[redacted]'];
        }
        return [key, redactValue(entry)];
      }),
    );
  }

  if (typeof value === 'string') {
    return redactSensitiveString(value);
  }

  return value;
}

function redactSensitiveString(input: string): string {
  return TELEMETRY_REDACTION_RULES.reduce(
    (output, rule) => output.replace(rule, '$<prefix>[redacted]'),
    input,
  );
}
