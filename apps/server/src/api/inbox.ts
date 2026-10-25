import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  InboxKind,
  InboxState,
  RelayOwnerAnswerRequest,
  ResolveInboxRequest,
  ResolveIntegratorFixLimitRequest,
  ResolveIntegratorTodoRequest,
  humanInboxAssignment,
  routes,
  visibleQuestionItem,
  isLinkedQuestion,
} from '@projectman/shared';
import type { InboxItem, InboxView, ScreenedQuestionsResponse } from '@projectman/shared';
import type { ApiDomain } from './ports';
import { canSeeInboxItem } from '../core/projects';
import { requireAccess } from './context';
import { parseBody } from '../http';
import { notFound } from '../kernel';
import {
  relayOwnerAnswer,
  resolveIntegratorFixLimit,
  resolveIntegratorTodo,
} from '../services/super-operator';

type ProjectParams = { Params: { key: string } };
type ItemParams = { Params: { key: string; itemId: string } };

const InboxQuery = z.object({
  /** Default "open"; "all" returns every state. */
  state: z.union([InboxState, z.literal('all')]).optional(),
  kind: InboxKind.optional(),
  /** "true" limits the list to items assigned to the current user. */
  mine: z.enum(['true', 'false', '1', '0']).optional(),
});

const ScreenedQuery = z.object({
  /** ISO time: `today` counts the screened questions asked since it. */
  since: z.string().datetime({ offset: true }),
});

export function registerInboxRoutes(app: FastifyInstance, domain: ApiDomain): void {
  app.post<ItemParams>(routes.checkOutage(':key', ':itemId'), async (request) => {
    const { key, itemId } = request.params;
    const access = await requireAccess(domain, request, key);
    return domain.outages.checkNow(key, itemId, access);
  });
  app.get<ProjectParams>(routes.inbox(':key'), async (request): Promise<InboxView> => {
    const key = request.params.key;
    const access = await requireAccess(domain, request, key);
    const query = parseBody(InboxQuery, request.query);
    const state = query.state === 'all' ? undefined : (query.state ?? 'open');
    const mine = query.mine === 'true' || query.mine === '1';
    const items = domain.inbox
      .list(key, { state, kind: query.kind, limit: 500 })
      .filter((item) => canSeeInboxItem(access, item) && (!mine || humanInboxAssignment(item, access.handle)))
      .filter((item) => state === undefined || !isLinkedQuestion(item))
      .map((item) => visibleQuestionItem(access, item, (taskKey) => !!domain.tasks.find(key, taskKey)));
    return { items: await domain.inbox.withAskerStart(key, items) };
  });

  /** The questions the Operator screened (PM-558): a look for the owners and admins, who can see all of them. */
  app.get<ProjectParams>(
    routes.screenedQuestions(':key'),
    async (request): Promise<ScreenedQuestionsResponse> => {
      const key = request.params.key;
      await requireAccess(domain, request, key, { minimum: 'admin' });
      const { since } = parseBody(ScreenedQuery, request.query);
      return domain.inbox.screenedQuestions(key, since);
    },
  );

  /**
   * The integrator in super mode relays the owner's words to a plain information question (PM-762). It is
   * not an owner decision: a question that is not an explicit information question is refused.
   */
  app.post<ItemParams>(
    routes.relayOwnerAnswer(':key', ':itemId'),
    async (request): Promise<{ item: InboxItem }> => {
      const { key, itemId } = request.params;
      const access = await requireAccess(domain, request, key);
      const body = parseBody(RelayOwnerAnswerRequest, request.body);
      return relayOwnerAnswer(domain, key, itemId, body.answer, access);
    },
  );

  app.post<ItemParams>(routes.resolveIntegratorTodo(':key', ':itemId'), async (request) => {
    const { key, itemId } = request.params;
    const access = await requireAccess(domain, request, key);
    return resolveIntegratorTodo(
      domain,
      key,
      itemId,
      parseBody(ResolveIntegratorTodoRequest, request.body),
      access,
    );
  });

  /**
   * The integrator in super mode decides the fix round limit item addressed to it, or hands it on to the
   * owners with a reason (PM-714). Only that narrow item; it is not an owner decision or approval.
   */
  app.post<ItemParams>(routes.resolveIntegratorFixLimit(':key', ':itemId'), async (request) => {
    const { key, itemId } = request.params;
    const access = await requireAccess(domain, request, key);
    return resolveIntegratorFixLimit(
      domain,
      key,
      itemId,
      parseBody(ResolveIntegratorFixLimitRequest, request.body),
      access,
    );
  });

  /** Assignees resolve items; owners may also answer permission requests and questions. */
  app.post<ItemParams>(routes.resolveInbox(':key', ':itemId'), async (request): Promise<InboxItem> => {
    const { key, itemId } = request.params;
    const access = await requireAccess(domain, request, key);
    const body = parseBody(ResolveInboxRequest, request.body);
    if (!canSeeInboxItem(access, domain.inbox.get(key, itemId))) throw notFound('inbox item', itemId);
    const resolved = await domain.inbox.resolve(key, itemId, body, access);
    return visibleQuestionItem(access, resolved, (taskKey) => !!domain.tasks.find(key, taskKey));
  });
}
