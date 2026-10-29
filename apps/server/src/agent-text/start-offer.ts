/**
 * The action message that names the ready cards the system can start now (PM-804). It names what to do
 * and never does it: the member moves the cards, the system picks the developer (decision 3 of PM-427).
 */
interface StartOfferText {
  /** The card, or for a collecting card the collector. */
  subjectKey: string;
  collector: boolean;
  /** The cards that can start, in the order to start them. */
  cards: readonly { key: string; title: string }[];
  /** The collector's other open parts and why each waits (`taskWaitShort`). */
  waiting: readonly { key: string; why: string }[];
  toStageId: string;
  /** The cards have an assignee who has no session on them: they are started with start_task, not moved (PM-879). */
  assigned?: boolean;
  /** The first stage, where a card the owner holds goes back. */
  backStageId: string;
}

export function startOfferText(input: StartOfferText): string {
  const { subjectKey, collector, cards, waiting, toStageId, backStageId } = input;
  const list = cards.map((card) => `${card.key} "${card.title}"`).join(', ');
  const lines = [
    collector ? `Parts of ${subjectKey} can start now: ${list} (in this order).` : `Can start now: ${list}.`,
  ];
  if (collector && waiting.length > 0)
    lines.push(`The other parts wait: ${waiting.map((part) => `${part.key} (${part.why})`).join(', ')}.`);
  if (input.assigned) {
    // Moving an assigned card starts nobody (PM-119): start_task keeps the assignee, moves the card and starts the session.
    // An assignee whose provider is on hold (PM-1051) and who has not begun the card is replaced by a fitting free member.
    lines.push(
      `Each has an assignee who has not started it: start it with start_task, which keeps the assignee (unless their provider is paused and they have not begun the card: then it picks a fitting free member instead) and moves the card to ${toStageId} if it is not there yet. ` +
        `Do not move it with update_task: that starts nobody. ` +
        `If the owner's comment holds a card, do not start it: open an integrator todo to move it back to ${backStageId}.`,
    );
    return lines.join('\n');
  }
  lines.push(
    `Move each to ${toStageId} with update_task (stage_id ${toStageId}); the system picks the developer. ` +
      `Skip a card only if a frame lock holds it now. ` +
      `If the owner's comment holds a card, do not start it: open an integrator todo to move it back to ${backStageId}.`,
  );
  return lines.join('\n');
}

/** The info message for a collector that is worked out while none of its open parts can start yet. */
export function collectorNotReadyText(input: {
  key: string;
  parts: readonly { key: string; why: string }[];
}): string {
  const list = input.parts.map((part) => `${part.key} (${part.why})`).join(', ');
  return `${input.key} is worked out; none of its parts can start yet: ${list}. You get a message for each part when it can start.`;
}
