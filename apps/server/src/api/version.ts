import type { FastifyInstance } from 'fastify';
import { routes } from '@projectman/shared';
import type { ApiDomain } from './ports';
import { authenticatedUser } from './context';

export function registerVersionRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.get(routes.serverVersion(), async (request) => {
    authenticatedUser(request);
    return domain.releasePublications.runningVersion();
  });
}
