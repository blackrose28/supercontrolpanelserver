import { AdminAuthPrincipal } from '../admin/admin-auth';
import { CommandActorType } from './command.store';

export function mapPrincipalToActor(principal: AdminAuthPrincipal): {
  actorType: CommandActorType;
  actorId: string | null;
  source: string;
} {
  switch (principal.kind) {
    case 'db-token':
      return {
        actorType: 'admin_api_token',
        actorId: principal.tokenId,
        source: 'api',
      };
    case 'env-token':
      return {
        actorType: 'admin_env_token',
        actorId: 'CC_ADMIN_API_TOKEN',
        source: 'api',
      };
    case 'session':
    default:
      return {
        actorType: 'admin_session',
        actorId: null,
        source: 'admin_ui',
      };
  }
}
