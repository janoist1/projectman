import type { FastifyInstance } from 'fastify';
import { CreateEngineRequest, routes } from '@projectman/shared';
import type { ApiServices } from './index';
import { forbidden } from '../kernel';
import { currentUser, instanceUser, requireOwnLogin } from './context';
import { parseBody } from '../http';

export function registerEngineRoutes(app: FastifyInstance, services: ApiServices): void {
  const { domain, auth, engineRegistry } = services;
  app.get(routes.engineStatus(), async (request) => {
    const user = await instanceUser(domain, request, 'read');
    const memberships = await domain.projectsFor(user.email);
    if (!auth.isHostOwner(user.id) && memberships.length === 0)
      throw forbidden('insufficient_access', 'Engine status requires project membership');
    return { mode: engineRegistry ? 'cloud' : 'single', engines: engineRegistry?.status() ?? [] };
  });
  if (!engineRegistry) return;
  const owner = async (request: Parameters<typeof currentUser>[0], ownLogin: boolean) => {
    const user = await instanceUser(domain, request, ownLogin ? 'write' : 'read');
    if (!auth.isHostOwner(user.id)) throw forbidden('owner_only', 'Only the host owner may manage engines');
    if (ownLogin && request.principal?.mode !== 'super') requireOwnLogin(request, 'engines');
    return user.id;
  };
  app.get(routes.engines(), async (request) => {
    await owner(request, false);
    return engineRegistry.list();
  });
  app.post(routes.engines(), async (request, reply) => {
    const userId = await owner(request, true);
    const body = parseBody(CreateEngineRequest, request.body);
    return reply.code(201).send(engineRegistry.create(body.name, userId));
  });
  app.post<{ Params: { id: string } }>(routes.revokeEngine(':id'), async (request) =>
    engineRegistry.revoke(request.params.id, await owner(request, true)),
  );
  app.post<{ Params: { id: string } }>(routes.defaultEngine(':id'), async (request) => {
    await owner(request, true);
    return engineRegistry.setDefault(request.params.id);
  });
}
