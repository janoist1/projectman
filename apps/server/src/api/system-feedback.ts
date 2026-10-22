import type { FastifyInstance } from 'fastify';
import {
  DismissSystemFeedbackRequest,
  MarkSystemFeedbackForwardedRequest,
  PrepareSystemFeedbackRequest,
  SetSystemFeedbackForwardingRequest,
  routes,
  systemFeedbackAccess,
} from '@projectman/shared';
import type {
  SystemFeedbackForwardingView,
  SystemFeedbackItem,
  SystemFeedbackList,
  SystemFeedbackPrepared,
  SystemFeedbackPreview,
  SystemFeedbackSummary,
} from '@projectman/shared';
import { SYSTEM_ACTOR, forbidden, notFound } from '../kernel';
import { actorOf, instanceUser, requireInstanceOwner, requireOwnLogin } from './context';
import type { ApiDomain } from './ports';
import { parseBody } from '../http';

/**
 * System feedback (PM-472, PM-479): the Operator's findings about projectman itself. The instance owner manages
 * them; the owner of a project reads that project's own and nothing else. Every change needs the owner's own
 * login (not the integrator key): what leaves the installation is the owner's decision.
 */
export function registerSystemFeedbackRoutes(app: FastifyInstance, domain: ApiDomain): void {
  const { systemFeedback } = domain;
  /** The instance owner, for a change: their own login, not a key that acts for them. */
  const manage = async (request: Parameters<typeof requireInstanceOwner>[1]) => {
    const user = await requireInstanceOwner(domain, request);
    requireOwnLogin(request, 'system_feedback');
    return user;
  };

  app.get<{ Querystring: { project?: string } }>(
    routes.systemFeedback(),
    async (request): Promise<SystemFeedbackList> => {
      const user = await instanceUser(domain, request, 'read');
      const projectKey = request.query.project || undefined;
      if (projectKey !== undefined && !domain.projects.has(projectKey)) throw notFound('project', projectKey);
      const instanceOwner = await domain.instanceOwner(user.email);
      const access = systemFeedbackAccess(
        instanceOwner,
        projectKey === undefined ? null : ((await domain.accessFor(projectKey, user.email))?.access ?? null),
      );
      // A project owner reads one project's items, named; without a project there is nothing of theirs to list.
      if (!access || (access === 'read' && projectKey === undefined))
        throw forbidden('insufficient_access', 'only an owner may see system feedback');
      return systemFeedback.list({ access, ...(projectKey === undefined ? {} : { projectKey }) });
    },
  );

  app.get(routes.systemFeedbackSummary(), async (request): Promise<SystemFeedbackSummary> => {
    await requireInstanceOwner(domain, request);
    return systemFeedback.summary();
  });

  app.put(routes.systemFeedbackForwarding(), async (request): Promise<SystemFeedbackForwardingView> => {
    const user = await manage(request);
    return systemFeedback.setForwarding(parseBody(SetSystemFeedbackForwardingRequest, request.body), user);
  });

  app.post<{ Params: { id: string } }>(
    routes.systemFeedbackCard(':id'),
    async (request): Promise<SystemFeedbackItem> => {
      const user = await manage(request);
      // The owner opens the card as themselves in the project it goes to.
      const target = systemFeedback.forwardingView().projectKey;
      const access = target === null ? null : await domain.accessFor(target, user.email);
      return systemFeedback.openCard(request.params.id, access ? actorOf(access) : SYSTEM_ACTOR, user.id);
    },
  );

  app.get<{ Params: { id: string } }>(
    routes.systemFeedbackPreview(':id'),
    async (request): Promise<SystemFeedbackPreview> => {
      await requireInstanceOwner(domain, request);
      return systemFeedback.preview(request.params.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    routes.systemFeedbackPrepare(':id'),
    async (request): Promise<SystemFeedbackPrepared> => {
      await manage(request);
      return systemFeedback.prepare(request.params.id, parseBody(PrepareSystemFeedbackRequest, request.body));
    },
  );

  app.post<{ Params: { id: string } }>(
    routes.systemFeedbackForwarded(':id'),
    async (request): Promise<SystemFeedbackItem> => {
      const user = await manage(request);
      return systemFeedback.markForwarded(
        request.params.id,
        parseBody(MarkSystemFeedbackForwardedRequest, request.body ?? {}),
        user,
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    routes.systemFeedbackDismiss(':id'),
    async (request): Promise<SystemFeedbackItem> => {
      const user = await manage(request);
      return systemFeedback.dismiss(
        request.params.id,
        parseBody(DismissSystemFeedbackRequest, request.body).reason,
        user,
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    routes.systemFeedbackRestore(':id'),
    async (request): Promise<SystemFeedbackItem> => {
      await manage(request);
      return systemFeedback.restore(request.params.id);
    },
  );
}
