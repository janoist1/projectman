import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InboxKind, InboxState, ResolveInboxRequest, routes } from '@projectman/shared';
import type { InboxItem, InboxView, ScreenedQuestionsResponse } from '@projectman/shared';
import type { Domain } from '../domain';
import { canSeeInboxItem } from '../core/projects';
import { requireAccess } from './context';
import { parseBody } from './validation';

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

export function registerInboxRoutes(app: FastifyInstance, domain: Domain): void {
  app.post<ItemParams>(routes.checkOutage(':key', ':itemId'), async (request) => {
    const { key, itemId } = request.params;
    const access = await requireAccess(domain, request, key, { internal: true });
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
      .filter((item) => canSeeInboxItem(access, item) && (!mine || item.assignees.includes(access.handle)));
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

  /** Assignees resolve items; owners may also answer permission requests and questions. */
  app.post<ItemParams>(routes.resolveInbox(':key', ':itemId'), async (request): Promise<InboxItem> => {
    const { key, itemId } = request.params;
    const access = await requireAccess(domain, request, key);
    const body = parseBody(ResolveInboxRequest, request.body);
    return domain.inbox.resolve(key, itemId, body, access);
  });
}
