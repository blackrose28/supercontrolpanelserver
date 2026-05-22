/**
 * Canonical CC-plane PTY session id (`ccpty:{deviceId}:{localSessionId}`).
 * Must match `src-tauri/src/cc/pty_session_id.rs`. See `docs/pty-id-breaking-change/plan.md`.
 */

const PREFIX = 'ccpty:';
/**
 * Per-segment cap for canonical id construction. UUID v4 is 36 chars; this leaves
 * comfortable headroom while preventing pathological inputs from reaching DB rows
 * or `device_runtime_state` summaries via this code path.
 */
export const CC_PTY_SEGMENT_MAX = 128;
/**
 * Hard cap on a wire-provided session id passed through `verifyCanonicalSessionIdForDevice`.
 * Anything longer is rejected outright (caller emits a warning and drops the event).
 */
export const CC_PTY_SESSION_ID_MAX = PREFIX.length + CC_PTY_SEGMENT_MAX * 2 + 1;

export function ccPtySessionId(deviceId: string, localSessionId: string): string {
  const d = deviceId.trim();
  const l = localSessionId.trim();
  if (!d || !l) {
    throw new Error('deviceId and localSessionId must be non-empty');
  }
  if (d.length > CC_PTY_SEGMENT_MAX || l.length > CC_PTY_SEGMENT_MAX) {
    throw new Error(`deviceId and localSessionId must each be ≤ ${CC_PTY_SEGMENT_MAX} chars`);
  }
  if (d.includes(':') || l.includes(':')) {
    throw new Error("deviceId and localSessionId must not contain ':'");
  }
  return `${PREFIX}${d}:${l}`;
}

/** New CC-plane id for admin-initiated server SSH open (random local segment, no colons). */
export function newServerSshStartSessionId(deviceId: string): string {
  const id =
    typeof globalThis !== 'undefined' &&
    globalThis.crypto &&
    typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `id-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return ccPtySessionId(deviceId, id);
}

/** Canonical attach id; optional client `requestedSessionId` must match. */
export function resolveServerSshAttachSessionId(
  deviceId: string,
  localSessionId: string,
  requestedSessionId?: string,
): string {
  const canonical = ccPtySessionId(deviceId, localSessionId);
  const req = requestedSessionId?.trim();
  if (req && req !== canonical) {
    throw new Error('sessionId does not match ccpty canonical id for this device and localSessionId');
  }
  return canonical;
}

export function parseCcPtySessionId(
  sessionId: string,
): { deviceId: string; localSessionId: string } | null {
  const s = sessionId.trim();
  if (s.length > CC_PTY_SESSION_ID_MAX) {
    return null;
  }
  if (!s.startsWith(PREFIX)) {
    return null;
  }
  const rest = s.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0 || colon >= rest.length - 1) {
    return null;
  }
  const deviceId = rest.slice(0, colon);
  const localSessionId = rest.slice(colon + 1);
  if (
    !deviceId ||
    !localSessionId ||
    localSessionId.includes(':') ||
    deviceId.length > CC_PTY_SEGMENT_MAX ||
    localSessionId.length > CC_PTY_SEGMENT_MAX
  ) {
    return null;
  }
  return { deviceId, localSessionId };
}

/**
 * Verify a wire-provided session id belongs to the authenticated agent.
 *
 * - Canonical `ccpty:...` ids are accepted only when their embedded `deviceId`
 *   matches the connected agent's device. Mismatches are rejected so that one
 *   authenticated agent cannot spoof another device's PTY stream.
 * - Non-canonical strings (legacy local-only ids, OpenVPN/Boundary local ids)
 *   are passed through unchanged — they are not addressable on the CC plane.
 * - Returns `{ ok: true, sessionId: null }` for nullish / empty / whitespace input.
 */
export function verifyCanonicalSessionIdForDevice(
  authenticatedDeviceId: string,
  sessionId: string | null | undefined,
): { ok: true; sessionId: string | null } | { ok: false; reason: string } {
  if (sessionId == null) {
    return { ok: true, sessionId: null };
  }
  const trimmed = sessionId.trim();
  if (!trimmed) {
    return { ok: true, sessionId: null };
  }
  if (trimmed.length > CC_PTY_SESSION_ID_MAX) {
    return {
      ok: false,
      reason: `sessionId exceeds max length ${CC_PTY_SESSION_ID_MAX} (got ${trimmed.length})`,
    };
  }
  const parsed = parseCcPtySessionId(trimmed);
  if (!parsed) {
    return { ok: true, sessionId: trimmed };
  }
  if (parsed.deviceId !== authenticatedDeviceId) {
    return {
      ok: false,
      reason: `canonical sessionId device mismatch: expected ${authenticatedDeviceId}, got ${parsed.deviceId}`,
    };
  }
  return { ok: true, sessionId: trimmed };
}
