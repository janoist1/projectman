import { OPERATOR_ANSWER_STALL_GRACE_MS } from '../api/dto';

/** An answer or message delivered to a member about a card (PM-694); never its text. */
export interface AnswerEvidence {
  id: string;
  /** When it reached the member (the recipient receipt's `deliveredAt`, not the time it was sent). */
  at: string;
  /** It carries a person's answer to the member's question (the second detection branch needs one). */
  carriesAnswer: boolean;
}

export interface AnswerStallInput {
  now: number;
  /** The card carries `waiting-answer`. */
  labelled: boolean;
  /** A real question of the member about the card is still open: it is not ours to clear. */
  openQuestion: boolean;
  /** The member's session on the card waits for a permission: a reason of its own, never a push. */
  permissionWaiting: boolean;
  /** The member's session on the card is starting or working. */
  working: boolean;
  /** The member's session on the card waits for input in the terminal. */
  waitingInput: boolean;
  /** Since when the member has no session in a state above (ms); 0: always. */
  idleSince: number;
  /** The member's last proven step on the card (ms), or null. */
  lastStepAt: number | null;
  evidence: readonly AnswerEvidence[];
}

/**
 * The evidence that makes a member's stall (PM-694), or null. Two branches:
 * - The member has no running, starting or input-waiting session on the card, and something reached
 *   them after their last proven step.
 * - The card carries `waiting-answer` although every question is answered: an answer reached the member
 *   after their last proven step. The label does not delete the evidence.
 * Either holds only once it has stood `OPERATOR_ANSWER_STALL_GRACE_MS`.
 */
export function answerStallEvidence(input: AnswerStallInput): AnswerEvidence | null {
  if (input.permissionWaiting || input.openQuestion || input.working) return null;
  if (!input.labelled && input.waitingInput) return null;
  const after = input.evidence.filter(
    (e) =>
      (input.lastStepAt === null || Date.parse(e.at) > input.lastStepAt) &&
      (!input.labelled || e.carriesAnswer),
  );
  const latest = after.reduce<AnswerEvidence | null>(
    (best, e) => (best === null || Date.parse(e.at) >= Date.parse(best.at) ? e : best),
    null,
  );
  if (!latest) return null;
  const since = input.labelled ? Date.parse(latest.at) : Math.max(Date.parse(latest.at), input.idleSince);
  return input.now - since >= OPERATOR_ANSWER_STALL_GRACE_MS ? latest : null;
}
