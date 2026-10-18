import {
  ResolveIntegratorFixLimitRequest,
  canSeeTask,
  isIntegratorInboxItem,
  visibleQuestionItem,
  wasIntegratorInboxItem,
} from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import type { InboxService } from '../../core/inbox';
import type { ProjectAccess } from '../../core/members';
import { canSeeInboxItem } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { forbidden, invalid, notFound } from '../../kernel';

/** The most items one list of the integrator's inbox returns. */
const INTEGRATOR_INBOX_LIMIT = 500;

interface Deps {
  inbox: Pick<InboxService, 'get'>;
  tasks: Pick<TaskService, 'find'>;
}

function visible(deps: Deps, projectKey: string, item: InboxItem, access: ProjectAccess): InboxItem {
  return visibleQuestionItem(access, item, (key) => {
    const task = deps.tasks.find(projectKey, key);
    return !!task && canSeeTask(access, task);
  });
}

/**
 * The integrator decides the fix round limit item addressed to it (PM-714), or hands the same item to the
 * owners. One adapter for REST, the CLI and the external MCP; it is the integrator's own work and grants no
 * other approval: the inbox service refuses every item that is not that narrow decision.
 */
export async function resolveIntegratorFixLimit(
  deps: Deps & { inbox: Pick<InboxService, 'get' | 'resolveIntegratorFixLimit'> },
  projectKey: string,
  itemId: string,
  request: ResolveIntegratorFixLimitRequest,
  access: ProjectAccess,
): Promise<{ item: InboxItem }> {
  const parsed = ResolveIntegratorFixLimitRequest.safeParse(request);
  if (!parsed.success) throw invalid('invalid_request', 'invalid integrator fix limit decision');
  if (!canSeeInboxItem(access, deps.inbox.get(projectKey, itemId))) throw notFound('inbox item', itemId);
  if (!access.superActor)
    throw forbidden('integrator_not_allowed', 'an explicit super credential is required');
  const item = await deps.inbox.resolveIntegratorFixLimit(projectKey, itemId, parsed.data, access);
  return { item: visible(deps, projectKey, item, access) };
}

/**
 * What the integrator is the recipient of, with the full text of every item (PM-714): the open ones, or
 * with `all` every item that was ever opened to it, newest first. The same visibility rule as the inbox list.
 */
export function listIntegratorInbox(
  deps: Deps & { inbox: Pick<InboxService, 'get' | 'list'> },
  projectKey: string,
  state: 'open' | 'all',
  access: ProjectAccess,
): { items: InboxItem[] } {
  if (!access.superActor)
    throw forbidden('integrator_not_allowed', 'an explicit super credential is required');
  const items = deps.inbox
    .list(
      projectKey,
      state === 'open' ? { state: 'open', limit: INTEGRATOR_INBOX_LIMIT } : { limit: INTEGRATOR_INBOX_LIMIT },
    )
    .filter(
      (item) =>
        canSeeInboxItem(access, item) &&
        (state === 'open' ? isIntegratorInboxItem(item) : wasIntegratorInboxItem(item)),
    )
    .map((item) => visible(deps, projectKey, item, access));
  return { items };
}
