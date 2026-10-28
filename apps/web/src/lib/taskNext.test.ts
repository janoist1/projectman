import type { Task, TaskWait } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { tasks, plainLanguageQuestion } from '../mocks/fixtures';
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
  it.each([
    {
      operatorHandoff: {
        queueItemId: 'queue',
        reason: 'no_grant',
        action: 'Complete work',
        detail: null,
        operationId: null,
      },
    },
    {
      superOperation: {
        operationId: 'command',
        commandHash: 'hash',
        expectedConfigVersion: null,
        expiresAt: '2026-10-22T12:00:00.000Z',
      },
    },
  ])('attributes an Operator request to the Operator in task status', (payload) => {
    const item = plainLanguageQuestion({
      source: 'system',
      payload: { question: 'Complete work', ...payload },
    });
    const next = deriveNext(
      task,
      wait({ reason: 'inbox', inboxKind: 'question', next: [human('owner')] }),
      ctx({ item }),
    )!;
    expect(next.waiting).toBe(t('taskStatus.next.short.inboxYou.question', { asker: t('superMode.name') }));
  });
  it.each([{ nextActors: [] }, { nextActors: [human('owner')] }])(
    'names the integrator with current or legacy next actors $nextActors',
    ({ nextActors }) => {
      const held: Task = {
        ...task,
        fixLimit: {
          phase: 'owner',
          recipient: 'integrator',
          rounds: 6,
          limit: 6,
          changeRequests: 6,
          designChangeRequests: 0,
          sendBacks: 0,
          decider: null,
          deciders: ['owner'],
          reason: 'extra_exhausted',
          heldAt: '2026-10-18T12:00:00Z',
        },
      };
      const next = deriveNext(held, wait({ reason: 'fix_limit', next: nextActors }), ctx())!;
      expect(next).toMatchObject({
        head: t('involvement.integrator'),
        you: false,
        who: [],
        noWho: t('involvement.integrator'),
        tone: 'neutral',
      });
      expect(next.todo).toBe(t('taskStatus.next.todo.fixLimitOther', { who: t('involvement.integrator') }));
      expect(next.line).not.toContain(t('taskStatus.next.you'));
    },
  );
  it.each([
    'ai_disabled',
    'team_paused',
    'ai_limit_reached',
    'engine_offline',
    'no_free_member',
    'senior_busy',
    'focus_order',
  ] as const)('shows the intentional ready wait %s', (reason) => {
    const next = deriveNext(
      task,
      wait({ reason: 'ready', hold: { reason, since: '2026-10-18T10:00:00Z' } }),
      ctx(),
    )!;
    expect(next.waiting).toBe(t(`taskStatus.next.readyHolds.${reason}`));
    expect(next.long).toBe(t('taskStatus.next.long.readyHold'));
    expect(next.todo).toBe(t('taskStatus.next.todo.auto'));
    expect(deriveNext(task, wait({ reason: 'ready' }), ctx())).toBeNull();
  });
  it('shows the member asked to start a startable card (PM-804)', () => {
    const next = deriveNext(task, wait({ reason: 'ready', next: [ai('pm')], toStageId: 'dev' }), ctx())!;
    expect(next.waiting).toBe(t('taskStatus.next.short.startOffer'));
    expect(next.long).toBe(t('taskStatus.next.long.startOffer'));
    expect(next.todo).toBe(t('taskStatus.next.todo.startOffer'));
    expect(next.who.map((actor) => actor.handle)).toEqual(['pm']);
    expect(next.you).toBe(false);
    const mine = deriveNext(
      task,
      wait({ reason: 'ready', next: [human('owner')], toStageId: 'dev' }),
      ctx({ myHandle: 'owner' }),
    )!;
    expect(mine.you).toBe(true);
  });
  it('asks the selected human merger to merge the approved work before advancing', () => {
    const next = deriveNext(
      task,
      wait({ reason: 'merge', next: [human('owner')], toStageId: 'done', inboxKind: 'merge_request' }),
      ctx(),
    )!;
    expect(next).toMatchObject({
      head: 'Rád vár',
      you: true,
      waiting: 'beolvasztás',
      long: 'A kártya jóváhagyott munkáját a fő ágba kell beolvasztani.',
      todo: 'Olvaszd be a kártya jóváhagyott munkáját a fő ágba.',
      who: [{ handle: 'owner', kind: 'human', you: true }],
      toStageId: 'done',
      tone: 'needs',
    });
    expect(next.line).toBe('Rád vár · beolvasztás');
  });

  it('names an AI merger without asking another viewer to merge the card', () => {
    const next = deriveNext(task, wait({ reason: 'merge', next: [ai('be-1')], toStageId: 'done' }), ctx())!;
    expect(next.you).toBe(false);
    expect(next.waiting).toBe('beolvasztásra vár');
    expect(next.who).toEqual([{ handle: 'be-1', kind: 'ai', you: false }]);
    expect(next.todo).toBe(t('taskStatus.next.todo.merge', { merger: next.head }));
    expect(next.toStageId).toBe('done');
  });

  it('keeps hand-on labels and adds the merge action using the same wording pattern', () => {
    expect(t('inbox.kinds.hand_on')).toBe('Vidd tovább');
    expect(t('inbox.kindsLower.hand_on')).toBe('továbbvitel');
    expect(t('inbox.kinds.merge_request')).toBe('Olvaszd be');
    expect(t('inbox.kindsLower.merge_request')).toBe('beolvasztás');
  });

  const withMerge = (
    merge: Partial<NonNullable<Task['merge']>> & Pick<NonNullable<Task['merge']>, 'state'>,
  ): Task => ({
    ...task,
    merge: {
      id: 'merge-1',
      repo: 'app',
      base: 'main',
      toStageId: 'done',
      merger: 'owner',
      requestedAt: '2026-10-01T10:00:00.000Z',
      landed: 'nowhere',
      ...merge,
    },
  });

  it.each(['queued', 'running'] as const)(
    'leaves a %s merge to the card state and never asks for a start',
    (state) => {
      for (const myHandle of ['owner', 'be-1'])
        expect(
          deriveNext(
            withMerge({ state }),
            wait({ reason: 'merge', next: [human('owner')], toStageId: 'done' }),
            ctx({ myHandle }),
          ),
        ).toBeNull();
    },
  );

  it('tells a failed merge to the merger as the conflict or the check, and to others as waiting', () => {
    const conflict = withMerge({
      state: 'failed',
      failure: { reason: 'conflict', at: '2026-10-01T10:00:00.000Z', base: 'abc1234', files: ['a.ts'] },
    });
    const check = withMerge({
      state: 'failed',
      failure: {
        reason: 'check_failed',
        at: '2026-10-01T10:00:00.000Z',
        base: 'abc1234',
        command: 'npm test',
      },
    });
    const w = wait({ reason: 'merge', next: [human('owner')], toStageId: 'done' });
    expect(deriveNext(conflict, w, ctx())).toMatchObject({ you: true, waiting: 'ütközés', tone: 'needs' });
    expect(deriveNext(check, w, ctx())).toMatchObject({
      you: true,
      waiting: 'elbukott az ellenőrzés',
      tone: 'needs',
    });
    expect(deriveNext(conflict, w, ctx({ myHandle: 'be-1' }))).toMatchObject({
      you: false,
      waiting: 'nem olvasztható be',
      tone: 'neutral',
    });
  });

  it('tells a blocked merge to the merger as a task and to others as blocked', () => {
    const blocked = withMerge({
      state: 'blocked',
      block: { reason: 'push_rejected', message: 'rejected', at: '2026-10-01T10:00:00.000Z' },
    });
    const w = wait({ reason: 'merge', next: [human('owner')], toStageId: 'done' });
    expect(deriveNext(blocked, w, ctx())).toMatchObject({
      you: true,
      waiting: 'beolvasztás elakadt',
      tone: 'needs',
    });
    expect(deriveNext(blocked, w, ctx({ myHandle: 'be-1' }))).toMatchObject({
      you: false,
      waiting: 'a beolvasztás elakadt',
      tone: 'blocked',
    });
  });

  it.each(['working', 'handing_off', 'ready'] as const)("keeps today's line for %s", (reason) => {
    expect(deriveNext(task, wait({ reason }), ctx())).toBeNull();
  });

  it('names the Senior role and an AI member for a capacity wait, and the busy member by name', () => {
    const senior = deriveNext(
      task,
      wait({
        reason: 'start_waiting',
        startWaiting: { reason: 'senior_busy', since: '2026-10-01T10:00:00.000Z' },
      }),
      ctx(),
    )!;
    expect(senior).toMatchObject({
      who: [],
      noWho: t('task.whyBox.nobodySenior'),
      noWhoKind: 'ai',
    });
    const member = deriveNext(
      task,
      wait({
        reason: 'start_waiting',
        next: [ai('be-1')],
        startWaiting: { reason: 'member_at_capacity', member: 'be-1', since: '2026-10-01T10:00:00.000Z' },
      }),
      ctx(),
    )!;
    expect(member.who).toEqual([{ handle: 'be-1', kind: 'ai', you: false }]);
    expect(member.noWho).toBeNull();
    expect(member.noWhoKind).toBeNull();
  });

  it('says only which approval is missing in the long text of an approval, not the route', () => {
    const next = deriveNext(
      task,
      wait({ reason: 'approval', next: [human('owner')], toStageId: 'code_review', labels: ['qa-ok'] }),
      ctx(),
    )!;
    expect(next.long).toBe('A következő lépéshez jóváhagyás kell: „qa-ok”.');
    expect(next.long).not.toContain('Innen');
    expect(next.todo).toBe('Döntsd el: jóváhagyod vagy elutasítod.');
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
      { head: 'Vár', waiting: 'AC-17, AC-19 +1' },
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
    [
      'part_left',
      { next: [ai('be-1')], toStageId: 'code_review' },
      {},
      { waiting: 'a rész itt maradt: Fejlesztés', you: false, toStageId: null },
    ],
    [
      'part_left',
      { next: [human('owner')], toStageId: 'code_review', labels: ['qa-ok'] },
      {},
      { head: 'Rád vár', you: true, toStageId: null },
    ],
    ['part_left', { next: [] }, {}, { head: 'Senki' }],
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
