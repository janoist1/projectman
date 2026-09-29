import type { FastifyInstance } from 'fastify';
import { CustomRoleRequest, routes } from '@projectman/shared';
import type { RolesView, RoleView } from '@projectman/shared';
import type { Domain } from '../domain';
import { actorOf, authorOf, requireAccess } from './context';
import { parseBody } from './validation';

type ProjectParams = { Params: { key: string } };
type RoleParams = { Params: { key: string; roleId: string } };

export function registerRoleRoutes(app: FastifyInstance, domain: Domain): void {
  /** The role catalogue: built-in roles in the project's language, then the team's custom roles. */
  app.get<ProjectParams>(routes.roles(':key'), async (request): Promise<RolesView> => {
    await requireAccess(domain, request, request.params.key);
    return domain.roles.list(request.params.key);
  });

  /** Adds a custom role (a configuration commit; owners and admins). */
  app.post<ProjectParams>(routes.roles(':key'), async (request, reply) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(CustomRoleRequest, request.body);
    const role = await domain.roles.create(key, body, { actor: actorOf(access), author: authorOf(request) });
    return reply.code(201).send(role);
  });

  /** Replaces a custom role; built-in roles cannot be changed. */
  app.put<RoleParams>(routes.role(':key', ':roleId'), async (request): Promise<RoleView> => {
    const { key, roleId } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(CustomRoleRequest, request.body);
    return domain.roles.update(key, roleId, body, { actor: actorOf(access), author: authorOf(request) });
  });

  /** Removes a custom role; refused (409 role_in_use) while anyone holds it. */
  app.delete<RoleParams>(routes.role(':key', ':roleId'), async (request, reply) => {
    const { key, roleId } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    await domain.roles.remove(key, roleId, { actor: actorOf(access), author: authorOf(request) });
    return reply.code(204).send();
  });
}
