import 'dotenv/config';
import { json, urlencoded } from 'express';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { validateAuthConfig } from './config/auth';
import { CONTENT_SECURITY_POLICY } from './security-headers';
import { isAdminNextHashedAssetPath } from './admin-next-cache';
import { buildCorsOptions } from './config/cors';

async function bootstrap() {
  validateAuthConfig();
  const port = Number(process.env.PORT) || 3000;
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });

  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.setViewEngine('ejs');
  app.setBaseViewsDir(join(__dirname, '..', 'views'));
  app.useStaticAssets(join(__dirname, '..', 'public'), {
    setHeaders: (res, path) => {
      if (isAdminNextHashedAssetPath(path)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  app.use((req: any, res: any, next: () => void) => {
    const startedAt = Date.now();

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      console.log(
        `[HTTP] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode} ${durationMs}ms`,
      );
    });

    next();
  });

  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableCors(buildCorsOptions());
  await app.listen(port);
  console.log(`CC Server listening on http://localhost:${port}`);
}
bootstrap();
