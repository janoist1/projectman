import { describe, expect, test } from 'vitest';
import { cardStepOutcome, cardSteps, visibleCardStepsInput } from './card-step';
import type { InboxItem } from './inbox';
import type { MemberQueueItem } from './member-queue';
import type { Obligation } from './obligation';

const obligation = (patch: Partial<Obligation> = {}): Obligation => ({
  id: 'obl_1',
  projectKey: 'PM',
  taskKey: 'PM-1',
  kind: 'merge',
  responsible: 'lead',
  subject: 'mrg_1',
  openedAt: '2026-10-01T10:00:00.000Z',
  dueAt: '2026-10-01T10:30:00.000Z',
  pausedSince: null,
  pauseReason: null,
  wokenAt: null,
  pmToldAt: null,
  handedOverAt: null,
  inboxItemId: null,
  state: 'open',
  closedAt: null,
  ...patch,
});

const queueItem = (patch: Partial<MemberQueueItem> = {}): MemberQueueItem => ({
  id: 'mqi_1',
  projectKey: 'PM',
  member: 'dev',
  kind: 'todo',
  source: { type: 'inbox', inboxItemId: 'inb_9' },
  place: { type: 'task', taskKey: 'PM-1' },
  wake: true,
  state: 'queued',
  title: 'A private message text',
  from: 'owner',
  taskKey: 'PM-1',
  queuedAt: '2026-10-01T11:00:00.000Z',
  startedAt: null,
  closedAt: null,
  closeReason: null,
  attempts: 0,
  restartedAt: null,
  sessionId: null,
  wait: null,
  outcome: null,
  ...patch,
});

const inboxItem = (patch: Partial<InboxItem> = {}): InboxItem => ({
  id: 'inb_1',
  projectKey: 'PM',
  kind: 'question',
  assignees: ['owner', 'ist'],
  source: 'dev',
  sessionId: null,
  taskKey: 'PM-1',
  title: 'A question',
  body: null,
  payload: {},
  options: [],
  state: 'open',
  resolution: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  ...patch,
});

const none = { obligations: [], queueItems: [], startWaiting: null, openItems: [] };

describe('cardSteps', () => {
  test('maps an obligation by whether it was reminded or handed over', () => {
    const steps = cardSteps({
      ...none,
      obligations: [
        obligation({ id: 'a' }),
        obligation({ id: 'b', wokenAt: '2026-10-01T10:31:00.000Z' }),
        obligation({ id: 'c', state: 'handed_over', handedOverAt: '2026-10-01T11:00:00.000Z' }),
        obligation({ id: 'd', state: 'fulfilled' }),
      ],
    });
    expect(steps.map((step) => [step.ref, step.state])).toEqual([
      ['c', 'handed_over'],
      ['b', 'reminded'],
      ['a', 'waiting'],
    ]);
  });

  test('carries the pause reason of an obligation as its wait code', () => {
    const [step] = cardSteps({
      ...none,
      obligations: [obligation({ pauseReason: 'inbox', pausedSince: 'x' })],
    });
    expect(step).toMatchObject({ source: 'obligation', waitCode: 'inbox', holder: 'lead' });
  });

  test('maps a queue item without its text, and counts the attempt from one', () => {
    const steps = cardSteps({
      ...none,
      queueItems: [
        queueItem({ wait: { code: 'member_at_capacity', at: 'x' }, attempts: 1 }),
        queueItem({ id: 'mqi_2', state: 'processing', startedAt: '2026-10-01T12:00:00.000Z' }),
        queueItem({ id: 'mqi_3', state: 'done' }),
      ],
    });
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ ref: 'mqi_2', state: 'running', since: '2026-10-01T12:00:00.000Z' });
    expect(steps[1]).toMatchObject({ source: 'queue', waitCode: 'member_at_capacity', attempts: 2 });
    expect(JSON.stringify(steps)).not.toContain('private');
  });

  test('turns a waiting start into a system step', () => {
    const [step] = cardSteps({
      ...none,
      startWaiting: { reason: 'ai_limit_reached', since: '2026-10-01T08:00:00.000Z' },
    });
    expect(step).toMatchObject({ source: 'start', holder: null, waitCode: 'ai_limit_reached' });
  });

  test('names the viewer as the holder of an item assigned to them, else the first assignee', () => {
    const open = { ...none, openItems: [inboxItem()] };
    expect(cardSteps({ ...open, viewer: 'ist' })[0]?.holder).toBe('ist');
    expect(cardSteps(open)[0]?.holder).toBe('owner');
  });

  test('leaves out the todo of a handed-over obligation and informational items', () => {
    const steps = cardSteps({
      ...none,
      obligations: [obligation({ state: 'handed_over', inboxItemId: 'inb_1' })],
      openItems: [inboxItem(), inboxItem({ id: 'inb_2', state: 'resolved' })],
    });
    expect(steps.map((step) => step.source)).toEqual(['obligation']);
  });

  test('orders by state, then the oldest first', () => {
    const steps = cardSteps({
      ...none,
      obligations: [obligation({ id: 'late', openedAt: '2026-10-01T12:00:00.000Z' })],
      queueItems: [queueItem({ queuedAt: '2026-10-01T07:00:00.000Z' })],
      openItems: [inboxItem()],
    });
    expect(steps.map((step) => step.source)).toEqual(['queue', 'inbox', 'obligation']);
  });
});

describe('visibleCardStepsInput', () => {
  const input = {
    ...none,
    queueItems: [
      queueItem({ id: 'mqi_m', kind: 'message', member: 'dev', from: 'lead' }),
      queueItem({ id: 'mqi_t' }),
    ],
    openItems: [inboxItem(), inboxItem({ id: 'inb_todo', payload: { recipient: 'integrator' } })],
  };

  test('hides a message item from a member who is no party to it, and an integrator todo from a non-owner', () => {
    const seen = visibleCardStepsInput({ access: 'developer', handle: 'qa' }, input);
    expect(seen.queueItems.map((item) => item.id)).toEqual(['mqi_t']);
    expect(seen.openItems.map((item) => item.id)).toEqual(['inb_1']);
  });

  test('shows a message item to its party and everything to an owner', () => {
    expect(visibleCardStepsInput({ access: 'developer', handle: 'dev' }, input).queueItems).toHaveLength(2);
    expect(visibleCardStepsInput({ access: 'owner', handle: 'owner' }, input).openItems).toHaveLength(2);
  });
});

describe('cardStepOutcome', () => {
  const event = (type: string, data: Record<string, unknown> = {}) =>
    cardStepOutcome({ type, data } as Parameters<typeof cardStepOutcome>[0]);

  test.each([
    ['task_full_test', { outcome: 'passed' }, 'ran'],
    ['task_full_test', { outcome: 'error' }, 'failed'],
    ['task_merge_blocked', {}, 'failed'],
    ['obligation_handed_over', {}, 'handed_over'],
    ['question_screened', { outcome: 'forwarded' }, 'handed_over'],
    ['member_queue_item_closed', { reason: 'attempts_exhausted' }, 'failed'],
    ['member_queue_item_closed', { reason: 'stale' }, null],
  ])('%s %j ends as %s', (type, data, outcome) => {
    expect(event(type, data)).toBe(outcome);
  });

  test('an event type that is no step has no outcome', () => {
    expect(event('task_note')).toBeNull();
  });
});
