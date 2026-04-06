import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { validateAuthConfig } from './config/auth';

async function bootstrap() {
  validateAuthConfig();
  const port = Number(process.env.PORT) || 3000;
  const app = await NestFactory.create(AppModule);

  app.use((req: any, res: any, next: () => void) => {
    const startedAt = Date.now();

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      console.log(
        `[HTTP] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode} ${durationMs}ms`,
      );
    });

    next();
  });

  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors();
  await app.listen(port);
  console.log(`CC Server listening on http://localhost:${port}`);
}
bootstrap();
