import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth';
import type { Domain } from '../domain';
import { registerAttachmentRoutes } from './attachments';
import { registerProviderRoutes } from './providers';
import { registerConfigRoutes } from './config';
import { registerInboxRoutes } from './inbox';
import { registerBoundaryRoutes } from './boundary';
import { registerRuntimeBoundaryRoutes } from './runtime-boundary';
import { registerInvitationRoutes } from './invitations';
import { registerMemberRoutes } from './members';
import { registerProjectRoutes } from './projects';
import { registerRoleRoutes } from './roles';
import { registerScheduleRoutes } from './schedules';
import { registerSessionRoutes } from './sessions';
import { registerTaskRoutes } from './tasks';

export { apiError, registerErrorHandling, toApiError } from './errors';
export { parseBody } from './validation';

/** What the routes call: the domain services and the accounts. */
export interface ApiServices {
  domain: Domain;
  auth: AuthService;
}

/** Every route of the shared route table except auth (src/auth) and the websocket (src/ws). */
export function registerApiRoutes(app: FastifyInstance, services: ApiServices): void {
  const { domain } = services;
  registerProviderRoutes(app, domain);
  registerProjectRoutes(app, services);
  registerTaskRoutes(app, domain);
  registerAttachmentRoutes(app, services);
  registerMemberRoutes(app, domain);
  registerRoleRoutes(app, domain);
  registerSessionRoutes(app, domain);
  registerScheduleRoutes(app, domain);
  registerInboxRoutes(app, domain);
  registerBoundaryRoutes(app, domain);
  registerRuntimeBoundaryRoutes(app, domain);
  registerConfigRoutes(app, domain);
  registerInvitationRoutes(app, services);
}
