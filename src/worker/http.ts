import type { WorkerEnv } from './types';

export function applySecurityHeaders(headers: Headers): Headers {
  if (!headers.has('x-content-type-options')) headers.set('x-content-type-options', 'nosniff');
  if (!headers.has('referrer-policy')) headers.set('referrer-policy', 'no-referrer');
  if (!headers.has('permissions-policy')) headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  if (!headers.has('content-security-policy')) headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'self'; base-uri 'none'");
  return headers;
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = applySecurityHeaders(new Headers(init.headers));
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json; charset=utf-8');
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function redirectResponse(location: string, init: ResponseInit = {}): Response {
  const headers = applySecurityHeaders(new Headers(init.headers));
  headers.set('location', location);
  return new Response(null, { ...init, status: init.status ?? 302, headers });
}

export const ADMIN_SESSION_COOKIE = 'cc_admin_session';
export const ADMIN_CSRF_COOKIE = 'cc_admin_csrf';

export function parseCookies(cookieHeader?: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) continue;
    result[rawKey] = decodeURIComponent(rest.join('=') || '');
  }
  return result;
}

export function appendCookie(headers: Headers, name: string, value: string, options: { httpOnly?: boolean; maxAge?: number; path?: string; sameSite?: 'Strict' | 'Lax' | 'None'; secure?: boolean } = {}): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push('Secure');
  headers.append('set-cookie', parts.join('; '));
}

export async function parseRequestFields(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return parseJsonBody(request);
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(await request.text());
    return Object.fromEntries(form.entries());
  }
  try {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch {
    return {};
  }
}

export function getClientId(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = request.headers.get('x-real-ip')?.trim();
  return forwardedFor || realIp || 'unknown';
}

export async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function clampNumber(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export type SsePoller = () => Promise<string[]>;

export function sseStreamResponse(frames: string[], poll?: { intervalMs: number; next: SsePoller }): Response {
  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let pollInterval: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const initial = frames.length ? frames.join('') : ': connected\n\n';
      controller.enqueue(encoder.encode(initial));
      if (poll) {
        pollInterval = setInterval(() => {
          if (polling) return;
          polling = true;
          poll.next()
            .then((nextFrames) => {
              if (nextFrames.length) controller.enqueue(encoder.encode(nextFrames.join('')));
            })
            .catch((err) => {
              controller.enqueue(encoder.encode(sseFrame('error', { message: String(err) })));
            })
            .finally(() => { polling = false; });
        }, poll.intervalMs);
      }
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          if (keepAlive) clearInterval(keepAlive);
          if (pollInterval) clearInterval(pollInterval);
        }
      }, 15000);
    },
    cancel() {
      if (keepAlive) clearInterval(keepAlive);
      if (pollInterval) clearInterval(pollInterval);
    },
  });
  const headers = applySecurityHeaders(new Headers());
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  headers.set('cache-control', 'no-cache');
  headers.set('connection', 'keep-alive');
  return new Response(stream, { headers });
}

export function streamPollMs(env: WorkerEnv): number {
  return Math.min(Math.max(Number(env.streamPollMs) || 3000, 25), 60000);
}

export async function decompressGzipBody(request: Request): Promise<string> {
  const encoding = request.headers.get('content-encoding')?.toLowerCase();
  if (encoding !== 'gzip') {
    return request.text();
  }
  const raw = await request.arrayBuffer();
  if (typeof DecompressionStream === 'undefined') {
    // Fallback: try to parse as plain text (Cloudflare Workers auto-decompress in some cases)
    return new TextDecoder().decode(raw);
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(raw));
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(result);
}
