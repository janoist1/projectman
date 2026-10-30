import { describe, expect, it } from 'vitest';
import type { InboxItem } from './inbox';
import { ownerQuestionRoute, ownerQuestionsSince, weeklyOwnerQuestions } from './owner-questions';

const UNTIL = '2026-10-30T10:10:00.000Z';
const todo = (recipient: 'owner' | 'integrator') => ({
  what: 'Do',
  where: 'Here',
  expected: 'Done',
  recipient,
});

function question(overrides: Partial<InboxItem> = {}, payload: Record<string, unknown> = {}): InboxItem {
  return {
    id: 'inb_1',
    projectKey: 'PM',
    kind: 'question',
    assignees: ['owner'],
    source: 'dev',
    sessionId: null,
    taskKey: null,
    title: 'Which way?',
    body: null,
    payload: { question: 'Which way?', recipient: 'owner', ...payload },
    options: [],
    state: 'open',
    resolution: null,
    createdAt: '2026-10-30T10:00:00.000Z',
    ...overrides,
  };
}

describe('ownerQuestionRoute', () => {
  it.each([
    ['decision', {}, { screening: { until: UNTIL, outcome: 'decision' } }],
    ['owner_todo', {}, { screening: { until: UNTIL, outcome: 'todo', todo: todo('owner') } }],
    [
      'integrator_fallback',
      {},
      {
        screening: {
          until: UNTIL,
          outcome: 'todo',
          todo: todo('owner'),
          recipientRefusal: 'integrator_unavailable',
        },
      },
    ],
    [
      'integrator_escalated',
      {},
      {
        integratorOpenedAt: '2026-10-30T10:05:00.000Z',
        integratorEscalatedAt: '2026-10-30T11:00:00.000Z',
        screening: { until: UNTIL, outcome: 'todo', todo: todo('integrator') },
      },
    ],
    ['screening_fallback', {}, { screening: { until: UNTIL, fallback: 'timeout' } }],
    ['project_manager', { source: 'pm' }, {}],
    ['reask', {}, { unscreened: { reason: 'No answer', previousItemId: 'inb_0' } }],
    ['unscreened', {}, {}],
  ] as const)('names the %s way', (route, overrides, payload) => {
    expect(ownerQuestionRoute(question(overrides, payload), 'pm')).toBe(route);
  });

  it.each([
    ['settled by the screening', {}, { screening: { until: UNTIL, outcome: 'answered' } }],
    [
      'forwarded to the technical decider',
      {},
      { screening: { until: UNTIL, outcome: 'todo', todo: todo('integrator'), forwardedTo: 'architect' } },
    ],
    [
      'with the integrator',
      {},
      {
        recipient: 'integrator',
        integratorOpenedAt: '2026-10-30T10:05:00.000Z',
        screening: { until: UNTIL, outcome: 'todo', todo: todo('integrator') },
      },
    ],
    ['still in screening', { state: 'screening' as const }, { screening: { until: UNTIL } }],
    ['not a question', { kind: 'approval' as const }, {}],
  ])('is null for a question %s', (_case, overrides, payload) => {
    expect(ownerQuestionRoute(question(overrides, payload), 'pm')).toBeNull();
  });
});

describe('weeklyOwnerQuestions', () => {
  // Friday of ISO week 44; Europe/Budapest left summer time on Sunday 25 October.
  const now = new Date('2026-10-30T12:00:00.000Z');
  const report = (items: InboxItem[], weeks = 8) =>
    weeklyOwnerQuestions(items, { timezone: 'Europe/Budapest', now, weeks, coordinatorHandle: 'pm' });

  it('lists the weeks newest first, Monday to Sunday, the empty ones too', () => {
    const { timezone, weeks } = report([]);
    expect(timezone).toBe('Europe/Budapest');
    expect(weeks).toHaveLength(8);
    expect(weeks[0]).toMatchObject({ weekStart: '2026-10-26', weekEnd: '2026-11-01', isoWeek: 44, total: 0 });
    expect(weeks[7]).toMatchObject({ weekStart: '2026-09-07', isoWeek: 37 });
    expect(Object.values(weeks[0]!.byRoute)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('cuts the weeks at Monday midnight in the project time zone', () => {
    // 23:30 UTC on Sunday is 00:30 on Monday in Budapest.
    const { weeks } = report([question({ createdAt: '2026-10-25T23:30:00.000Z' })]);
    expect([weeks[0]!.total, weeks[1]!.total]).toEqual([1, 0]);
  });

  it('counts a question in the week of its screening, else of its asking', () => {
    const screenedLater = question(
      { createdAt: '2026-10-25T21:00:00.000Z' },
      { screening: { until: UNTIL, outcome: 'decision', at: '2026-10-26T08:00:00.000Z' } },
    );
    const asked = question({ createdAt: '2026-10-21T08:00:00.000Z' });
    const { weeks } = report([screenedLater, asked]);
    expect([weeks[0]!.total, weeks[1]!.total]).toEqual([1, 1]);
  });

  it('breaks the total down by way and topic, an old question without a topic as unknown', () => {
    const decided = question({}, { screening: { until: UNTIL, outcome: 'decision' }, ownerTopic: 'cost' });
    const old = question({ createdAt: '2026-10-27T08:00:00.000Z' });
    const week = report([decided, old]).weeks[0]!;
    expect(week.total).toBe(2);
    expect(week.byRoute).toMatchObject({ decision: 1, unscreened: 1, owner_todo: 0 });
    expect(week.byTopic).toEqual({ cost: 1, unknown: 1 });
  });

  it('counts the answers by the owner and through the integrator apart, and the open ones', () => {
    const answer = (via?: 'integrator') => ({
      state: 'resolved' as const,
      resolution: { optionId: 'option_1', by: 'owner', at: UNTIL, note: null, ...(via ? { via } : {}) },
    });
    const withdrawn = {
      state: 'cancelled' as const,
      resolution: { optionId: 'withdrawn', by: 'system', at: UNTIL, note: null, rule: 'withdrawn' as const },
    };
    const week = report([question(answer()), question(answer('integrator')), question(), question(withdrawn)])
      .weeks[0]!;
    expect(week).toMatchObject({ total: 4, answeredByOwner: 1, answeredByIntegrator: 1, open: 1 });
  });

  it('counts the integrator todos apart from the questions that reached the owners', () => {
    const withIntegrator = question(
      {},
      {
        recipient: 'integrator',
        integratorOpenedAt: '2026-10-30T10:05:00.000Z',
        screening: {
          until: UNTIL,
          outcome: 'todo',
          todo: todo('integrator'),
          at: '2026-10-30T10:05:00.000Z',
        },
      },
    );
    const week = report([withIntegrator]).weeks[0]!;
    expect(week).toMatchObject({ total: 0, integratorTodos: 1 });
  });

  it('leaves out what falls outside the weeks', () => {
    const { weeks } = report([question({ createdAt: '2026-10-11T08:00:00.000Z' })], 2);
    expect(weeks.map((week) => week.total)).toEqual([0, 0]);
  });

  it('falls back to UTC for a time zone that does not exist', () => {
    expect(
      weeklyOwnerQuestions([], { timezone: 'Mars/Base', now, weeks: 1, coordinatorHandle: null }).timezone,
    ).toBe('UTC');
  });
});

describe('ownerQuestionsSince', () => {
  it('starts a day before the oldest Monday', () => {
    const since = ownerQuestionsSince({
      timezone: 'Europe/Budapest',
      now: new Date('2026-10-30T12:00:00Z'),
      weeks: 8,
    });
    expect(since).toBe('2026-09-06T00:00:00.000Z');
  });
});
