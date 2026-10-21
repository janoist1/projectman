import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MemberQueueQuery, memberOf, operatorOf, routes } from '@projectman/shared';
import type { ErrorCode, MemberQueuesView, MemberQueueView } from '@projectman/shared';
import type { ApiDomain } from './ports';
import { DomainError, forbidden } from '../kernel';
import { requireAccess } from './context';
import { parseBody } from '../http';

type ProjectParams = { Params: { key: string } };

/**
 * The member queues (PM-894): the people of the team read them with their own login (a developer or more),
 * the integrator's read and super keys read too; the legacy integrator key does not.
 */
export function registerMemberQueueRoutes(app: FastifyInstance, deps: { domain: ApiDomain }): void {
  const { domain } = deps;

  async function readerOf(request: FastifyRequest, key: string, refusal: ErrorCode): Promise<void> {
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    if (access.via && (!request.principal || request.principal.mode === 'legacy'))
      throw forbidden(refusal, 'the queues are for a person’s own login');
  }

  const unknownMember = (handle: string) =>
    new DomainError('unknown_member', `no AI member ${handle} in this project`, { status: 404 });

  const viewOf = async (key: string, handle: string, query: unknown): Promise<MemberQueueView> => {
    const config = await domain.projects.config(key);
    if (memberOf(config, handle)?.kind !== 'ai') throw unknownMember(handle);
    const { closedSince } = parseBody(MemberQueueQuery, query);
    return domain.memberQueue.view(key, handle, closedSince ? new Date(closedSince) : undefined);
  };

  app.get<ProjectParams>(routes.memberQueues(':key'), async (request): Promise<MemberQueuesView> => {
    const key = request.params.key;
    await readerOf(request, key, 'insufficient_access');
    return domain.memberQueue.summaries(key, await domain.projects.config(key));
  });

  app.get<{ Params: { key: string; handle: string }; Querystring: unknown }>(
    routes.memberQueue(':key', ':handle'),
    async (request): Promise<MemberQueueView> => {
      const { key, handle } = request.params;
      await readerOf(request, key, 'insufficient_access');
      return viewOf(key, handle, request.query);
    },
  );

  /** The Operator's queue: the member queue of the project's Operator. */
  app.get<ProjectParams>(routes.operatorQueue(':key'), async (request): Promise<MemberQueueView> => {
    const key = request.params.key;
    await readerOf(request, key, 'operator_owner_only');
    const operator = operatorOf(await domain.projects.config(key));
    if (!operator) throw unknownMember('operator');
    return viewOf(key, operator.handle, request.query);
  });
}
