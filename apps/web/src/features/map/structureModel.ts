import { MAP_STATE_ORDER } from '@projectman/shared';
import type { MapState, StructureCard } from '@projectman/shared';

/** Logarithmic plot size relative to the repository's largest module. */
export function moduleSize(files: number, max: number): 1 | 2 | 3 | 4 {
  if (files <= 0 || max <= 0) return 1;
  const ratio = Math.log1p(files) / Math.log1p(max);
  return ratio < 0.45 ? 1 : ratio < 0.65 ? 2 : ratio < 0.85 ? 3 : 4;
}

export function sortCards(
  cards: readonly StructureCard[],
  states: ReadonlyMap<string, MapState | null>,
): StructureCard[] {
  const rank = (card: StructureCard) =>
    card.source === 'merge'
      ? MAP_STATE_ORDER.length
      : MAP_STATE_ORDER.indexOf(states.get(card.taskKey) ?? 'waiting');
  return [...cards].sort((a, b) => rank(a) - rank(b));
}
