import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

const DEFAULT_ORIGIN = 'http://localhost:3000';

export function buildCorsOptions(): CorsOptions {
  const raw = process.env.CC_CORS_ORIGIN?.trim();
  const allowedOrigins = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : [DEFAULT_ORIGIN];

  if (allowedOrigins.length === 1 && allowedOrigins[0] === '*') {
    return {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    };
  }

  return {
    origin: (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) => {
      if (!origin || allowedOrigins.includes(origin)) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  };
}
