import { describe, expect, it } from 'vitest';
import { Task } from './task';
import type { FreeDeveloper } from './choose-developer';
import { compareStartOrder, planStarts } from './start-plan';

const card = (n: number, patch: Partial<Task> = {}): Task =>
  Task.parse({
    id: `tsk_${n}`,
    key: `AC-${n}`,
    projectKey: 'AC',
    title: 'Card',
    description: '',
    stageId: 'ready',
    status: 'active',
    assignee: null,
    repo: null,
    priority: null,
    labels: [],
    links: [],
    createdBy: 'owner',
    createdAt: '2026-10-18T10:00:00Z',
    updatedAt: '2026-10-18T10:00:00Z',
    closedAt: null,
    boardRank: n,
    ...patch,
  });
const dev: FreeDeveloper = { handle: 'dev', limit: 5, temp: false, index: 0, load: 0 };
const big: FreeDeveloper = { ...dev, handle: 'big', limit: 13, index: 1 };
const developers = [
  { handle: 'dev', limit: 5 },
  { handle: 'big', limit: 13 },
] as const;
const base = {
  free: [dev],
  developers,
  anyDecided: new Set<string>(),
  tempMaxPoints: 5 as const,
};
const scored = (points: 8): Partial<Task> => ({
  complexity: { points, reason: 'Runner', setBy: 'owner', setAt: '2026-10-18T10:00:00Z' },
});

describe('start plan', () => {
  it('orders urgent, priority, then board order', () => {
    const cards = [
      card(1),
      card(2, { priority: 'low' }),
      card(3, { priority: 'normal' }),
      card(4, { priority: 'high', boardRank: 2 }),
      card(5, { priority: 'high', boardRank: 1 }),
      card(9, { priority: 'urgent' }),
    ];
    expect(cards.sort(compareStartOrder).map((c) => c.key)).toEqual([
      'AC-9',
      'AC-5',
      'AC-4',
      'AC-3',
      'AC-2',
      'AC-1',
    ]);
  });

  it('ranks a card by its theme priority when given the context (PM-1136)', () => {
    const theme = card(100, { kind: 'theme', priority: 'urgent' });
    const cards = [card(1), card(2, { themeKey: 'AC-100' }), card(3, { priority: 'high' })];
    const keys = (tasks?: Task[]) =>
      [...cards].sort((a, b) => compareStartOrder(a, b, tasks)).map((c) => c.key);
    expect(keys()).toEqual(['AC-3', 'AC-1', 'AC-2']);
    expect(keys([...cards, theme])).toEqual(['AC-2', 'AC-3', 'AC-1']);
  });

  it('plans the card of an urgent theme as a pull, first', () => {
    const theme = card(100, { kind: 'theme', priority: 'urgent' });
    const cards = [card(1), card(2, { themeKey: 'AC-100' })];
    expect([...planStarts({ ...base, cards, tasks: [...cards, theme] }).entries()]).toEqual([
      ['AC-2', { kind: 'pull', developer: 'dev' }],
      ['AC-1', { kind: 'hold', reason: 'no_free_member' }],
    ]);
  });

  it('reserves each developer once and holds the others for a free member', () => {
    const cards = [card(1), card(2)];
    expect([...planStarts({ ...base, cards }).values()]).toEqual([
      { kind: 'offer', developer: 'dev' },
      { kind: 'hold', reason: 'no_free_member' },
    ]);
    expect(planStarts({ ...base, cards, free: [] }).get('AC-1')).toEqual({
      kind: 'hold',
      reason: 'no_free_member',
    });
    expect(base.free).toEqual([dev]);
  });

  it('offers an assigned card to its assignee only, and leaves it out while they are not free', () => {
    const cards = [card(1, { assignee: 'big', priority: 'urgent' }), card(2)];
    const plan = planStarts({ ...base, cards, free: [dev, big] });
    expect(plan.get('AC-1')).toEqual({ kind: 'offer', developer: 'big' });
    expect(plan.get('AC-2')).toEqual({ kind: 'offer', developer: 'dev' });
    expect(planStarts({ ...base, cards, free: [dev] }).has('AC-1')).toBe(false);
    // The assignee is reserved before a card that comes earlier in the start order.
    const reserved = planStarts({
      ...base,
      cards: [card(3, { priority: 'urgent' }), card(4, { assignee: 'dev' })],
    });
    expect(reserved.get('AC-4')).toEqual({ kind: 'offer', developer: 'dev' });
    expect(reserved.get('AC-3')).toMatchObject({ kind: 'hold' });
  });

  it('only gives a scored card to a developer whose limit reaches it unless an any decision allows another', () => {
    const cards = [card(1, scored(8))];
    expect(planStarts({ ...base, cards }).get('AC-1')).toEqual({
      kind: 'hold',
      reason: 'senior_busy',
      seniors: ['big'],
    });
    expect(planStarts({ ...base, cards, free: [dev, big] }).get('AC-1')).toEqual({
      kind: 'offer',
      developer: 'big',
    });
    expect(planStarts({ ...base, cards, anyDecided: new Set(['AC-1']) }).get('AC-1')).toEqual({
      kind: 'offer',
      developer: 'dev',
    });
    expect(
      planStarts({ ...base, cards, developers: [], free: [{ ...dev, temp: true }] }).get('AC-1'),
    ).toEqual({ kind: 'hold', reason: 'no_free_member' });
  });

  it('offers a replaceable assigned card to another free developer and never pulls it (PM-1051)', () => {
    const urgent = card(1, { assignee: 'away', priority: 'urgent' });
    const plain = card(2, { assignee: 'away' });
    // The assignee is not free (their provider is on hold): without the replacement the card gets no entry.
    expect(planStarts({ ...base, cards: [plain], free: [big] }).has('AC-2')).toBe(false);
    const plan = planStarts({
      ...base,
      cards: [urgent, plain],
      free: [dev, big],
      reassignableTaskKeys: new Set(['AC-1', 'AC-2']),
    });
    expect(plan.get('AC-1')).toEqual({ kind: 'offer', developer: 'dev' });
    expect(plan.get('AC-2')).toEqual({ kind: 'offer', developer: 'big' });
  });

  it('keeps the developer of an assigned card that is not replaceable (PM-1051)', () => {
    const cards = [card(1, { assignee: 'dev' }), card(2, { assignee: 'away' })];
    const plan = planStarts({ ...base, cards, free: [dev, big], reassignableTaskKeys: new Set(['AC-2']) });
    expect(plan.get('AC-1')).toEqual({ kind: 'offer', developer: 'dev' });
    expect(plan.get('AC-2')).toEqual({ kind: 'offer', developer: 'big' });
  });

  it('holds a replaceable card for a Senior or a free member instead of choosing a smaller developer (PM-1051)', () => {
    const cards = [card(1, { assignee: 'away', ...scored(8) })];
    expect(planStarts({ ...base, cards, reassignableTaskKeys: new Set(['AC-1']) }).get('AC-1')).toEqual({
      kind: 'hold',
      reason: 'senior_busy',
      seniors: ['big'],
    });
  });

  it('lets offered cards choose before urgent pull candidates', () => {
    const cards = [card(1, { priority: 'urgent' }), card(2), card(3)];
    const plan = planStarts({ ...base, cards, offered: new Set(['AC-3']) });
    expect([...plan.keys()]).toEqual(['AC-3', 'AC-1', 'AC-2']);
    expect(plan.get('AC-3')).toEqual({ kind: 'offer', developer: 'dev' });
    const pulls = planStarts({ ...base, cards: cards.slice(0, 2), free: [dev, big] });
    expect([...pulls.values()].map((entry) => entry.kind)).toEqual(['pull', 'offer']);
  });
});
