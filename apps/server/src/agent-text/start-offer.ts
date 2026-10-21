/**
 * The action message that names the ready cards the system can start now (PM-804). It names what to do
 * and never does it: the member moves the cards, the system picks the developer (decision 3 of PM-427).
 */
export interface StartOfferText {
  /** The card, or for a collecting card the collector. */
  subjectKey: string;
  collector: boolean;
  /** The cards that can start, in the order to start them. */
  cards: readonly { key: string; title: string }[];
  /** The collector's other open parts and why each waits (`taskWaitShort`). */
  waiting: readonly { key: string; why: string }[];
  toStageId: string;
  /** The cards are already in `toStageId` with an assignee who has no session on them: they are started, not moved (PM-879). */
  inWork?: boolean;
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
  if (input.inWork) {
    // The cards stand in the work stage with their assignee and no session: nothing to move, only to start.
    lines.push(
      `Each is already in ${toStageId} with its assignee, who has not started it: start it with start_task, do not move it. ` +
        `Skip a card only if the owner's comment holds it now.`,
    );
    return lines.join('\n');
  }
  lines.push(
    `Move each to ${toStageId} with update_task (stage_id ${toStageId}); the system picks the developer. ` +
      `Skip a card only if a frame or focus lock holds it now. ` +
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
