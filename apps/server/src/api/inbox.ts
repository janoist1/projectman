import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  InboxKind,
  InboxState,
  RelayOwnerAnswerRequest,
  ResolveInboxRequest,
  ResolveIntegratorFixLimitRequest,
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
import { relayOwnerAnswer, resolveIntegratorFixLimit } from '../services/super-operator';

type ProjectParams = { Params: { key: string } };
type ItemParams = { Params: { key: string; itemId: string } };

const HISTORY_LIMIT = 500;
const CLOSED_STATES: readonly InboxState[] = ['resolved', 'expired', 'cancelled'];
const ACTIVE_STATES: readonly InboxState[] = ['open', 'screening'];

const InboxQuery = z.object({
  /**
   * Default "open". "active" is what has not ended: open and screening items, a question combined into
   * another one included. "closed" is resolved, expired and cancelled together; "all" returns every state.
   */
  state: z.union([InboxState, z.enum(['all', 'active', 'closed'])]).optional(),
  kind: InboxKind.optional(),
  /** The newest N items. Without it: every open or active item, and the newest 500 of any other state. */
  limit: z.coerce.number().int().min(1).max(HISTORY_LIMIT).optional(),
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
    const requested = query.state ?? 'open';
    const state =
      requested === 'all'
        ? undefined
        : requested === 'closed'
          ? CLOSED_STATES
          : requested === 'active'
            ? ACTIVE_STATES
            : requested;
    const mine = query.mine === 'true' || query.mine === '1';
    // The wide reads keep a question combined into another: the card's group marker reads it. A single state hides it.
    const keepLinked = requested === 'all' || requested === 'active' || requested === 'closed';
    // What is open is never cut off (every open item is a person's to do); any other state is a history: the newest N.
    const limit = query.limit ?? (requested === 'open' || requested === 'active' ? undefined : HISTORY_LIMIT);
    const items = domain.inbox
      .list(key, { state, kind: query.kind, limit })
      .filter((item) => canSeeInboxItem(access, item) && (!mine || humanInboxAssignment(item, access.handle)))
      .filter((item) => keepLinked || !isLinkedQuestion(item))
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
