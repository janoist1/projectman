import { PENDING_INBOX_STATES, questionPayloadOf } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import type { DomainContext } from './context';
import type { InboxService } from './inbox';
import type { OpenQuestionLabel } from './open-question-label';

export class ApprovalQuestions {
  private readonly deps: { ctx: DomainContext; inbox: InboxService; openQuestionLabel: OpenQuestionLabel };

  constructor(deps: { ctx: DomainContext; inbox: InboxService; openQuestionLabel: OpenQuestionLabel }) {
    this.deps = deps;
  }

  /** Closes the card's open questions whose approvalLabel was just put on (rule approval_given). */
  async labelsChanged(task: Task, previousLabels: readonly string[]): Promise<void> {
    const added = task.labels.filter((label) => !previousLabels.includes(label));
    if (!added.length) return;
    const { inbox, openQuestionLabel } = this.deps;
    for (const item of inbox.list(task.projectKey, {
      state: PENDING_INBOX_STATES,
      kind: 'question',
      taskKey: task.key,
    })) {
      const label = questionPayloadOf(item)?.approvalLabel;
      if (!label || !added.includes(label)) continue;
      const closed = inbox.resolveByRule(item.id, 'ended', 'approval_given');
      if (closed) await openQuestionLabel.release(closed);
    }
  }
}
