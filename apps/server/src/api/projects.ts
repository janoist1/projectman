import type { FastifyInstance } from 'fastify';
import { CreateProjectRequest, SetChecklistItemStateRequest, routes } from '@projectman/shared';
import type { BoardView, ProjectSummary } from '@projectman/shared';
import type { AuthService } from '../auth';
import type { ApiDomain } from './ports';
import { authenticatedUser, authorOf, currentUser, requireAccess } from './context';
import { parseBody } from '../http';

type ProjectParams = { Params: { key: string } };

export function registerProjectRoutes(
  app: FastifyInstance,
  deps: { domain: ApiDomain; auth: AuthService },
): void {
  const { domain, auth } = deps;
  app.get<ProjectParams>(routes.projectChecklist(':key'), async (request) => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key, { minimum: 'admin' });
    return { checklist: await domain.checklist.get(key), canEdit: access.access === 'owner' };
  });
  app.post<{ Params: { key: string; itemId: string } }>(
    routes.projectChecklistItemState(':key', ':itemId'),
    async (request) => {
      const { key, itemId } = request.params;
      const access = await requireAccess(domain, request, key, { minimum: 'owner' });
      const body = parseBody(SetChecklistItemStateRequest, request.body);
      return { checklist: await domain.checklist.setState(key, itemId, body, access.handle), canEdit: true };
    },
  );

  /** Projects the user is a member of. */
  app.get(routes.projects(), async (request): Promise<ProjectSummary[]> => {
    const handles = await domain.handlesFor(authenticatedUser(request).email);
    const projects = domain.projects.summaries().filter((p) => handles[p.key] !== undefined);
    if (request.principal) for (const project of projects) await requireAccess(domain, request, project.key);
    return projects;
  });

  app.post(routes.projects(), async (request, reply) => {
    // The host owner and an owner account create projects (PM-1062); the service refuses everyone else and
    // checks that the folder is on an engine of the creator's.
    const user = currentUser(request);
    const body = parseBody(CreateProjectRequest, request.body);
    const summary = await domain.projects.create(body, authorOf(request), {
      userId: user.id,
      isHostOwner: auth.isHostOwner(user.id),
      isOwnerAccount: auth.isOwnerAccount(user.id),
    });
    return reply.code(201).send(summary);
  });

  app.get<ProjectParams>(routes.board(':key'), async (request): Promise<BoardView> => {
    const access = await requireAccess(domain, request, request.params.key);
    return domain.board.view(request.params.key, access);
  });
}
