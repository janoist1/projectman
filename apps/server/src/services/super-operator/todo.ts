import { canSeeTask, ResolveIntegratorTodoRequest, visibleQuestionItem } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import type { InboxService } from '../../core/inbox';
import type { ProjectAccess } from '../../core/members';
import { canSeeInboxItem } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { forbidden, invalid, notFound } from '../../kernel';

/** One adapter for REST and external MCP; this is the integrator's own work, never an owner relay. */
export async function resolveIntegratorTodo(
  deps: { inbox: Pick<InboxService, 'get' | 'resolveIntegratorTodo'>; tasks: Pick<TaskService, 'find'> },
  projectKey: string,
  itemId: string,
  request: ResolveIntegratorTodoRequest,
  access: ProjectAccess,
): Promise<{ item: InboxItem }> {
  const parsed = ResolveIntegratorTodoRequest.safeParse(request);
  if (!parsed.success) throw invalid('invalid_request', 'invalid integrator todo result');
  if (!canSeeInboxItem(access, deps.inbox.get(projectKey, itemId))) throw notFound('inbox item', itemId);
  if (!access.superActor)
    throw forbidden('integrator_not_allowed', 'an explicit super credential is required');
  const item = await deps.inbox.resolveIntegratorTodo(projectKey, itemId, parsed.data, access);
  return {
    item: visibleQuestionItem(access, item, (key) => {
      const task = deps.tasks.find(projectKey, key);
      return !!task && canSeeTask(access, task);
    }),
  };
}
