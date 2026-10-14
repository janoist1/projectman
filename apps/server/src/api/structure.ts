import type { FastifyInstance } from 'fastify';
import { routes } from '@projectman/shared';
import type { ApiDomain } from './ports';
import { requireAccess } from './context';

export function registerStructureRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.get<{ Params: { key: string } }>(routes.projectStructure(':key'), async (request) => {
    const key = request.params.key;
    await requireAccess(domain, request, key, { internal: true });
    return domain.structure.view(key);
  });
}
