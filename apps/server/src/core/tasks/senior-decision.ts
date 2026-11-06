import { seniorWaitAnswerOf } from '@projectman/shared';
import type { DomainContext } from '../base';

/**
 * What was decided about a card's Senior wait (PM-348, PM-1251): the project manager's decision on the card's
 * live `senior_wait` obligation (`decide_senior_wait`), or else the answer a person gave to the question of an
 * older row (the owners were asked before PM-1251, and still are on a project without a project manager).
 * Null before a decision. The start reads it to wait on or to give the card to any developer, and the
 * assignee fit accepts that developer.
 */
export function seniorWaitDecisionFor(
  ctx: Pick<DomainContext, 'repos'>,
  projectKey: string,
  taskKey: string,
): { decision: 'wait' | 'any'; by: string } | null {
  const row = ctx.repos.obligations.liveOfKind(projectKey, taskKey, 'senior_wait');
  if (row?.decision && row.decidedBy) return { decision: row.decision, by: row.decidedBy };
  const item = row?.inboxItemId ? ctx.repos.inbox.get(row.inboxItemId) : null;
  const answer = item ? seniorWaitAnswerOf(item) : null;
  return answer ? { decision: answer.decision, by: answer.by } : null;
}
