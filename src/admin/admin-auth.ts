import { UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getAdminPassword } from '../config/auth';
import { AdminSessionService } from './admin-session.service';
import { Response } from 'express';

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

export function isAdminAuthorized(
  authHeader: string | undefined,
  cookieHeader: string | undefined,
  sessions: AdminSessionService,
): boolean {
  const adminPassword = getAdminPassword();
  if (authHeader === `Bearer ${adminPassword}`) {
    return true;
  }

  const cookies = parseCookies(cookieHeader);
  return sessions.isValid(cookies[ADMIN_SESSION_COOKIE]);
}

export function requireAdminAuthorized(
  authHeader: string | undefined,
  cookieHeader: string | undefined,
  sessions: AdminSessionService,
) {
  if (!isAdminAuthorized(authHeader, cookieHeader, sessions)) {
    throw new UnauthorizedException('Admin access denied');
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
