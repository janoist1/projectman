import { describe, expect, it } from 'vitest';
import { ProjectConfig } from '../config/schema';
import {
  closedCardsSince,
  countCardRounds,
  isClosedSince,
  measureClosedCard,
  sortClosedCards,
  weightedTokensByModel,
  type ClosedCardMeasure,
} from './card-measure';
import type { TimelineEvent } from './event';
import type { TokenUsage } from './token-usage';

const config = ProjectConfig.parse({
  schemaVersion: 1,
  project: { key: 'EX', name: 'Example', workspacePath: '/tmp/example', repos: [] },
  team: {
    members: [
      { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
      { kind: 'ai', handle: 'builder', displayName: 'Builder', role: 'developer', sponsor: 'owner' },
      { kind: 'ai', handle: 'reviewer', displayName: 'Reviewer', role: 'code_review', sponsor: 'owner' },
    ],
    limits: {},
  },
  pipeline: {
    columns: [{ id: 'all', name: 'All' }],
    stages: [
      { id: 'queue', name: 'Ötletek', kind: 'queue', columnId: 'all' },
      { id: 'dev', name: 'Fejlesztés', kind: 'work', owners: ['builder'], columnId: 'all' },
      // A review step named after neither: only the duty (here the owner's) makes it a code review.
      { id: 'cr', name: 'Átnézés', kind: 'step', owners: ['reviewer'], columnId: 'all' },
      { id: 'test', name: 'Teszt', kind: 'step', duty: 'testing_acceptance', columnId: 'all' },
      { id: 'done', name: 'Kész', kind: 'done', columnId: 'all' },
    ],
    labels: [],
  },
});

const move = (from: string, to: string) => ({ type: 'task_stage_changed' as const, data: { from, to } });
const labels = (added: string[], removed: string[] = []) => ({
  type: 'task_labels_changed' as const,
  data: { added, removed },
});

const NO_ROUNDS = { reviewRounds: 0, changeRequests: 0, designChangeRequests: 0, sendBacks: 0 };

describe('countCardRounds (PM-222)', () => {
  it('counts two reviews, one change request and one send-back of a card', () => {
    const events: Pick<TimelineEvent, 'type' | 'data'>[] = [
      { type: 'task_created', data: { title: 'x' } },
      move('queue', 'dev'),
      move('dev', 'cr'),
      labels(['code-review-changes']),
      move('cr', 'dev'),
      move('dev', 'cr'),
      labels(['code-review-ok']),
      move('cr', 'done'),
    ];
    expect(countCardRounds(events, config)).toEqual({
      reviewRounds: 2,
      changeRequests: 1,
      designChangeRequests: 0,
      sendBacks: 1,
    });
  });

  it('counts a send-back from any later stage, by hand or after the merge, and not the first start', () => {
    const events = [move('queue', 'dev'), move('test', 'dev'), move('done', 'dev'), move('dev', 'test')];
    expect(countCardRounds(events, config)).toEqual({ ...NO_ROUNDS, sendBacks: 2 });
  });

  it('goes by the stage kind and duty, not the stage name, and skips stages the pipeline no longer has', () => {
    const events = [move('dev', 'test'), move('dev', 'gone'), move('gone', 'dev'), move('dev', 'cr')];
    expect(countCardRounds(events, config)).toEqual({ ...NO_ROUNDS, reviewRounds: 1 });
  });

  it('counts only the change-request label, whatever else is added or removed', () => {
    const events = [
      labels(['code-review-ok', 'code-review-changes']),
      labels([], ['code-review-changes']),
      labels(['qa-ok']),
    ];
    expect(countCardRounds(events, config).changeRequests).toBe(1);
    expect(countCardRounds([], config)).toEqual(NO_ROUNDS);
  });

  it('counts the change-request label of the UI/UX review apart (PM-262)', () => {
    const events = [labels(['design-review-changes']), labels(['code-review-changes', 'design-review-ok'])];
    expect(countCardRounds(events, config)).toEqual({
      ...NO_ROUNDS,
      changeRequests: 1,
      designChangeRequests: 1,
    });
  });

  it('survives events of an old or odd shape', () => {
    const events = [
      { type: 'task_stage_changed' as const, data: {} },
      { type: 'task_labels_changed' as const, data: {} },
    ];
    expect(countCardRounds(events, config)).toEqual(NO_ROUNDS);
  });
});

describe('weightedTokensByModel (PM-222)', () => {
  const row = (model: string, scope: TokenUsage['scope'], cacheRead: number, input = 0): TokenUsage => ({
    model,
    scope,
    input,
    output: 0,
    cacheRead,
    cacheWrite: 0,
  });

  it('weights the cache reads by a tenth, adds the subagents and sorts the largest model first', () => {
    expect(
      weightedTokensByModel([
        row('haiku', 'subagent', 1000),
        row('opus', 'main', 1000, 50),
        row('haiku', 'main', 0, 20),
        row('opus', 'subagent', 0, 10),
      ]),
    ).toEqual([
      { model: 'opus', tokens: 160 },
      { model: 'haiku', tokens: 120 },
    ]);
  });
});

describe('measureClosedCard (PM-222)', () => {
  const rounds = { reviewRounds: 2, changeRequests: 1, designChangeRequests: 0, sendBacks: 1 };
  const row = (model: string, scope: TokenUsage['scope'], input: number): TokenUsage => ({
    model,
    scope,
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  const done = { key: 'EX-1', title: 'Login', closedAt: '2026-10-01T10:00:00Z' } as const;
  const session = (member: string, rows?: TokenUsage[]) => ({
    member,
    usage: rows && { since: '2026-09-30T00:00:00Z', rows },
  });

  it("takes the models from the implementer's own usage rows, the tokens from all sessions", () => {
    const card = measureClosedCard(
      { ...done, assignee: 'builder' },
      [
        session('builder', [
          row('opus', 'main', 100),
          row('sonnet', 'main', 300),
          row('haiku', 'subagent', 50),
        ]),
        session('reviewer', [row('sonnet', 'main', 10)]),
        session('builder'),
      ],
      rounds,
    );
    expect(card).toMatchObject({
      taskKey: 'EX-1',
      implementer: 'builder',
      // The subagent's model is not the implementer's; the larger user comes first.
      implementerModels: ['sonnet', 'opus'],
      tokens: 460,
      byModel: [
        { model: 'sonnet', tokens: 310 },
        { model: 'opus', tokens: 100 },
        { model: 'haiku', tokens: 50 },
      ],
      rounds,
      unmeasuredSessions: 1,
    });
  });

  it('names the member that used the most when the card has no assignee, and nobody without usage', () => {
    const sessions = [session('a', [row('opus', 'main', 5)]), session('b', [row('opus', 'main', 50)])];
    expect(measureClosedCard({ ...done, assignee: null }, sessions, rounds).implementer).toBe('b');
    expect(measureClosedCard({ ...done, assignee: null }, [session('a')], rounds)).toMatchObject({
      implementer: null,
      implementerModels: [],
      tokens: 0,
      byModel: [],
      unmeasuredSessions: 1,
    });
  });

  it('counts a card as closed when it is done at or after the start of the period, not when cancelled', () => {
    const since = closedCardsSince(new Date('2026-10-15T08:00:00.000Z'), 14);
    expect(since).toBe('2026-10-01T08:00:00.000Z');
    expect(isClosedSince({ status: 'done', closedAt: since }, since)).toBe(true);
    expect(isClosedSince({ status: 'done', closedAt: '2026-10-01T07:59:59.000Z' }, since)).toBe(false);
    expect(isClosedSince({ status: 'cancelled', closedAt: '2026-10-10T00:00:00.000Z' }, since)).toBe(false);
    expect(isClosedSince({ status: 'active', closedAt: null }, since)).toBe(false);
  });
});

describe('sortClosedCards (PM-222)', () => {
  const card = (
    taskKey: string,
    tokens: number,
    reviewRounds: number,
    closedAt: string,
  ): ClosedCardMeasure => ({
    taskKey,
    title: taskKey,
    closedAt,
    implementer: null,
    implementerModels: [],
    tokens,
    byModel: [],
    rounds: { ...NO_ROUNDS, reviewRounds },
    unmeasuredSessions: 0,
  });
  const cards = [
    card('EX-1', 10, 1, '2026-10-01T10:00:00Z'),
    card('EX-2', 30, 1, '2026-10-02T10:00:00Z'),
    card('EX-3', 20, 3, '2026-10-01T12:00:00Z'),
  ];

  it('sorts by weighted tokens or by review rounds, the largest first, ties by the latest close', () => {
    expect(sortClosedCards(cards, 'tokens').map((c) => c.taskKey)).toEqual(['EX-2', 'EX-3', 'EX-1']);
    expect(sortClosedCards(cards, 'reviewRounds').map((c) => c.taskKey)).toEqual(['EX-3', 'EX-2', 'EX-1']);
    expect(sortClosedCards(cards, 'closedAt').map((c) => c.taskKey)).toEqual(['EX-2', 'EX-3', 'EX-1']);
  });
});
