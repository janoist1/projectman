import type { FastifyInstance } from 'fastify';
import { CreateProjectRequest, routes } from '@projectman/shared';
import type { BoardView, ProjectSummary, TemplateSummary } from '@projectman/shared';
import { summarizeTemplate } from '@projectman/templates';
import type { Domain } from '../domain';
import { authorOf, canSeeTask, currentUser, requireAccess } from './context';
import { parseBody } from './validation';

type ProjectParams = { Params: { key: string } };

export function registerProjectRoutes(app: FastifyInstance, domain: Domain): void {
  app.get(routes.templates(), async (): Promise<TemplateSummary[]> =>
    domain.templates.list().map(summarizeTemplate),
  );

  /** Projects the user is a member of. */
  app.get(routes.projects(), async (request): Promise<ProjectSummary[]> => {
    const handles = await domain.handlesFor(currentUser(request).email);
    return domain.projects.summaries().filter((p) => handles[p.key] !== undefined);
  });

  app.post(routes.projects(), async (request, reply) => {
    const body = parseBody(CreateProjectRequest, request.body);
    const summary = await domain.projects.create(body, authorOf(request));
    return reply.code(201).send(summary);
  });

  app.get<ProjectParams>(routes.project(':key'), async (request): Promise<ProjectSummary> => {
    await requireAccess(domain, request, request.params.key);
    return domain.projects.summary(request.params.key);
  });

  app.get<ProjectParams>(routes.board(':key'), async (request): Promise<BoardView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key);
    const { config } = await domain.projects.load(key);
    const internal = access.access !== 'client';
    return {
      project: domain.projects.summary(key),
      columns: config.pipeline.columns.map((column) => ({
        ...column,
        stageIds: config.pipeline.stages.filter((s) => s.columnId === column.id).map((s) => s.id),
      })),
      stages: config.pipeline.stages,
      tasks: domain.tasks.list(key).filter((t) => canSeeTask(access, t)),
      members: domain.members.rosterFor(config),
      openInboxCount: domain.inbox.countOpenFor(key, access.handle),
      planUsage: internal ? await domain.planUsage.get() : null,
    };
  });
}
