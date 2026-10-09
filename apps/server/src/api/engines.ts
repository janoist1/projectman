import type { FastifyInstance } from 'fastify';
import { CreateEngineRequest, routes } from '@projectman/shared';
import type { ApiServices } from './index';
import { forbidden } from '../domain';
import { currentUser, requireOwnLogin } from './context';
import { parseBody } from './validation';

export function registerEngineRoutes(app: FastifyInstance, services: ApiServices): void {
  const { domain, auth, engineRegistry } = services;
  app.get(routes.engineStatus(), async (request) => {
    const user = currentUser(request);
    const memberships = await domain.projectsFor(user.email);
    if (!auth.isHostOwner(user.id) && !memberships.some((project) => project.access !== 'client'))
      throw forbidden('insufficient_access', 'Engine status requires internal membership');
    return { mode: engineRegistry ? 'cloud' : 'single', engines: engineRegistry?.status() ?? [] };
  });
  if (!engineRegistry) return;
  const owner = (request: Parameters<typeof currentUser>[0], ownLogin: boolean) => {
    const user = currentUser(request);
    if (!auth.isHostOwner(user.id)) throw forbidden('owner_only', 'Only the host owner may manage engines');
    if (ownLogin) requireOwnLogin(request, 'engines');
    return user.id;
  };
  app.get(routes.engines(), async (request) => {
    owner(request, false);
    return engineRegistry.list();
  });
  app.post(routes.engines(), async (request, reply) => {
    const userId = owner(request, true);
    const body = parseBody(CreateEngineRequest, request.body);
    return reply.code(201).send(engineRegistry.create(body.name, userId));
  });
  app.post<{ Params: { id: string } }>(routes.revokeEngine(':id'), async (request) =>
    engineRegistry.revoke(request.params.id, owner(request, true)),
  );
  app.post<{ Params: { id: string } }>(routes.defaultEngine(':id'), async (request) => {
    owner(request, true);
    return engineRegistry.setDefault(request.params.id);
  });
}
