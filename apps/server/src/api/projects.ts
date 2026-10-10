import type { FastifyInstance } from 'fastify';
import { CreateProjectRequest, routes, TASK_CREATE_MIN_ACCESS } from '@projectman/shared';
import type { BoardView, ProjectSummary, TemplateSummary } from '@projectman/shared';
import { summarizeTemplate } from '@projectman/templates';
import type { AuthService } from '../auth';
import type { Domain } from '../domain';
import { forbidden } from '../domain/errors';
import { authorOf, currentUser, requireAccess } from './context';
import { parseBody } from './validation';

type ProjectParams = { Params: { key: string } };

export function registerProjectRoutes(
  app: FastifyInstance,
  deps: { domain: Domain; auth: AuthService },
): void {
  const { domain, auth } = deps;

  app.get<ProjectParams>(routes.projectManager(':key'), async (request) => {
    await requireAccess(domain, request, request.params.key, { minimum: TASK_CREATE_MIN_ACCESS });
    return domain.projectManagerChannels.view(request.params.key);
  });

  /** The Operator's conversation and the log of its steps: the owner's own login only (PM-463). */
  app.get<ProjectParams>(routes.operator(':key'), async (request) => {
    const access = await requireAccess(domain, request, request.params.key, { internal: true });
    if (access.access !== 'owner' || access.via)
      throw forbidden('operator_owner_only', "only the owner's own login may see the Operator's conversation");
    return domain.projectManagerChannels.operatorView(request.params.key);
  });

  app.get(routes.templates(), async (): Promise<TemplateSummary[]> =>
    domain.templates.list().map(summarizeTemplate),
  );

  /** Projects the user is a member of. */
  app.get(routes.projects(), async (request): Promise<ProjectSummary[]> => {
    const handles = await domain.handlesFor(currentUser(request).email);
    return domain.projects.summaries().filter((p) => handles[p.key] !== undefined);
  });

  app.post(routes.projects(), async (request, reply) => {
    // Selecting host filesystem workspaces is a host-owner operation.
    if (!auth.isHostOwner(currentUser(request).id))
      throw forbidden('owner_only', 'only the initial host owner may create projects');
    const body = parseBody(CreateProjectRequest, request.body);
    const summary = await domain.projects.create(body, authorOf(request));
    return reply.code(201).send(summary);
  });

  app.get<ProjectParams>(routes.project(':key'), async (request): Promise<ProjectSummary> => {
    await requireAccess(domain, request, request.params.key);
    return domain.projects.summary(request.params.key);
  });

  app.get<ProjectParams>(routes.board(':key'), async (request): Promise<BoardView> => {
    const access = await requireAccess(domain, request, request.params.key);
    return domain.board.view(request.params.key, access);
  });
}
