import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PauseRequest, routes } from '@projectman/shared';
import type { InstancePauseView, ProjectPauseView } from '@projectman/shared';
import type { ApiDomain } from './ports';
import type { PauseRequester } from '../runtime/sessions';
import { forbidden } from '../kernel';
import type { ProjectAccess } from '../core/members';
import { authenticatedUser, instanceUser, requireAccess } from './context';
import { parseBody } from '../http';

/**
 * The team's pause (PM-219). A project's pause is for its admins and owners, whom every member
 * may look at; the instance's is for the host owner (`domain.instanceOwner`), whom any member of
 * some project may look at. The pause acts on the whole instance; only the listing is filtered by membership.
 */
export function registerPauseRoutes(app: FastifyInstance, domain: ApiDomain): void {
  type ProjectParams = { Params: { key: string } };
  const requester = (request: FastifyRequest, access?: ProjectAccess): PauseRequester => ({
    userId: authenticatedUser(request).id,
    source: 'app',
    ...(request.via ? { via: request.via } : {}),
    ...(request.principal?.mode === 'super'
      ? { credential: { id: request.principal.keyId, prefix: request.principal.prefix } }
      : {}),
  });

  app.get<ProjectParams>(routes.projectPause(':key'), async (request): Promise<ProjectPauseView> => {
    await requireAccess(domain, request, request.params.key);
    return domain.pauses.projectView(request.params.key);
  });

  app.post<ProjectParams>(routes.projectPause(':key'), async (request): Promise<ProjectPauseView> => {
    const { key } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    const body = parseBody(PauseRequest, request.body);
    await domain.pauses.pause({ scope: 'project', projectKey: key }, requester(request, access), body);
    return domain.pauses.projectView(key);
  });

  app.post<ProjectParams>(routes.projectPauseResume(':key'), async (request): Promise<ProjectPauseView> => {
    const { key } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    await domain.pauses.resume({ scope: 'project', projectKey: key }, requester(request, access));
    return domain.pauses.projectView(key);
  });

  app.post<ProjectParams>(routes.projectPauseForce(':key'), async (request): Promise<ProjectPauseView> => {
    const { key } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    await domain.pauses.force({ scope: 'project', projectKey: key }, requester(request, access));
    return domain.pauses.projectView(key);
  });

  /** The viewer's projects and whether they may manage the instance's pause. */
  async function instanceViewer(request: FastifyRequest) {
    const user = await instanceUser(domain, request, request.method === 'GET' ? 'read' : 'write');
    const accesses = await Promise.all(
      domain.projects.summaries().map(async (project) => ({
        key: project.key,
        access: await domain.accessFor(project.key, user.email),
      })),
    );
    const member = accesses.filter((a) => a.access).map((a) => a.key);
    const canManage = await domain.instanceOwner(user.email);
    if (member.length === 0 && !canManage)
      throw forbidden('insufficient_access', 'requires membership in a project');
    return { projectKeys: member, canManage };
  }
  const instanceView = (viewer: { projectKeys: string[]; canManage: boolean }): InstancePauseView =>
    domain.pauses.instanceView(viewer.projectKeys, viewer.canManage);
  async function manageInstance(request: FastifyRequest) {
    const viewer = await instanceViewer(request);
    if (!viewer.canManage)
      throw forbidden('insufficient_access', 'only the host owner may pause the instance');
    return viewer;
  }

  app.get(routes.instancePause(), async (request): Promise<InstancePauseView> => {
    return instanceView(await instanceViewer(request));
  });

  app.post(routes.instancePause(), async (request): Promise<InstancePauseView> => {
    const viewer = await manageInstance(request);
    const body = parseBody(PauseRequest, request.body);
    await domain.pauses.pause({ scope: 'instance' }, requester(request), body);
    return instanceView(viewer);
  });

  app.post(routes.instancePauseResume(), async (request): Promise<InstancePauseView> => {
    const viewer = await manageInstance(request);
    await domain.pauses.resume({ scope: 'instance' }, requester(request));
    return instanceView(viewer);
  });

  app.post(routes.instancePauseForce(), async (request): Promise<InstancePauseView> => {
    const viewer = await manageInstance(request);
    await domain.pauses.force({ scope: 'instance' }, requester(request));
    return instanceView(viewer);
  });
}
