import { seniorWaitAnswerOf } from '@projectman/shared';
import type { DomainContext } from '../base';

/**
 * What the owners decided about a card's Senior wait (PM-348): the answer to the question of the card's live
 * `senior_wait` obligation, as a person gave it. Null before an answer. The start reads it to wait on or
 * to give the card to any developer, and the assignee fit accepts that developer.
 */
export function seniorWaitDecisionFor(
  ctx: Pick<DomainContext, 'repos'>,
  projectKey: string,
  taskKey: string,
): { decision: 'wait' | 'any'; by: string } | null {
  const row = ctx.repos.obligations.liveOfKind(projectKey, taskKey, 'senior_wait');
  const item = row?.inboxItemId ? ctx.repos.inbox.get(row.inboxItemId) : null;
  const answer = item ? seniorWaitAnswerOf(item) : null;
  return answer ? { decision: answer.decision, by: answer.by } : null;
}
