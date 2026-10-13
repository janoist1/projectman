import { PENDING_INBOX_STATES } from '@projectman/shared';
import type { InboxItem, QuestionCloseRule, Task } from '@projectman/shared';
import type { DomainContext } from './context';
import type { InboxService } from './inbox';

/**
 * Closes a member's pending question (open, or with the Operator for screening) when nothing is left to
 * answer (PM-556): the card is done or cancelled, or the member who asked no longer holds it. The close
 * goes through `InboxService.closeQuestion`, which records the rule, writes the timeline, takes
 * `waiting-answer` off and tells the asking member's running session. The end of a session is no reason:
 * a question outlives it.
 */
export class QuestionClosing {
  private readonly deps: { ctx: DomainContext; inbox: InboxService };

  constructor(deps: { ctx: DomainContext; inbox: InboxService }) {
    this.deps = deps;
  }

  /** The card is done: every pending question on it is moot. */
  taskDone(task: Task): Promise<void> {
    return this.closeAll(task, 'task_done');
  }

  /** The card was cancelled: every pending question on it is moot. */
  taskCancelled(task: Task): Promise<void> {
    return this.closeAll(task, 'task_cancelled');
  }

  /**
   * The card has a new assignee. Only the previous assignee's questions close: those of the others, and
   * of a member who asked without holding the card, stay. `handed_off` when an open handoff (PM-342)
   * from the previous assignee runs, `assignee_changed` otherwise.
   */
  async assigneeChanged(task: Task, previous: string | null): Promise<void> {
    if (!previous || previous === task.assignee) return;
    const handoff = this.deps.ctx.repos.taskHandoffs.open(task.key);
    const rule: QuestionCloseRule = handoff?.from === previous ? 'handed_off' : 'assignee_changed';
    await this.closeAll(task, rule, previous);
  }

  private async closeAll(task: Task, rule: QuestionCloseRule, asker?: string): Promise<void> {
    const { inbox } = this.deps;
    const pending: InboxItem[] = inbox.list(task.projectKey, {
      state: PENDING_INBOX_STATES,
      kind: 'question',
      taskKey: task.key,
    });
    for (const item of pending) {
      if (asker !== undefined && item.source !== asker) continue;
      await inbox.closeQuestion(item.id, { rule, by: 'system', note: null });
    }
  }
}
