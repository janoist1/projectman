import type { FastifyInstance } from 'fastify';
import { MemberQueueQuery, operatorOf, routes } from '@projectman/shared';
import type { MemberQueueView } from '@projectman/shared';
import type { ApiDomain } from './ports';
import { DomainError, forbidden } from '../kernel';
import { requireAccess } from './context';
import { parseBody } from '../http';

/**
 * The Operator's queue (PM-894): the people of the team read it with their own login (a developer or more),
 * the integrator's read and super keys read too.
 */
export function registerMemberQueueRoutes(app: FastifyInstance, deps: { domain: ApiDomain }): void {
  const { domain } = deps;

  app.get<{ Params: { key: string } }>(
    routes.operatorQueue(':key'),
    async (request): Promise<MemberQueueView> => {
      const key = request.params.key;
      const access = await requireAccess(domain, request, key, { minimum: 'developer' });
      if (access.via && !request.principal)
        throw forbidden('operator_owner_only', 'the queues are for a person’s own login');
      const operator = operatorOf(await domain.projects.config(key));
      if (!operator)
        throw new DomainError('unknown_member', 'no AI member operator in this project', { status: 404 });
      const { closedSince } = parseBody(MemberQueueQuery, request.query);
      return domain.memberQueue.view(key, operator.handle, closedSince ? new Date(closedSince) : undefined);
    },
  );
}
