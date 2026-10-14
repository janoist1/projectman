import type { AnswerEvidence } from '@projectman/shared';
import type { DomainContext } from '../../core/base';

/** How many of a card's latest messages the evidence reader looks at. */
const EVIDENCE_MESSAGES = 200;

/**
 * What reached `member` about the card and may need their next step (PM-694), newest last, without any
 * text: a message sent to them (an answer to their question, or a request) that their receipt marks as
 * delivered. The time is the receipt's `deliveredAt`, never the time of sending. Information messages,
 * the member's own and the Operator's own pushes (they are the reaction, not the cause) are left out.
 */
export function answerEvidenceOf(
  ctx: DomainContext,
  projectKey: string,
  taskKey: string,
  member: string,
): AnswerEvidence[] {
  const found: AnswerEvidence[] = [];
  for (const message of ctx.repos.messages.list(projectKey, { taskKey, member, limit: EVIDENCE_MESSAGES })) {
    if (message.from === member || !message.to.includes(member)) continue;
    if (message.kind === 'info' || message.operatorRequest || message.operatorSignal) continue;
    const receipt = message.receipts?.find((r) => r.handle === member);
    const at = receipt ? receipt.deliveredAt : message.deliveredAt;
    if (!at) continue;
    found.push({ id: message.id, at, carriesAnswer: !!message.answer });
  }
  return found;
}
