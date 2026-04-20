import { Controller, Get, Headers, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdminSessionService } from './admin-session.service';
import { ensureCsrfToken, hasValidAdminSession } from './admin-auth';

type AdminNextAssets = {
  scriptSrc: string;
  stylesheets: string[];
};

const DEFAULT_ASSETS: AdminNextAssets = {
  scriptSrc: '/admin-next/index.js',
  stylesheets: [],
};

function resolveAssetsFromManifest(): AdminNextAssets {
  const manifestPath = join(__dirname, '..', '..', 'public', 'admin-next', '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) {
    return DEFAULT_ASSETS;
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    const entry = manifest['index.html'] || Object.values(manifest).find((item: any) => item?.isEntry);
    if (!entry?.file) {
      return DEFAULT_ASSETS;
    }

    const css = Array.isArray(entry.css)
      ? entry.css.filter((value: unknown): value is string => typeof value === 'string')
      : [];

    return {
      scriptSrc: `/admin-next/${entry.file}`,
      stylesheets: css.map((file) => `/admin-next/${file}`),
    };
  } catch {
    return DEFAULT_ASSETS;
  }
}

export { resolveAssetsFromManifest };

@Controller('admin-next')
export class AdminNextController {
  private readonly assets: AdminNextAssets;

  constructor(
    private readonly adminSessions: AdminSessionService,
    private readonly resolveAssets: () => AdminNextAssets = resolveAssetsFromManifest,
  ) {
    this.assets = this.resolveAssets();
  }

  @Get()
  index(
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Res() res?: Response,
  ) {
    this.renderShell(cookie, res);
  }

  @Get('*path')
  fallback(
    @Param('path') path: string,
    @Headers('authorization') auth?: string,
    @Headers('cookie') cookie?: string,
    @Res() res?: Response,
  ) {
    void path;
    this.renderShell(cookie, res);
  }

  private renderShell(cookie: string | undefined, res?: Response) {
    if (!hasValidAdminSession(cookie, this.adminSessions)) {
      ensureCsrfToken(res!, cookie);
      res!.redirect('/admin/login');
      return;
    }

    const csrfToken = ensureCsrfToken(res!, cookie);
    res!.setHeader('Cache-Control', 'no-store');
    res!.render('admin-next', {
      csrfToken,
      scriptSrc: this.assets.scriptSrc,
      stylesheets: this.assets.stylesheets,
    });
  }
}
