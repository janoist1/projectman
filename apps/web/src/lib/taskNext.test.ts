import type { Task, TaskWait } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { tasks } from '../mocks/fixtures';
import { mockIndexes } from '../test/render';
import { deriveNext } from './taskNext';
import type { TaskNextContext } from './taskNext';

const { pipeline, members } = mockIndexes();
const task: Task = { ...tasks.find((entry) => entry.key === 'AC-24')!, stageId: 'dev' };

const ctx = (patch: Partial<TaskNextContext> = {}): TaskNextContext => ({
  members,
  pipeline,
  labels: [],
  myHandle: 'owner',
  item: null,
  startText: null,
  startHint: null,
  ...patch,
});

const wait = (patch: Partial<TaskWait> & Pick<TaskWait, 'reason'>): TaskWait => ({
  next: [],
  toStageId: null,
  labels: [],
  inboxItemId: null,
  inboxKind: null,
  startWaiting: null,
  prerequisites: [],
  since: '2026-10-01T10:00:00.000Z',
  ...patch,
});

const human = (handle: string) => ({ handle, kind: 'human' as const });
const ai = (handle: string) => ({ handle, kind: 'ai' as const });

describe('deriveNext: the card row of "Miért áll?" (PM-461)', () => {
  it.each(['working', 'handing_off', 'ready'] as const)("keeps today's line for %s", (reason) => {
    expect(deriveNext(task, wait({ reason }), ctx())).toBeNull();
  });

  it('says "Rád vár" for the viewer and names the other member otherwise', () => {
    const mine = deriveNext(
      task,
      wait({ reason: 'inbox', inboxKind: 'decision', next: [human('owner')] }),
      ctx(),
    )!;
    expect(mine).toMatchObject({ head: 'Rád vár', you: true, tone: 'needs' });
    expect(mine.line.startsWith('Rád vár · ')).toBe(true);
    const theirs = deriveNext(
      task,
      wait({ reason: 'inbox', inboxKind: 'decision', next: [human('kata')] }),
      ctx(),
    )!;
    expect(theirs).toMatchObject({ you: false, tone: 'neutral', waiting: 'dönt' });
    expect(theirs.head).not.toBe('Rád vár');
    expect(theirs.who).toEqual([{ handle: 'kata', kind: 'human', you: false }]);
  });

  it('puts the answer, the title and the accessible name in one text: who, what, what to do', () => {
    const next = deriveNext(task, wait({ reason: 'blocked' }), ctx())!;
    expect(next.title).toBe(`Ki: ${next.head} · Mire vár: ${next.waiting} · Teendő: ${next.todo}`);
  });

  it('counts the people beyond the second', () => {
    const next = deriveNext(
      task,
      wait({ reason: 'assignee', next: [ai('fe-1'), ai('be-1'), ai('dev-1')] }),
      ctx(),
    )!;
    expect(next.head).toContain('+1');
  });

  // One text per reason: the internal code of the reason never reaches the row.
  const reasons: [
    TaskWait['reason'],
    Partial<TaskWait>,
    Partial<TaskNextContext>,
    Record<string, unknown>,
  ][] = [
    [
      'start_waiting',
      {
        next: [ai('be-1')],
        startWaiting: { reason: 'member_at_capacity', member: 'be-1', since: '2026-10-01T10:00:00.000Z' },
      },
      {},
      { waiting: 'mással foglalkozik, utána sorra kerül', todo: t('taskStatus.next.todo.auto') },
    ],
    [
      'start_waiting',
      { startWaiting: { reason: 'ai_disabled', since: '2026-10-01T10:00:00.000Z' } },
      { startText: 'AI off', startHint: 'Turn it on' },
      { head: 'Indulásra vár', waiting: 'az AI-munka ki van kapcsolva', long: 'AI off', todo: 'Turn it on' },
    ],
    [
      'start_waiting',
      { startWaiting: { reason: 'no_free_member', since: '2026-10-01T10:00:00.000Z' } },
      { startHint: 'Free a member' },
      { head: 'Szabad fejlesztőre vár', waiting: 'mindenki mással foglalkozik' },
    ],
    [
      'start_waiting',
      { startWaiting: { reason: 'full_test_pending', since: '2026-10-01T10:00:00.000Z' } },
      {},
      { head: 'Teljes teszt', waiting: 'fut, utána indul az átnézés' },
    ],
    [
      'prerequisite',
      { prerequisites: ['AC-17', 'AC-19', 'AC-20'] },
      {},
      { head: 'Előfeltételre vár', waiting: 'AC-17, AC-19 +1' },
    ],
    [
      'inbox',
      { inboxKind: 'permission', next: [human('kata')] },
      {},
      { waiting: 'engedélyt ad', you: false },
    ],
    [
      'inbox',
      { inboxKind: 'question', next: [human('owner')] },
      {},
      { head: 'Rád vár', waiting: 'kérdés', you: true },
    ],
    ['blocked', {}, {}, { head: 'Elakadt', waiting: 'az idővonalon áll, miért', tone: 'blocked' }],
    ['fix_limit', { next: [human('owner')] }, {}, { head: 'Rád vár', you: true }],
    ['held', { labels: ['waiting-answer'] }, {}, { head: 'Áll', tone: 'neutral' }],
    [
      'hand_on',
      { next: [human('kata')], toStageId: 'code_review' },
      {},
      { head: 'Kész a munka', waiting: 'Kata viszi tovább', toStageId: 'code_review' },
    ],
    [
      'hand_on',
      { next: [human('owner')], toStageId: 'code_review' },
      {},
      { head: 'Rád vár', waiting: 'kész a munka, vidd tovább', toStageId: 'code_review', you: true },
    ],
    [
      'approval',
      { next: [human('owner')], toStageId: 'code_review', labels: ['design-review-ok'] },
      {},
      { head: 'Rád vár', you: true, toStageId: 'code_review' },
    ],
    ['labels_missing', { next: [ai('qa')], labels: ['qa-ok'] }, {}, { you: false }],
    [
      'queued',
      { next: [human('kata')] },
      {},
      { waiting: 'továbbviszi innen: Fejlesztés', toStageId: 'code_review' },
    ],
    [
      'queued',
      { next: [human('owner')] },
      {},
      { head: 'Rád vár', waiting: 'vidd tovább innen: Fejlesztés', toStageId: 'code_review' },
    ],
    ['queued', { next: [ai('qa')] }, {}, { waiting: 'sorra veszi', toStageId: null }],
    ['queued', {}, {}, { head: 'Sorra kerül', waiting: 'Fejlesztés' }],
    ['assignee', { next: [ai('be-1')] }, {}, { waiting: 'sorra veszi' }],
    ['nobody', {}, {}, { head: 'Senki', waiting: 'nincs, aki továbbvinné', tone: 'blocked' }],
  ];
  it.each(reasons.map((row, index) => [`${row[0]} #${index}`, ...row] as const))(
    'has its own text for %s',
    (_name, reason, patch, context, expected) => {
      const next = deriveNext(task, wait({ reason, ...patch }), ctx(context));
      expect(next).not.toBeNull();
      expect(next).toMatchObject(expected);
      // Never the code of the reason or of the start wait.
      expect(next!.title).not.toMatch(/[a-z]+_[a-z_]+/);
    },
  );
});
