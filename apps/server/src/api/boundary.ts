import type { FastifyInstance } from 'fastify';
import { BoundaryId, DecideBoundaryRequest, routes } from '@projectman/shared';
import type { ApiDomain } from './ports';
import { forbidden } from '../kernel';
import { requireAccess } from './context';
import { parseBody } from '../http';

type Params = { Params: { key: string; id: string } };
export function registerBoundaryRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.get<Params>(routes.boundaryRequest(':key', ':id'), async (request) => {
    const { key, id } = request.params;
    const access = await requireAccess(domain, request, key);
    return domain.boundary.read(key, parseBody(BoundaryId, id), access.handle);
  });
  app.post<Params>(routes.decideBoundary(':key', ':id'), async (request) => {
    const { key, id } = request.params;
    const access = await requireAccess(domain, request, key);
    if (access.via)
      throw forbidden(
        'owner_approval_required',
        'Only the owner may decide a boundary request using their own login',
      );
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
