import type { FastifyInstance } from 'fastify';
import type { Domain } from '../domain';
import { registerConfigRoutes } from './config';
import { registerInboxRoutes } from './inbox';
import { registerMemberRoutes } from './members';
import { registerProjectRoutes } from './projects';
import { registerSessionRoutes } from './sessions';
import { registerTaskRoutes } from './tasks';

export { apiError, registerErrorHandling, toApiError } from './errors';
export { parseBody } from './validation';

/** Every route of the shared route table except auth (src/auth) and the websocket (src/ws). */
export function registerApiRoutes(app: FastifyInstance, domain: Domain): void {
  registerProjectRoutes(app, domain);
  registerTaskRoutes(app, domain);
  registerMemberRoutes(app, domain);
  registerSessionRoutes(app, domain);
  registerInboxRoutes(app, domain);
  registerConfigRoutes(app, domain);
}
