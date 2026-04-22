import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  AdminAuthPrincipal,
  authenticateAdminApiToken,
  parseCookies,
} from '../admin/admin-auth';
import { AdminApiTokenService } from '../admin/admin-api-token.service';
import { AdminSessionService } from '../admin/admin-session.service';

export function authenticatePtyPrincipal(
  authHeader: string | undefined,
  cookieHeader: string | undefined,
  sessions: AdminSessionService,
  apiTokens: AdminApiTokenService,
): AdminAuthPrincipal {
  const tokenPrincipal = authenticateAdminApiToken(authHeader, apiTokens);
  if (tokenPrincipal) {
    if (tokenPrincipal.kind === 'db-token' && !tokenPrincipal.scopes.includes('device:control')) {
      throw new ForbiddenException('Missing device:control scope');
    }
    return tokenPrincipal;
  }

  const cookies = parseCookies(cookieHeader);
  if (!sessions.isValid(cookies.cc_admin_session)) {
    throw new UnauthorizedException('Browser admin session required');
  }
  return { kind: 'session', scopes: null };
}

export function mapPrincipalToPtyActor(principal: AdminAuthPrincipal): { actorType: string; actorId: string | null } {
  switch (principal.kind) {
    case 'db-token':
      return { actorType: 'admin_api_token', actorId: principal.tokenId };
    case 'env-token':
      return { actorType: 'admin_env_token', actorId: 'CC_ADMIN_API_TOKEN' };
    case 'session':
    default:
      return { actorType: 'admin_session', actorId: null };
  }
}
