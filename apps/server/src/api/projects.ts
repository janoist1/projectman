import { resolvedStages } from '@projectman/shared';
import type { FastifyInstance } from 'fastify';
import { CreateProjectRequest, DEFAULT_AGENT_PROVIDER, routes } from '@projectman/shared';
import type { BoardView, ProjectSummary, TemplateSummary } from '@projectman/shared';
import { summarizeTemplate } from '@projectman/templates';
import type { Domain } from '../domain';
import { forbidden } from '../domain/errors';
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
    // Selecting host filesystem workspaces is a host-owner operation.
    if (domain.ctx.repos.users.list()[0]?.id !== currentUser(request).id)
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
    const key = request.params.key;
    const access = await requireAccess(domain, request, key);
    const { config } = await domain.projects.load(key);
    const internal = access.access !== 'client';
    const providers = [
      ...new Set(
        config.team.members.flatMap((m) => (m.kind === 'ai' ? [m.provider ?? DEFAULT_AGENT_PROVIDER] : [])),
      ),
    ];
    const planUsageByProvider = Object.fromEntries(
      await Promise.all(
        providers.map(async (provider) => [provider, internal ? await domain.planUsage.get(provider) : null]),
      ),
    );
    return {
      project: domain.projects.summary(key),
      columns: config.pipeline.columns.map((column) => ({
        ...column,
        stageIds: config.pipeline.stages.filter((s) => s.columnId === column.id).map((s) => s.id),
      })),
      stages: resolvedStages(config),
      tasks: domain.tasks.list(key).filter((t) => canSeeTask(access, t)),
      members: domain.members.rosterFor(config),
      openInboxCount: domain.inbox.countOpenFor(key, access.handle),
      planUsage: planUsageByProvider.claude ?? null,
      planUsageByProvider,
    };
  });
}
