import type { FastifyInstance } from 'fastify';
import {
  BindProjectEngineRequest,
  CreateEngineRequest,
  LOCAL_ENGINE_ID,
  canBindEngine,
  canCreateEngine,
  canManageEngine,
  canUnbindEngine,
  routes,
} from '@projectman/shared';
import type { ProjectEngineView } from '@projectman/shared';
import type { ApiServices } from './index';
import { DomainError, forbidden, notFound } from '../kernel';
import { currentUser, instanceUser, requireOwnLogin } from './context';
import { parseBody } from '../http';

type ProjectEngineParams = { Params: { key: string; engineId: string } };

export function registerEngineRoutes(app: FastifyInstance, services: ApiServices): void {
  const { domain, auth, engineRegistry } = services;
  registerProjectEngineRoutes(app, services);
  app.get(routes.engineStatus(), async (request) => {
    const user = await instanceUser(domain, request, 'read');
    const memberships = await domain.projectsFor(user.email);
    if (!auth.isHostOwner(user.id) && !auth.isOwnerAccount(user.id) && memberships.length === 0)
      throw forbidden('insufficient_access', 'Engine status requires project membership');
    // Only the engines of the viewer's own projects (and their own); the host owner sees every one (PM-1061).
    const engines =
      engineRegistry?.statusFor({ userId: user.id, projectKeys: memberships.map((item) => item.key) }) ?? [];
    return { mode: engineRegistry ? 'cloud' : 'single', engines };
  });
  if (!engineRegistry) return;
  const actor = async (request: Parameters<typeof currentUser>[0]) => {
    const user = await instanceUser(domain, request, 'write');
    if (request.principal?.mode !== 'super') requireOwnLogin(request, 'engines');
    return {
      userId: user.id,
      isHostOwner: auth.isHostOwner(user.id),
      isOwnerAccount: auth.isOwnerAccount(user.id),
    };
  };
  // The management list: the host owner's is every engine, any other owner's (an owner account, a project owner) their own (PM-1061, PM-1062).
  app.get(routes.engines(), async (request) => {
    const user = await instanceUser(domain, request, 'read');
    if (
      !auth.isHostOwner(user.id) &&
      !auth.isOwnerAccount(user.id) &&
      !(await domain.projectsFor(user.email)).some((p) => p.access === 'owner')
    )
      throw forbidden('owner_only', 'Only a project owner may manage engines');
    return engineRegistry.listFor({ userId: user.id });
  });
  app.post(routes.engines(), async (request, reply) => {
    const creator = await actor(request);
    if (!canCreateEngine(creator))
      throw forbidden('owner_only', 'Only the host owner or an owner account may create engines');
    const body = parseBody(CreateEngineRequest, request.body);
    return reply.code(201).send(engineRegistry.create(body.name, creator.userId));
  });
  // The host owner revokes any engine, an owner account their own.
  app.post<{ Params: { id: string } }>(routes.revokeEngine(':id'), async (request) => {
    const manager = await actor(request);
    if (!canCreateEngine(manager)) throw forbidden('owner_only', 'Only an owner may manage engines');
    const engineOwner = engineRegistry.ownerOf(request.params.id);
    if (engineOwner === null) throw new DomainError('engine_not_found', 'Engine not found', { status: 404 });
    if (
      !canManageEngine({
        isHostOwner: manager.isHostOwner,
        actorUserId: manager.userId,
        engineOwnerUserId: engineOwner,
      })
    )
      throw forbidden('engine_not_owned', 'Only the engine owner or the host owner may revoke it');
    return engineRegistry.revoke(request.params.id, manager.userId);
  });
  // The machine-wide default is the host's alone.
  app.post<{ Params: { id: string } }>(routes.defaultEngine(':id'), async (request) => {
    if (!(await actor(request)).isHostOwner)
      throw forbidden('owner_only', 'Only the host owner may choose the default engine');
    return engineRegistry.setDefault(request.params.id);
  });
}

/**
 * The project's engines (PM-1060). Own login only, like the engine management: a key of the integrator
 * is refused by `currentUser`. The rules (`canBindEngine`, `canUnbindEngine`) are the shared ones.
 */
function registerProjectEngineRoutes(app: FastifyInstance, services: ApiServices): void {
  const { domain, auth, engineRegistry } = services;
  const member = async (request: Parameters<typeof currentUser>[0], key: string) => {
    const user = currentUser(request);
    if (!domain.projects.has(key)) throw notFound('project', key);
    return { user, access: await domain.accessFor(key, user.email) };
  };
  const missingEngine = () => new DomainError('engine_not_found', 'Engine not found', { status: 404 });

  app.get<{ Params: { key: string } }>(routes.projectEngines(':key'), async (request) => {
    const { user, access } = await member(request, request.params.key);
    if (!access) throw forbidden('not_a_member', 'you are not a member of this project');
    if (!engineRegistry) {
      // Single machine: the one local engine, always the project's.
      const local: ProjectEngineView = {
        id: LOCAL_ENGINE_ID,
        name: LOCAL_ENGINE_ID,
        online: true,
        isDefault: true,
        holdsProject: true,
        ownedByMe: auth.isHostOwner(user.id),
      };
      return { engines: [local] };
    }
    return { engines: engineRegistry.projectEngineViews(request.params.key, user.id) };
  });

  app.put<ProjectEngineParams>(routes.projectEngine(':key', ':engineId'), async (request) => {
    const { key, engineId } = request.params;
    const { user, access } = await member(request, key);
    if (!access) throw forbidden('not_a_member', 'you are not a member of this project');
    if (access.access !== 'owner') throw forbidden('insufficient_access', 'requires owner access');
    const body = parseBody(BindProjectEngineRequest, request.body ?? {});
    const engineOwner = engineRegistry?.ownerOf(engineId) ?? null;
    if (!engineRegistry || engineOwner === null) throw missingEngine();
    const bound = engineRegistry.projectBindings(key).some((binding) => binding.engineId === engineId);
    // Only a new binding needs the engine owner's consent; making a bound engine the default is the project owner's call.
    if (
      !bound &&
      !canBindEngine({ actorUserId: user.id, engineOwnerUserId: engineOwner, actorIsProjectOwner: true })
    )
      throw forbidden('engine_not_owned', 'Only the engine owner may bind it to a project');
    engineRegistry.bind(key, engineId, user.id, { default: body.default });
    return engineRegistry.projectEngineViews(key, user.id).find((view) => view.id === engineId);
  });

  app.delete<ProjectEngineParams>(routes.projectEngine(':key', ':engineId'), async (request, reply) => {
    const { key, engineId } = request.params;
    const { user, access } = await member(request, key);
    const engineOwner = engineRegistry?.ownerOf(engineId) ?? null;
    if (!engineRegistry || engineOwner === null) throw missingEngine();
    if (
      !canUnbindEngine({
        actorUserId: user.id,
        engineOwnerUserId: engineOwner,
        actorIsProjectOwner: access?.access === 'owner',
      })
    )
      throw forbidden(
        access ? 'insufficient_access' : 'not_a_member',
        'Only the engine owner or the project owner may unbind it',
      );
    engineRegistry.unbind(key, engineId);
    return reply.code(204).send();
  });
}
