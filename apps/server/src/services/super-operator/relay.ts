import { canSeeTask, isRelayableQuestionItem, visibleQuestionItem } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { ANSWER_OPTION } from '../../core/inbox';
import type { InboxService } from '../../core/inbox';
import type { ProjectAccess } from '../../core/members';
import { canSeeInboxItem } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { forbidden, notFound } from '../../kernel';

/**
 * The integrator in super mode relays the owner's words to a plain information question (PM-762). It is not
 * an owner decision: a question that is not an explicit information question is refused. One rule for the
 * REST route and the bearer MCP (PM-760).
 */
export async function relayOwnerAnswer(
  deps: { inbox: Pick<InboxService, 'get' | 'resolve'>; tasks: Pick<TaskService, 'find'> },
  projectKey: string,
  itemId: string,
  answer: string,
  access: ProjectAccess,
): Promise<{ item: InboxItem }> {
  if (!access.superActor)
    throw forbidden('super_relay_refused', 'only the integrator in super mode relays an answer');
  const item = deps.inbox.get(projectKey, itemId);
  if (!canSeeInboxItem(access, item)) throw notFound('inbox item', itemId);
  if (!isRelayableQuestionItem(item))
    throw forbidden('super_relay_refused', 'only an information question can be answered by a relay');
  const resolved = await deps.inbox.resolve(
    projectKey,
    itemId,
    { optionId: ANSWER_OPTION.id, note: answer },
    access,
  );
  return {
    item: visibleQuestionItem(access, resolved, (taskKey) => {
      const task = deps.tasks.find(projectKey, taskKey);
      return !!task && canSeeTask(access, task);
    }),
  };
}
