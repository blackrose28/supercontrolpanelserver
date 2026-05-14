/**
 * For `function-status` telemetry, prefer the top-level `sessionId` (canonical on the CC plane)
 * over `payload.sessionId` when merging into DB rows and runtime summaries.
 * See `docs/pty-id-breaking-change/plan.md` Phase 1.
 */
export function coalesceFunctionStatusSessionId(
  topLevelSessionId: string | null | undefined,
  payload: Record<string, unknown>,
): string | null {
  const top = typeof topLevelSessionId === 'string' ? topLevelSessionId.trim() : '';
  if (top) {
    return top;
  }
  const raw = payload.sessionId;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return null;
}
