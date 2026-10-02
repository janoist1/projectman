import { z } from 'zod';
import type { Stage } from './pipeline';
import { TaskKey } from './task';

/**
 * The manual order of the cards of a board column (PM-118): shared, stored and the same in every
 * browser. A card's `boardRank` orders it among the open cards of its column (project + the board
 * column its stage is shown in, so several stages of one column share one order). The rank is spaced
 * (`BOARD_RANK_STEP` apart) so one drop usually writes one card; only a column with no room left
 * between two neighbours is numbered afresh. The rules live here, for the server and the web's fake.
 */
export const BOARD_RANK_STEP = 1024;

/**
 * Where a dragged card lands, relative to the cards the person sees: before or after an anchor card,
 * or at the top or the end of the column. The client sends no rank and no list: the server counts the rank.
 */
export const BoardPlacement = z.discriminatedUnion('at', [
  z.object({ at: z.literal('top') }),
  z.object({ at: z.literal('end') }),
  z.object({ at: z.literal('before'), anchor: TaskKey }),
  z.object({ at: z.literal('after'), anchor: TaskKey }),
]);
export type BoardPlacement = z.infer<typeof BoardPlacement>;

/** The board column a stage is shown in. */
export function boardColumnOf(stage: Pick<Stage, 'columnId'> | undefined): string | undefined {
  return stage?.columnId;
}

/** The stages shown in a board column, in pipeline order. */
export function stagesOfColumn<T extends Pick<Stage, 'columnId'>>(
  stages: readonly T[],
  columnId: string,
): T[] {
  return stages.filter((stage) => stage.columnId === columnId);
}

/**
 * Dropping a card on another column enters its first stage, in pipeline order (null: the column has
 * no stage).
 */
export function dropStageOfColumn<T extends Pick<Stage, 'columnId'>>(
  stages: readonly T[],
  columnId: string,
): T | null {
  return stages.find((stage) => stage.columnId === columnId) ?? null;
}

/**
 * A column of finished work is ordered by when its cards were closed (newest first), never by hand:
 * every stage it shows is a `done` stage.
 */
export function isChronologicalColumn(
  stages: readonly Pick<Stage, 'columnId' | 'kind'>[],
  columnId: string,
): boolean {
  const own = stagesOfColumn(stages, columnId);
  return own.length > 0 && own.every((stage) => stage.kind === 'done');
}

/** A card in a column's order. `rank` is absent on a card read from before ranks existed. */
export interface RankedCard {
  key: string;
  rank?: number | null | undefined;
  updatedAt: string;
}

function seqOf(key: string): number {
  return Number(key.slice(key.lastIndexOf('-') + 1));
}

/**
 * The order of a column: by rank, a card without one after the ranked ones; equal ranks (and cards
 * without a rank, like those a client reads from an older server) by the newest update, then the
 * highest card number: the order the migration gave the cards that existed before ranks.
 */
export function compareBoardOrder(a: RankedCard, b: RankedCard): number {
  const byRank = (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
  if (byRank !== 0) return byRank;
  const byUpdate = b.updatedAt.localeCompare(a.updatedAt);
  if (byUpdate !== 0) return byUpdate;
  return seqOf(b.key) - seqOf(a.key);
}

export function sortBoardOrder<T extends RankedCard>(cards: readonly T[]): T[] {
  return [...cards].sort(compareBoardOrder);
}

/**
 * What a drop does to the stored ranks: `stale` (the anchor is not a card of the column, or is the
 * card itself), `unchanged` (the card is where the drop puts it), or the ranks to write: the moved
 * card's, and the other cards' only when the column had to be numbered afresh.
 */
export type RankPlan =
  | { status: 'stale' }
  | { status: 'unchanged' }
  | { status: 'planned'; ranks: Array<{ key: string; rank: number }>; renumbered: boolean };

/**
 * Plans the placing of `moving` in `column` (the open cards of the target column; it may include
 * `moving` when the card is already there). Pure: nothing is written here.
 */
export function planRanks(
  column: readonly RankedCard[],
  moving: RankedCard,
  placement: BoardPlacement,
): RankPlan {
  const sorted = sortBoardOrder(column);
  const current = sorted.findIndex((card) => card.key === moving.key);
  const others = sorted.filter((card) => card.key !== moving.key);
  let index: number;
  if (placement.at === 'top') index = 0;
  else if (placement.at === 'end') index = others.length;
  else {
    const anchor = others.findIndex((card) => card.key === placement.anchor);
    if (anchor < 0) return { status: 'stale' };
    index = placement.at === 'before' ? anchor : anchor + 1;
  }
  if (index === current) return { status: 'unchanged' };

  const prev = others[index - 1];
  const next = others[index];
  const rank = spacedRank(prev?.rank, next?.rank, !prev, !next);
  if (rank !== null) return { status: 'planned', ranks: [{ key: moving.key, rank }], renumbered: false };

  // No room between the neighbours (or a card without a rank): number the whole column afresh.
  const order = [...others.slice(0, index), moving, ...others.slice(index)];
  const ranks: Array<{ key: string; rank: number }> = [];
  order.forEach((card, position) => {
    const wanted = (position + 1) * BOARD_RANK_STEP;
    if (card.key === moving.key || card.rank !== wanted) ranks.push({ key: card.key, rank: wanted });
  });
  return { status: 'planned', ranks, renumbered: true };
}

/** A rank between two neighbours, or null when there is no whole number between them. */
function spacedRank(
  prev: number | null | undefined,
  next: number | null | undefined,
  noPrev: boolean,
  noNext: boolean,
): number | null {
  if (noPrev && noNext) return 0;
  if (noPrev) return typeof next === 'number' ? next - BOARD_RANK_STEP : null;
  if (noNext) return typeof prev === 'number' ? prev + BOARD_RANK_STEP : null;
  if (typeof prev !== 'number' || typeof next !== 'number' || next - prev < 2) return null;
  return prev + Math.floor((next - prev) / 2);
}

/**
 * The keys of a column's visible cards after `key` was dropped by `placement` (the optimistic order
 * a client shows while the move is on its way); null when the anchor is not among them.
 */
export function placeInOrder(
  keys: readonly string[],
  key: string,
  placement: BoardPlacement,
): string[] | null {
  const others = keys.filter((other) => other !== key);
  if (placement.at === 'top') return [key, ...others];
  if (placement.at === 'end') return [...others, key];
  const anchor = others.indexOf(placement.anchor);
  if (anchor < 0) return null;
  const at = placement.at === 'before' ? anchor : anchor + 1;
  return [...others.slice(0, at), key, ...others.slice(at)];
}

/**
 * The placement that puts the card at `index` among the visible cards `keys` (the card itself
 * included, if it is there): relative to the visible neighbour, so cards the person does not see keep
 * their places. Null when the drop leaves the card where it is.
 */
export function placementAt(keys: readonly string[], key: string, index: number): BoardPlacement | null {
  const others = keys.filter((other) => other !== key);
  const at = Math.max(0, Math.min(index, others.length));
  const current = keys.indexOf(key);
  if (current === at) return null;
  const before = others[at];
  if (before !== undefined) return { at: 'before', anchor: before };
  const after = others[at - 1];
  return after !== undefined ? { at: 'after', anchor: after } : { at: 'top' };
}
