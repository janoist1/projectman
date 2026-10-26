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
const base = { places: new Map(), free: [dev], developers, anyDecided: new Set<string>() };
const scored = (points: 8): Partial<Task> => ({
  complexity: { points, reason: 'Runner', setBy: 'owner', setAt: '2026-10-18T10:00:00Z' },
});

describe('start plan', () => {
  it('orders urgent, focus by position, priority, then board order', () => {
    const places = new Map([
      ['AC-8', { position: 1 }],
      ['AC-7', { position: 2 }],
    ]);
    const cards = [
      card(1),
      card(2, { priority: 'low' }),
      card(3, { priority: 'normal' }),
      card(4, { priority: 'high', boardRank: 2 }),
      card(5, { priority: 'high', boardRank: 1 }),
      card(7),
      card(8),
      card(9, { priority: 'urgent' }),
    ];
    expect(cards.sort((a, b) => compareStartOrder(a, b, places)).map((c) => c.key)).toEqual([
      'AC-9',
      'AC-8',
      'AC-7',
      'AC-5',
      'AC-4',
      'AC-3',
      'AC-2',
      'AC-1',
    ]);
  });

  it('reserves each developer once and distinguishes order from unavailable capacity', () => {
    const cards = [card(1), card(2)];
    expect([...planStarts({ ...base, cards }).values()]).toEqual([
      { kind: 'offer', developer: 'dev' },
      { kind: 'hold', reason: 'focus_order' },
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

  it('lets offered cards choose before urgent and focus pull candidates', () => {
    const cards = [card(1, { priority: 'urgent' }), card(2), card(3)];
    const places = new Map([['AC-2', { position: 1 }]]);
    const plan = planStarts({ ...base, cards, places, offered: new Set(['AC-3']) });
    expect([...plan.keys()]).toEqual(['AC-3', 'AC-1', 'AC-2']);
    expect(plan.get('AC-3')).toEqual({ kind: 'offer', developer: 'dev' });
    const pulls = planStarts({ ...base, cards: cards.slice(0, 2), places, free: [dev, big] });
    expect([...pulls.values()].map((entry) => entry.kind)).toEqual(['pull', 'pull']);
  });
});
