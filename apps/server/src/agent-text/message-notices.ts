import { stageOf } from '@projectman/shared';
import type { ProjectConfig, QuestionCloseRule, SessionStartCause } from '@projectman/shared';

/** How much of a question and of its answer the notice to the card's other workers carries. */
export const QUESTION_NOTICE_LIMIT = 200;
export const ANSWER_NOTICE_LIMIT = 500;

/** How the asking member gets its question to a person after all, once the Operator handled it (PM-558). */
export function reaskHint(inboxItemId: string): string {
  return (
    `If that does not settle it, ask a person: call ask_human again with reask_of "${inboxItemId}" and ` +
    'reask_reason (why it is not settled); that question goes straight to a person, without screening.'
  );
}

/** Why a question was closed without an answer, as the asking member's notice says it (PM-556). */
export const QUESTION_CLOSE_REASONS: Record<QuestionCloseRule, string> = {
  task_done: 'the card it was about is done',
  task_cancelled: 'the card it was about was cancelled',
  handed_off: 'the card it was about was handed to someone else',
  assignee_changed: 'the card it was about has a new assignee',
  withdrawn: 'it was withdrawn',
  group_withdrawn: 'every asker withdrew the shared question',
  operator_moot: 'the Operator found it moot: nothing is left to answer',
  obligation_closed: 'the step it handed over was done or dropped meanwhile',
  signal_resolved: 'the signal it was asked about ended by itself: nothing is left to answer',
};

/** Why a session joined a card, as the joined notice says it (empty when nothing is known). */
export function startReason(config: ProjectConfig, cause: SessionStartCause | null): string {
  if (!cause) return '';
  const sender = cause.by ? `\`${cause.by.handle}\`${cause.by.via ? ' via the integrator' : ''}` : null;
  switch (cause.kind) {
    case 'message':
      return ` (woken by a team message${sender ? ` from ${sender}` : ''})`;
    case 'mention':
    case 'answer':
      return ` (woken by ${cause.kind}${sender ? ` from ${sender}` : ''}${cause.quote ? `: ${cause.quote}` : ''})`;
    case 'hand_over':
      return ` (the card entered ${stageOf(config, cause.to ?? '')?.name ?? cause.to}${sender ? `, moved by ${sender}` : ''})`;
    case 'refinement':
      return ` (its refinement step for label ${cause.labels?.join(', ')})`;
    case 'start_button':
      return sender ? ` (started by ${sender})` : ' (started with the Start button)';
    default:
      return ` (${cause.kind})`;
  }
}
