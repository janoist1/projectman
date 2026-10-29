/**
 * The state of an item that is worked off one by one (a project checklist item, an acceptance item of a
 * card): open, done, not needed, or moved to another card. Everything but `open` is settled.
 */
export const ITEM_STATES = ['open', 'done', 'not_needed', 'moved'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** How many of the items are settled (not open), and whether all of them are. */
export function itemProgress(items: readonly { state: ItemState }[]): {
  settled: number;
  total: number;
  complete: boolean;
} {
  const settled = items.filter((item) => item.state !== 'open').length;
  return { settled, total: items.length, complete: settled === items.length };
}
