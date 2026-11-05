import { describe, expect, it } from 'vitest';
import { TODO_CANNOT_OPTION, TODO_DONE_OPTION } from './inbox';
import type { InboxItem } from './inbox';
import { screeningWaitingSince, waitingForOthers } from './waiting-for-others';

function item(overrides: Partial<InboxItem> = {}, payload: Record<string, unknown> = {}): InboxItem {
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

const waiting = (since: string, id = 'inb_w') =>
  item(
    { id, state: 'screening', createdAt: since },
    { screening: { until: '2026-10-30T12:00:00.000Z', waiting: { since, reason: 'paused' } } },
  );

const integratorTodo = (at: string, id = 'inb_t') =>
  item(
    {
      id,
      options: [TODO_DONE_OPTION, TODO_CANNOT_OPTION],
    },
    {
      recipient: 'integrator',
      integratorOpenedAt: at,
      screening: {
        until: at,
        outcome: 'todo',
        todo: { what: 'Do', where: 'Here', expected: 'Done', recipient: 'integrator' },
        at,
      },
    },
  );

describe('waitingForOthers', () => {
  it('counts the questions waiting for the screening and the open integrator todos, with the oldest time', () => {
    const result = waitingForOthers([
      waiting('2026-10-30T10:30:00.000Z', 'a'),
      waiting('2026-10-30T09:00:00.000Z', 'b'),
      integratorTodo('2026-10-30T08:00:00.000Z'),
      item({ id: 'plain' }),
    ]);

    expect(result).toEqual({
      screening: { count: 2, oldestAt: '2026-10-30T09:00:00.000Z' },
      integrator: { count: 1, oldestAt: '2026-10-30T08:00:00.000Z' },
    });
  });

  it('reports nothing waiting as zero counts without a time', () => {
    expect(waitingForOthers([item()])).toEqual({
      screening: { count: 0, oldestAt: null },
      integrator: { count: 0, oldestAt: null },
    });
  });

  it('does not count a screening question that is not waiting, nor a closed integrator todo', () => {
    const screened = item({ state: 'screening' }, { screening: { until: '2026-10-30T12:00:00.000Z' } });
    const closed = { ...integratorTodo('2026-10-30T08:00:00.000Z'), state: 'resolved' as const };

    const result = waitingForOthers([screened, closed]);

    expect(result.screening.count + result.integrator.count).toBe(0);
    expect(screeningWaitingSince(screened)).toBeNull();
  });
});
