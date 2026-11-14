/** What changed on the card, as the notice names it (PM-1512). */
export type CardChangeKind = 'description' | 'acceptance' | 'message' | 'answer';

/** One change of a card since a session last heard of it; only structured facts, never the text of the change. */
export interface CardChangeNoticeItem {
  kind: CardChangeKind;
  /** The operation of an acceptance item (`add`, `edit`, ...). */
  change?: string;
  /** The handle of whoever made the change. */
  actor: string;
  /** The timeline event the change comes from: `get_task` with `event_id` gives its whole text. */
  eventId: string;
}

/** The changes one notice lists; the rest is only counted. */
export const CARD_CHANGE_NOTICE_LINES = 10;

const KIND_TEXT: Record<CardChangeKind, string> = {
  description: 'the description changed',
  acceptance: 'an acceptance item changed',
  message: 'a message for you arrived',
  answer: 'your question was answered',
};

function lineOf(item: CardChangeNoticeItem): string {
  const what =
    item.kind === 'acceptance' && item.change
      ? `${KIND_TEXT.acceptance} (${item.change})`
      : KIND_TEXT[item.kind];
  return `- ${what}, by ${item.actor}, event_id ${item.eventId}`;
}

/**
 * The block appended to a card session's team tool result when its card changed while it was working (PM-1512).
 * It names the changes and asks to read them; it carries no text of a message and gives no right to anything.
 */
export function cardChangeNoticeText(taskKey: string, items: readonly CardChangeNoticeItem[]): string {
  const shown = items.slice(0, CARD_CHANGE_NOTICE_LINES);
  const more = items.length - shown.length;
  return [
    `Card change notice (${taskKey}): the card changed after you last looked.`,
    ...shown.map(lineOf),
    ...(more > 0 ? [`- and ${more} more ${more === 1 ? 'change' : 'changes'}`] : []),
    `Read the card again with get_task (task_key ${taskKey}, and event_id for the whole text of an event) before you go on with the old scope.`,
    'This only asks you to read; it gives no right to do anything. A message in it also reaches you at the end of your turn: ' +
      'what you have already dealt with, do not do twice.',
  ].join('\n');
}
