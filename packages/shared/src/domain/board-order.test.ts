import { describe, expect, it } from 'vitest';
import {
  BOARD_RANK_STEP,
  BoardPlacement,
  compareBoardOrder,
  dropStageOfColumn,
  isChronologicalColumn,
  placeInOrder,
  placementAt,
  planRanks,
  sortBoardOrder,
  stagesOfColumn,
} from './board-order';
import type { RankedCard } from './board-order';

const card = (key: string, rank?: number, updatedAt = '2026-01-01T00:00:00Z'): RankedCard => ({
  key,
  rank,
  updatedAt,
});
const keys = (cards: readonly RankedCard[]) => cards.map((c) => c.key);

describe('board order rules', () => {
  const stages = [
    { id: 'backlog', columnId: 'todo', kind: 'queue' as const },
    { id: 'review', columnId: 'review', kind: 'step' as const },
    { id: 'merge', columnId: 'review', kind: 'step' as const },
    { id: 'done', columnId: 'done', kind: 'done' as const },
    { id: 'released', columnId: 'done', kind: 'done' as const },
    { id: 'archive', columnId: 'mixed', kind: 'done' as const },
    { id: 'parked', columnId: 'mixed', kind: 'queue' as const },
  ];

  it('knows the stages of a column, the one a drop enters, and a column of finished work', () => {
    expect(stagesOfColumn(stages, 'review').map((s) => s.id)).toEqual(['review', 'merge']);
    expect(dropStageOfColumn(stages, 'review')?.id).toBe('review');
    expect(dropStageOfColumn(stages, 'nowhere')).toBeNull();
    expect(isChronologicalColumn(stages, 'done')).toBe(true);
    expect(isChronologicalColumn(stages, 'review')).toBe(false);
    expect(isChronologicalColumn(stages, 'mixed')).toBe(false);
    expect(isChronologicalColumn(stages, 'nowhere')).toBe(false);
  });

  it('orders by rank, then the newest update, then the highest number; a card without a rank comes last', () => {
    const cards = [
      card('AR-1', 3000),
      card('AR-2', 1000),
      card('AR-3', undefined, '2026-02-01T00:00:00Z'),
      card('AR-4', 1000, '2026-03-01T00:00:00Z'),
      card('AR-10', 1000, '2026-03-01T00:00:00Z'),
    ];
    expect(keys(sortBoardOrder(cards))).toEqual(['AR-10', 'AR-4', 'AR-2', 'AR-1', 'AR-3']);
    expect(compareBoardOrder(card('AR-1', 1), card('AR-2', 2))).toBeLessThan(0);
  });

  describe('planRanks', () => {
    const column = [card('AR-1', 1000), card('AR-2', 2000), card('AR-3', 3000)];

    it('places at the top, the end, before and after an anchor with one rank between the neighbours', () => {
      const moving = card('AR-9');
      expect(planRanks(column, moving, { at: 'top' })).toEqual({
        status: 'planned',
        renumbered: false,
        ranks: [{ key: 'AR-9', rank: 1000 - BOARD_RANK_STEP }],
      });
      expect(planRanks(column, moving, { at: 'end' })).toMatchObject({
        ranks: [{ key: 'AR-9', rank: 3000 + BOARD_RANK_STEP }],
      });
      expect(planRanks(column, moving, { at: 'before', anchor: 'AR-2' })).toMatchObject({
        ranks: [{ key: 'AR-9', rank: 1500 }],
      });
      expect(planRanks(column, moving, { at: 'after', anchor: 'AR-2' })).toMatchObject({
        ranks: [{ key: 'AR-9', rank: 2500 }],
      });
    });

    it('places the only card of an empty column', () => {
      expect(planRanks([], card('AR-1'), { at: 'top' })).toMatchObject({
        status: 'planned',
        ranks: [{ rank: 0 }],
      });
    });

    it('moves a card of the column: the places it already has are no change', () => {
      expect(planRanks(column, column[1]!, { at: 'before', anchor: 'AR-3' })).toEqual({
        status: 'unchanged',
      });
      expect(planRanks(column, column[1]!, { at: 'after', anchor: 'AR-1' })).toEqual({ status: 'unchanged' });
      expect(planRanks(column, column[0]!, { at: 'top' })).toEqual({ status: 'unchanged' });
      expect(planRanks(column, column[2]!, { at: 'end' })).toEqual({ status: 'unchanged' });
      expect(planRanks(column, column[0]!, { at: 'after', anchor: 'AR-2' })).toMatchObject({
        status: 'planned',
        ranks: [{ key: 'AR-1', rank: 2500 }],
      });
    });

    it('is stale when the anchor is not in the column or is the card itself', () => {
      expect(planRanks(column, card('AR-9'), { at: 'before', anchor: 'AR-7' })).toEqual({ status: 'stale' });
      expect(planRanks(column, column[0]!, { at: 'after', anchor: 'AR-1' })).toEqual({ status: 'stale' });
    });

    it('numbers the column afresh, writing only what changes, when two neighbours have no room', () => {
      const tight = [card('AR-1', 1024), card('AR-2', 1025), card('AR-3', 5000)];
      const plan = planRanks(tight, card('AR-9'), { at: 'after', anchor: 'AR-1' });
      expect(plan).toMatchObject({ status: 'planned', renumbered: true });
      if (plan.status !== 'planned') return;
      // AR-1 keeps 1024: not written; the moving card and those after it are.
      expect(plan.ranks).toEqual([
        { key: 'AR-9', rank: 2048 },
        { key: 'AR-2', rank: 3072 },
        { key: 'AR-3', rank: 4096 },
      ]);
    });

    it('numbers the column afresh when a card has no rank yet', () => {
      const plan = planRanks([card('AR-1'), card('AR-2')], card('AR-9'), { at: 'end' });
      expect(plan).toMatchObject({ status: 'planned', renumbered: true });
    });

    it('survives drops into the same gap, renumbering the column only once the gap is used up', () => {
      let order = [card('AR-1', 1024), card('AR-2', 2048)];
      let renumberings = 0;
      for (let n = 3; n < 203; n++) {
        const plan = planRanks(order, card(`AR-${n}`), { at: 'after', anchor: 'AR-1' });
        if (plan.status !== 'planned') throw new Error('not planned');
        if (plan.renumbered) renumberings += 1;
        const ranks = new Map(plan.ranks.map((r) => [r.key, r.rank]));
        order = sortBoardOrder([
          ...order.map((c) => ({ ...c, rank: ranks.get(c.key) ?? c.rank })),
          card(`AR-${n}`, ranks.get(`AR-${n}`)),
        ]);
        expect(order[1]!.key).toBe(`AR-${n}`);
      }
      // A gap of 1024 halves about ten times: one drop in ten renumbers, the rest write one rank.
      expect(renumberings).toBeLessThanOrEqual(Math.ceil(200 / 9));
      expect(renumberings).toBeGreaterThan(0);
    });
  });

  describe('what the client shows and sends', () => {
    it('places a key in the visible order, or says the anchor is missing', () => {
      const visible = ['AR-1', 'AR-2', 'AR-3'];
      expect(placeInOrder(visible, 'AR-3', { at: 'top' })).toEqual(['AR-3', 'AR-1', 'AR-2']);
      expect(placeInOrder(visible, 'AR-1', { at: 'end' })).toEqual(['AR-2', 'AR-3', 'AR-1']);
      expect(placeInOrder(visible, 'AR-1', { at: 'after', anchor: 'AR-2' })).toEqual([
        'AR-2',
        'AR-1',
        'AR-3',
      ]);
      expect(placeInOrder(visible, 'AR-9', { at: 'before', anchor: 'AR-2' })).toEqual([
        'AR-1',
        'AR-9',
        'AR-2',
        'AR-3',
      ]);
      expect(placeInOrder(visible, 'AR-1', { at: 'before', anchor: 'AR-7' })).toBeNull();
    });

    it('names the visible neighbour a drop is next to, so hidden cards keep their places', () => {
      const visible = ['AR-1', 'AR-2', 'AR-3'];
      expect(placementAt(visible, 'AR-3', 0)).toEqual({ at: 'before', anchor: 'AR-1' });
      expect(placementAt(visible, 'AR-1', 2)).toEqual({ at: 'after', anchor: 'AR-3' });
      expect(placementAt(visible, 'AR-1', 1)).toEqual({ at: 'before', anchor: 'AR-3' });
      expect(placementAt(visible, 'AR-2', 1)).toBeNull();
      expect(placementAt([], 'AR-1', 0)).toEqual({ at: 'top' });
      expect(placementAt(['AR-2'], 'AR-1', 5)).toEqual({ at: 'after', anchor: 'AR-2' });
    });

    it('plans a drop among visible cards with a hidden card between them next to the visible neighbour', () => {
      // AR-2 is hidden by a filter. Dropping AR-3 before the visible AR-1 puts it directly before AR-1.
      const column = [card('AR-1', 1000), card('AR-2', 2000), card('AR-3', 3000)];
      const placement = placementAt(['AR-1', 'AR-3'], 'AR-3', 0)!;
      const plan = planRanks(column, column[2]!, placement);
      expect(plan).toMatchObject({ ranks: [{ key: 'AR-3', rank: 1000 - BOARD_RANK_STEP }] });
      // Dropping AR-1 after the visible AR-3 puts it after AR-3, past the hidden AR-2.
      const after = placementAt(['AR-1', 'AR-3'], 'AR-1', 1)!;
      expect(planRanks(column, column[0]!, after)).toMatchObject({
        ranks: [{ key: 'AR-1', rank: 3000 + BOARD_RANK_STEP }],
      });
    });
  });

  it('accepts only the four placements, and an anchor for before and after', () => {
    expect(BoardPlacement.safeParse({ at: 'top' }).success).toBe(true);
    expect(BoardPlacement.safeParse({ at: 'before', anchor: 'AR-1' }).success).toBe(true);
    expect(BoardPlacement.safeParse({ at: 'before' }).success).toBe(false);
    expect(BoardPlacement.safeParse({ at: 'middle' }).success).toBe(false);
  });
});
