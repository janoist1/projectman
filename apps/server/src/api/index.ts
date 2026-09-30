import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth';
import type { Domain } from '../domain';
import type { InvitationService } from '../domain/invitations';
import { registerProviderRoutes } from './providers';
import { registerConfigRoutes } from './config';
import { registerInboxRoutes } from './inbox';
import { registerInvitationRoutes } from './invitations';
import { registerMemberRoutes } from './members';
import { registerProjectRoutes } from './projects';
import { registerRoleRoutes } from './roles';
import { registerScheduleRoutes } from './schedules';
import { registerSessionRoutes } from './sessions';
import { registerTaskRoutes } from './tasks';

export { apiError, registerErrorHandling, toApiError } from './errors';
export { parseBody } from './validation';

/** Every route of the shared route table except auth (src/auth) and the websocket (src/ws). */
export function registerApiRoutes(
  app: FastifyInstance,
  deps: { domain: Domain; invitations: InvitationService; auth: AuthService },
): void {
  const { domain } = deps;
  registerProviderRoutes(app, domain);
  registerProjectRoutes(app, domain);
  registerTaskRoutes(app, domain);
  registerMemberRoutes(app, domain);
  registerRoleRoutes(app, domain);
  registerSessionRoutes(app, domain);
  registerScheduleRoutes(app, domain);
  registerInboxRoutes(app, domain);
  registerConfigRoutes(app, domain);
  registerInvitationRoutes(app, deps);
}
