export function getClientId(
  forwardedFor?: string,
  realIp?: string,
  remoteAddress?: string,
): string {
  const forwarded = forwardedFor?.split(',')[0]?.trim();
  return forwarded || realIp || remoteAddress || 'unknown';
}
