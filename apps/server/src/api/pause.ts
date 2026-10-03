import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canManageInstancePause, PauseRequest, routes } from '@projectman/shared';
import type { InstancePauseView, ProjectPauseView } from '@projectman/shared';
import type { Domain, PauseRequester } from '../domain';
import { forbidden } from '../domain';
import { currentUser, requireAccess } from './context';
import { parseBody } from './validation';

/**
 * The team's pause (PM-219). A project's pause is for its admins and owners, whom every internal member
 * may look at; the instance's is for a person who is an owner in every project, whom any internal
 * member of some project may look at (`canManageInstancePause`).
 */
export function registerPauseRoutes(app: FastifyInstance, domain: Domain): void {
  type ProjectParams = { Params: { key: string } };
  const requester = (request: FastifyRequest): PauseRequester => ({
    userId: currentUser(request).id,
    source: 'app',
  });

  app.get<ProjectParams>(routes.projectPause(':key'), async (request): Promise<ProjectPauseView> => {
    await requireAccess(domain, request, request.params.key, { internal: true });
    return domain.pauses.projectView(request.params.key);
  });

  app.post<ProjectParams>(routes.projectPause(':key'), async (request): Promise<ProjectPauseView> => {
    const { key } = request.params;
    await requireAccess(domain, request, key, { minimum: 'admin', internal: true });
    const body = parseBody(PauseRequest, request.body);
    await domain.pauses.pause({ scope: 'project', projectKey: key }, requester(request), body);
    return domain.pauses.projectView(key);
  });

  app.post<ProjectParams>(routes.projectPauseResume(':key'), async (request): Promise<ProjectPauseView> => {
    const { key } = request.params;
    await requireAccess(domain, request, key, { minimum: 'admin', internal: true });
    await domain.pauses.resume({ scope: 'project', projectKey: key }, requester(request));
    return domain.pauses.projectView(key);
  });

  app.post<ProjectParams>(routes.projectPauseForce(':key'), async (request): Promise<ProjectPauseView> => {
    const { key } = request.params;
    await requireAccess(domain, request, key, { minimum: 'admin', internal: true });
    await domain.pauses.force({ scope: 'project', projectKey: key }, requester(request));
    return domain.pauses.projectView(key);
  });

  /** The viewer's internal projects and whether they may manage the instance's pause. */
  async function instanceViewer(request: FastifyRequest) {
    const user = currentUser(request);
    const accesses = await Promise.all(
      domain.projects.summaries().map(async (project) => ({
        key: project.key,
        access: await domain.accessFor(project.key, user.email),
      })),
    );
    const internal = accesses.filter((a) => a.access && a.access.access !== 'client').map((a) => a.key);
    if (internal.length === 0)
      throw forbidden('insufficient_access', 'requires internal membership in a project');
    return {
      projectKeys: internal,
      canManage: canManageInstancePause(accesses.map((a) => a.access?.access ?? null)),
    };
  }
  const instanceView = (viewer: { projectKeys: string[]; canManage: boolean }): InstancePauseView =>
    domain.pauses.instanceView(viewer.projectKeys, viewer.canManage);
  async function manageInstance(request: FastifyRequest) {
    const viewer = await instanceViewer(request);
    if (!viewer.canManage)
      throw forbidden('insufficient_access', 'only an owner of every project may pause the instance');
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
