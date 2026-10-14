import type { FastifyInstance } from 'fastify';
import { PrioritizeMergeRequest, routes, StartMergeRequest } from '@projectman/shared';
import type { Domain } from '../domain';
import { actorOf, requireAccess } from './context';
import { parseBody } from './validation';

type TaskParams = { Params: { key: string; taskKey: string } };

/** The merge of a card (services/merges): starting it and moving it in its repository's queue. */
export function registerMergeRoutes(app: FastifyInstance, domain: Domain): void {
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
