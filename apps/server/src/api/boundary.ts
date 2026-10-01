import type { FastifyInstance } from 'fastify';
import { BoundaryId, DecideBoundaryRequest, routes } from '@projectman/shared';
import type { Domain } from '../domain';
import { requireAccess } from './context';
import { parseBody } from './validation';

type Params = { Params: { key: string; id: string } };
export function registerBoundaryRoutes(app: FastifyInstance, domain: Domain): void {
  app.get<Params>(routes.boundaryRequest(':key', ':id'), async (request) => {
    const { key, id } = request.params;
    const access = await requireAccess(domain, request, key, { internal: true });
    return domain.boundary.read(key, parseBody(BoundaryId, id), access.handle);
  });
  app.post<Params>(routes.decideBoundary(':key', ':id'), async (request) => {
    const { key, id } = request.params;
    const access = await requireAccess(domain, request, key, { internal: true });
    return domain.boundary.decide(
      key,
      parseBody(BoundaryId, id),
      access.handle,
      parseBody(DecideBoundaryRequest, request.body),
    );
  });
  app.post<Params>(routes.revokeBoundary(':key', ':id'), async (request) => {
    const { key, id } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'owner' });
    return domain.boundary.revoke(key, parseBody(BoundaryId, id), access.handle);
  });
}
