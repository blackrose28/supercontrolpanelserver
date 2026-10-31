import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { randomUUID, randomInt } from 'node:crypto';
import { getAdminApiToken } from '../config/auth';
import { AdminSessionService } from './admin-session.service';
import { Response } from 'express';
import { AdminApiTokenScope, AdminApiTokenService } from './admin-api-token.service';

export function authFailureDelay(): Promise<void> {
  const ms = randomInt(50, 201);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const ADMIN_SESSION_COOKIE = 'cc_admin_session';
export const ADMIN_CSRF_COOKIE = 'cc_admin_csrf';

export function parseCookies(cookieHeader?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) {
    return result;
  }

  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) {
      continue;
    }
    result[rawKey] = decodeURIComponent(rest.join('=') || '');
  }
  return result;
}

function parseBearerToken(authHeader?: string): string | undefined {
  if (!authHeader?.startsWith('Bearer ')) {
    return undefined;
  }
  const token = authHeader.slice(7).trim();
  return token || undefined;
}

export type AdminAuthPrincipal =
  | {
      kind: 'session';
      scopes: null;
    }
  | {
      kind: 'env-token';
      scopes: null;
    }
  | {
      kind: 'db-token';
      tokenId: string;
      label: string;
      scopes: AdminApiTokenScope[];
    };

export function authenticateAdminApiToken(
  authHeader: string | undefined,
  apiTokens: AdminApiTokenService,
): AdminAuthPrincipal | null {
  const providedToken = parseBearerToken(authHeader);
  if (!providedToken) {
    return null;
  }

  const configuredToken = getAdminApiToken();
  if (configuredToken && providedToken === configuredToken) {
    return {
      kind: 'env-token',
      scopes: null,
    };
  }

  const tokenRecord = apiTokens.authenticateToken(providedToken);
  if (!tokenRecord) {
    return null;
  }

  return {
    kind: 'db-token',
    tokenId: tokenRecord.tokenId,
    label: tokenRecord.label,
    scopes: tokenRecord.scopes,
  };
}

export function hasValidAdminApiToken(
  authHeader: string | undefined,
  apiTokens: AdminApiTokenService,
): boolean {
  return authenticateAdminApiToken(authHeader, apiTokens) !== null;
}

export function hasValidAdminSession(
  cookieHeader: string | undefined,
  sessions: AdminSessionService,
): boolean {
  const cookies = parseCookies(cookieHeader);
  return sessions.isValid(cookies[ADMIN_SESSION_COOKIE]);
}

export function isAdminAuthorized(
  authHeader: string | undefined,
  cookieHeader: string | undefined,
  sessions: AdminSessionService,
  apiTokens: AdminApiTokenService,
): boolean {
  return hasValidAdminApiToken(authHeader, apiTokens) || hasValidAdminSession(cookieHeader, sessions);
}

export function requireAdminAuthorized(
  authHeader: string | undefined,
  cookieHeader: string | undefined,
  sessions: AdminSessionService,
  apiTokens: AdminApiTokenService,
  requiredScopes: AdminApiTokenScope[] = [],
) {
  const tokenPrincipal = authenticateAdminApiToken(authHeader, apiTokens);
  if (tokenPrincipal) {
    requireAdminScopes(tokenPrincipal, requiredScopes);
    return tokenPrincipal;
  }

  if (!hasValidAdminSession(cookieHeader, sessions)) {
    throw new UnauthorizedException({
      code: 'ADMIN_API_AUTH_FAILED',
      message: 'Admin access denied',
    });
  }

  return {
    kind: 'session',
    scopes: null,
  } satisfies AdminAuthPrincipal;
}

export function requireAdminMutationAuthorized(
  authHeader: string | undefined,
  cookieHeader: string | undefined,
  submittedToken: string | undefined,
  sessions: AdminSessionService,
  apiTokens: AdminApiTokenService,
  requiredScopes: AdminApiTokenScope[] = [],
) {
  const tokenPrincipal = authenticateAdminApiToken(authHeader, apiTokens);
  if (tokenPrincipal) {
    requireAdminScopes(tokenPrincipal, requiredScopes);
    return tokenPrincipal;
  }
  const principal = requireAdminAuthorized(authHeader, cookieHeader, sessions, apiTokens);
  requireCsrf(cookieHeader, submittedToken);
  return principal;
}

export function requireAdminSessionAuthorized(
  cookieHeader: string | undefined,
  sessions: AdminSessionService,
) {
  if (!hasValidAdminSession(cookieHeader, sessions)) {
    throw new UnauthorizedException({
      code: 'ADMIN_API_AUTH_FAILED',
      message: 'Browser admin session required',
    });
  }
}

export function ensureCsrfToken(
  res: Response,
  cookieHeader?: string,
): string {
  const cookies = parseCookies(cookieHeader);
  const existing = cookies[ADMIN_CSRF_COOKIE];
  if (existing) {
    return existing;
  }

  const token = randomUUID();
  const secure = process.env.NODE_ENV === 'production';
  res.cookie(ADMIN_CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: 'strict',
    secure,
    path: '/',
  });
  return token;
}

export function requireCsrf(
  cookieHeader: string | undefined,
  submittedToken: string | undefined,
) {
  const cookies = parseCookies(cookieHeader);
  const cookieToken = cookies[ADMIN_CSRF_COOKIE];
  if (!cookieToken || !submittedToken || cookieToken !== submittedToken) {
    throw new UnauthorizedException('CSRF validation failed');
  }
}

function requireAdminScopes(
  principal: AdminAuthPrincipal,
  requiredScopes: AdminApiTokenScope[],
) {
  if (!requiredScopes.length || principal.kind === 'session' || principal.kind === 'env-token') {
    return;
  }

  const missingScopes = requiredScopes.filter((scope) => !principal.scopes.includes(scope));
  if (!missingScopes.length) {
    return;
  }

  throw new ForbiddenException({
    code: 'ADMIN_API_FORBIDDEN',
    message: 'Admin API token is missing required scopes',
    details: {
      requiredScopes,
      missingScopes,
      tokenId: principal.tokenId,
      label: principal.label,
    },
  });
}
