import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MemberQueueQuery, projectManagerOf, routes } from '@projectman/shared';
import type { MemberQueueView, WorkQueueDetail, WorkQueueRef, WorkQueuesView } from '@projectman/shared';
import type { ApiDomain } from './ports';
import { DomainError, forbidden } from '../kernel';
import { requireAccess } from './context';
import { parseBody } from '../http';

/**
 * The work queues (PM-1294) and the project manager's queue (PM-894, PM-1042): the people of the team read them
 * with their own login, the integrator's read and super keys read too. What a person sees of a queue the
 * work queues' rules decide, item by item (`packages/shared`, `domain/work-queues.ts`).
 */
export function registerMemberQueueRoutes(app: FastifyInstance, deps: { domain: ApiDomain }): void {
  const { domain } = deps;

  /** The project's access of the request; an integrator key reads only through the owner's own principal. */
  const accessOf = async (request: FastifyRequest, key: string, minimum?: 'developer') => {
    const access = await requireAccess(domain, request, key, minimum ? { minimum } : undefined);
    if (access.via && !request.principal)
      throw forbidden('operator_owner_only', 'the queues are for a person’s own login');
    return access;
  };

  app.get<{ Params: { key: string } }>(routes.workQueues(':key'), async (request): Promise<WorkQueuesView> =>
    domain.workQueues.view(request.params.key, await accessOf(request, request.params.key)),
  );

  const registerDetail = (path: string, queueOf: (params: { handle?: string }) => WorkQueueRef) =>
    app.get<{ Params: { key: string; handle?: string } }>(path, async (request): Promise<WorkQueueDetail> => {
      const { key } = request.params;
      const access = await accessOf(request, key);
      const { closedSince } = parseBody(MemberQueueQuery, request.query);
      return domain.workQueues.detail(
        key,
        access,
        queueOf(request.params),
        closedSince ? new Date(closedSince) : undefined,
      );
    });

  registerDetail(routes.workQueueMember(':key', ':handle'), ({ handle }) => ({
    type: 'member',
    member: handle ?? '',
  }));
  registerDetail(routes.workQueueIntegrator(':key'), () => ({ type: 'integrator' }));

  const registerQueue = (
    path: string,
    memberOf: (config: Parameters<typeof projectManagerOf>[0]) => { handle: string } | null,
    absent: string,
  ) =>
    app.get<{ Params: { key: string } }>(path, async (request): Promise<MemberQueueView> => {
      const key = request.params.key;
      const access = await accessOf(request, key, 'developer');
      const member = memberOf(await domain.projects.config(key));
      if (!member) throw new DomainError('unknown_member', absent, { status: 404 });
      const { closedSince } = parseBody(MemberQueueQuery, request.query);
      const view = domain.memberQueue.view(
        key,
        member.handle,
        closedSince ? new Date(closedSince) : undefined,
      );
      // The same item filter as the work queues: a person never reads an item through this route that they could
      // not read there, and a hidden item leaves no trace in `everQueued` either.
      const items = domain.workQueues.visibleToViewer(key, access, view.items);
      const closed = domain.workQueues.visibleToViewer(key, access, view.closed);
      return {
        ...view,
        items,
        closed,
        everQueued:
          items.length > 0 ||
          closed.length > 0 ||
          domain.workQueues.everQueuedFor(key, access, member.handle),
      };
    });

  registerQueue(
    routes.projectManagerQueue(':key'),
    projectManagerOf,
    'no AI member project manager in this project',
  );
}
