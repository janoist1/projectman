import type { AcceptanceItem } from '@projectman/shared';
import { oneLine, PLAIN_STYLE, type TextStyle } from './text';

const TEXT_LIMIT = 300;
const EVIDENCE_LIMIT = 300;

/** How far an item is: what marked it and what it points at, then who confirmed it. */
function itemState(item: AcceptanceItem): string {
  const confirmation = item.confirmedBy ? `confirmed by ${item.confirmedBy}` : 'not confirmed';
  switch (item.state) {
    case 'open':
      return 'open';
    case 'done':
      return `done (${oneLine(item.evidence ?? '', EVIDENCE_LIMIT)}) by ${item.markedBy ?? 'unknown'}, ${confirmation}`;
    case 'not_needed':
      return `not needed (${oneLine(item.reason ?? '', EVIDENCE_LIMIT)}) by ${item.markedBy ?? 'unknown'}, ${confirmation}`;
    case 'moved':
      return `moved to ${item.movedTo ?? '?'} by ${item.markedBy ?? 'unknown'}, ${confirmation}`;
  }
}

/** The acceptance items of a card, one line each with the id an update names: `- acc_… [state] text`. */
export function acceptanceLines(
  items: readonly AcceptanceItem[],
  style: Pick<TextStyle, 'code'> = PLAIN_STYLE,
): string[] {
  if (items.length === 0) return [];
  return [
    'Acceptance items (the conditions of done):',
    ...items.map(
      (item) =>
        `- ${style.code(item.id)} [${itemState(item)}] ${oneLine(item.text, TEXT_LIMIT)}` +
        (item.origin ? ` (moved here from ${item.origin.taskKey})` : ''),
    ),
  ];
}
