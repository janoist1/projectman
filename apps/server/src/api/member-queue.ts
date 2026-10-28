import type { FastifyInstance } from 'fastify';
import { MemberQueueQuery, projectManagerOf, routes } from '@projectman/shared';
import type { MemberQueueView, ProjectConfig } from '@projectman/shared';
import type { ApiDomain } from './ports';
import { DomainError, forbidden } from '../kernel';
import { requireAccess } from './context';
import { parseBody } from '../http';

/**
 * The project manager's queue (PM-894, PM-1042): the people of the team read them with their
 * own login (a developer or more), the integrator's read and super keys read too.
 */
export function registerMemberQueueRoutes(app: FastifyInstance, deps: { domain: ApiDomain }): void {
  const { domain } = deps;

  const registerQueue = (
    path: string,
    memberOf: (config: Pick<ProjectConfig, 'team'>) => { handle: string } | null,
    absent: string,
  ) =>
    app.get<{ Params: { key: string } }>(path, async (request): Promise<MemberQueueView> => {
      const key = request.params.key;
      const access = await requireAccess(domain, request, key, { minimum: 'developer' });
      if (access.via && !request.principal)
        throw forbidden('operator_owner_only', 'the queues are for a person’s own login');
      const member = memberOf(await domain.projects.config(key));
      if (!member) throw new DomainError('unknown_member', absent, { status: 404 });
      const { closedSince } = parseBody(MemberQueueQuery, request.query);
      return domain.memberQueue.view(key, member.handle, closedSince ? new Date(closedSince) : undefined);
    });

  registerQueue(
    routes.projectManagerQueue(':key'),
    projectManagerOf,
    'no AI member project manager in this project',
  );
}
