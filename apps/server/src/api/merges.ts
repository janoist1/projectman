import type { FastifyInstance } from 'fastify';
import {
  OrderMergeQueueRequest,
  PrioritizeMergeRequest,
  routes,
  StartMergeRequest,
} from '@projectman/shared';
import type { ApiDomain } from './ports';
import { actorOf, requireAccess } from './context';
import { parseBody } from '../http';

type TaskParams = { Params: { key: string; taskKey: string } };

/** The merge of a card (services/merges): starting it and moving it in its repository's queue. */
export function registerMergeRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.get<{ Params: { key: string }; Querystring: { repo: string } }>(
    routes.mergeQueueOrder(':key'),
    async (request) => {
      await requireAccess(domain, request, request.params.key);
      const { repo } = parseBody(OrderMergeQueueRequest.pick({ repo: true }), request.query);
      return domain.merges.queueOrder(request.params.key, repo);
    },
  );
  app.put<{ Params: { key: string } }>(routes.mergeQueueOrder(':key'), async (request) => {
    const access = await requireAccess(domain, request, request.params.key, { minimum: 'owner' });
    return domain.merges.orderQueue(
      request.params.key,
      actorOf(access),
      parseBody(OrderMergeQueueRequest, request.body),
    );
  });
  app.post<TaskParams>(routes.taskMerge(':key', ':taskKey'), async (request) => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    const body = parseBody(StartMergeRequest, request.body);
    return { task: await domain.merges.start(key, taskKey, actorOf(access), body) };
  });

  /** The card's merger or an owner puts its queued merge at the front of the queue (PM-576). */
  app.post<TaskParams>(routes.taskMergePrioritize(':key', ':taskKey'), async (request) => {
    const { key, taskKey } = request.params;
    const access = await requireAccess(domain, request, key, { minimum: 'developer' });
    const body = parseBody(PrioritizeMergeRequest, request.body);
    return domain.merges.prioritize(key, taskKey, actorOf(access), body.reason);
  });
}
