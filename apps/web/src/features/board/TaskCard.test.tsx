import { cleanup, screen, within } from '@testing-library/react';
import type { Task } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { indexPipeline } from '../../lib/pipeline';
import { deriveTaskState, groupOpenInboxByTask } from '../../lib/taskState';
import { matchesSearch } from './cardModel';
import type { TaskStateContext } from '../../lib/taskState';
import { buildConfig, inbox, tasks } from '../../mocks/fixtures';
import { mockIndexes, renderUi } from '../../test/render';
import { joinNames, t } from '../../i18n/t';
import { TaskCard } from './TaskCard';

const { pipeline, members } = mockIndexes();
const labelViews = buildConfig().pipeline.labels.map((label) => ({ ...label, holders: [] }));
const ctx: TaskStateContext = {
  pipeline,
  members,
  openInboxByTask: groupOpenInboxByTask(inbox),
  tasksByKey: new Map(tasks.map((task) => [task.key, task])),
  myHandle: 'owner',
};

const needsYou = (what: string) => t('taskStatus.needsYou', { what });
const waitingOn = (...names: string[]) => t('taskStatus.waitingOn', { who: joinNames(names) });
const working = (name: string) => t('taskStatus.worker.working', { name });
const COMMAND = 'Bash: ./scripts/restore-drill.sh';
const permissionFor = (detail: string) =>
  needsYou(t('taskStatus.needsYouDetail', { kind: t('inbox.kindsLower.permission'), detail }));

/** The status line's tooltip: the responsible member's avatar has a title of its own. */
const statusTitle = '[title]:not([role="img"])';

function taskByKey(key: string): Task {
  const task = tasks.find((entry) => entry.key === key);
  if (!task) throw new Error(`no fixture ${key}`);
  return task;
}

function renderCard(key: string, selected = false) {
  const task = taskByKey(key);
  const state = deriveTaskState(task, ctx);
  renderUi(
    <TaskCard
      task={task}
      state={state}
      pipeline={pipeline}
      to={`/p/AC/tasks/${key}`}
      selected={selected}
      labels={labelViews}
    />,
  );
  return screen.getByRole('link');
}

describe('TaskCard', () => {
  it.each(['urgent', 'high', 'normal', 'low'] as const)(
    'names the %s mark accessibly on the card link',
    (priority) => {
      const task = { ...taskByKey('AC-24'), priority };
      renderUi(<TaskCard task={task} state={deriveTaskState(task, ctx)} pipeline={pipeline} to="/task" />);
      const label = t('priority.markLabel', { level: t(`priority.levels.${priority}`) });
      const card = screen.getByRole('link', { name: new RegExp(label) });
      const mark = within(card).getByTitle(label).querySelector('svg')!;
      expect(mark.getAttribute('aria-hidden')).toBe('true');
      if (priority === 'urgent') expect(mark.querySelector('path')).toBeTruthy();
      else
        expect(mark.querySelectorAll('rect[fill="var(--c-ink-2)"]').length).toBe(
          priority === 'high' ? 3 : priority === 'normal' ? 2 : 1,
        );
    },
  );
  it.each(['done', 'cancelled'] as const)('hides the priority mark on a %s card', (status) => {
    const task = { ...taskByKey('AC-24'), priority: 'high' as const, status };
    renderUi(<TaskCard task={task} state={deriveTaskState(task, ctx)} pipeline={pipeline} to="/task" />);
    expect(screen.queryByTitle(t('priority.markLabel', { level: t('priority.levels.high') }))).toBeNull();
  });
  it('shows the title, PR, labels, grouped-stage rows and the status line', () => {
    const card = renderCard('AC-21');
    expect(card.getAttribute('href')).toBe('/p/AC/tasks/AC-21');
    expect(within(card).getByText('Rendelés-visszaigazoló e-mail')).toBeTruthy();
    expect(within(card).getByText('PR #14 · webshop')).toBeTruthy();
    // Results are labels, named and coloured by their definitions.
    expect(within(card).getByText('Újrateszt kell')).toBeTruthy();
    expect(within(card).getByText('Code review rendben')).toBeTruthy();
    const progress = within(card).getByRole('list', { name: t('taskCard.stageRows') });
    expect(
      within(progress)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual([
      t('stageRows.line', { name: 'Code review', state: t('stageRows.done') }),
      t('stageRows.line', { name: 'Integration', state: t('stageRows.done') }),
      t('stageRows.line', { name: 'QA', state: t('stageRows.active') }),
    ]);
    expect(within(card).getByText(permissionFor('git push'))).toBeTruthy();
    expect(card.getAttribute('data-phase')).toBe('needs_you');
    expect(
      within(card).getByRole('img', {
        name: t('taskCard.stageProgress', { stage: 'QA', index: 5, total: 9 }),
      }),
    ).toBeTruthy();
  });

  it('marks the task that is open in the drawer', () => {
    const card = renderCard('AC-20', true);
    expect(card.getAttribute('aria-current')).toBe('true');
    expect(within(card).getByText(working('Backend fejlesztő'))).toBeTruthy();
    expect(within(card).queryByRole('list', { name: t('taskCard.stageRows') })).toBeNull();
  });

  it('carries the loop mark with who was told, and none without a loop (PM-261)', () => {
    expect(within(renderCard('AC-20')).queryByText(t('loop.mark'))).toBeNull();
    cleanup();

    const base = taskByKey('AC-20');
    const task: Task = {
      ...base,
      loop: {
        id: 'loop_1',
        members: ['be-1', 'fe-1'],
        count: 6,
        startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
        lastMessageAt: new Date().toISOString(),
        notified: 'be-1',
        phase: 'notified',
        ownerReason: null,
        deciders: [],
        letRunBy: null,
      },
    };
    renderUi(
      <TaskCard
        task={task}
        state={deriveTaskState(task, ctx)}
        pipeline={pipeline}
        to="/p/AC/tasks/AC-20"
        selected={false}
        labels={labelViews}
      />,
    );
    const mark = screen.getByText(t('loop.mark')).closest('[title]')!;
    expect(mark.getAttribute('title')).toMatch(/6 üzenet/);
    expect(mark.getAttribute('title')).toContain('12 perce');
    expect(mark.getAttribute('title')).toContain('Jelezve:');
    expect(mark.getAttribute('aria-label')).toContain(t('loop.mark'));
  });

  it('says who works on the card, and never the command they run (PM-237)', () => {
    const card = renderCard('AC-20');
    const line = within(card).getByText(working('Backend fejlesztő'));
    expect(line.getAttribute('title')).toBe(working('Backend fejlesztő'));
    expect(card.textContent).not.toContain('Bash');
    expect(card.textContent).not.toContain('restore-drill');
  });

  it('names a second worker with their own capacity in the tooltip, and the names share one line', () => {
    const task = taskByKey('AC-20');
    const fe = members.get('fe-1')!;
    const withDesigner = new Map(members).set('fe-1', {
      ...fe,
      role: 'designer',
      roles: ['designer'],
      taskWork: [
        { sessionId: 'ses_fe', taskKey: 'AC-20', activity: COMMAND, since: '2026-10-01T10:00:00.000Z' },
      ],
    });
    const state = deriveTaskState(task, { ...ctx, members: withDesigner });
    renderUi(<TaskCard task={task} state={state} pipeline={pipeline} to="/p/AC/tasks/AC-20" labels={[]} />);
    const line = screen.getByText(
      t('taskStatus.workersTwo', { names: joinNames(['Backend fejlesztő', fe.displayName]) }),
    );
    expect(line.getAttribute('title')).toBe(
      [working('Backend fejlesztő'), t('taskStatus.worker.designing', { name: fe.displayName })].join('\n'),
    );
    expect(screen.getByRole('link').textContent).not.toContain('Bash');
  });

  describe('the sentence of the worker (PM-239)', () => {
    const gateway = {
      summary: 'A mentések visszaállítási próbája fut a tesztadatbázison, utána a riasztás jön',
      detail: 'A visszaállítás a tegnap esti mentésből indul.',
    };
    const since = '2026-10-01T10:00:00.000Z';
    const sessionOf = (handle: string, doing?: { summary: string; detail?: string }) => ({
      sessionId: `ses_${handle}`,
      taskKey: 'AC-20',
      activity: COMMAND,
      since,
      ...(doing ? { doing } : {}),
    });

    /** AC-20 with these members working on it (the fixture's own worker steps aside). */
    function renderWith(workers: Record<string, { summary: string; detail?: string } | null>) {
      const task = taskByKey('AC-20');
      const team = new Map(
        [...members].map(([handle, member]) => [
          handle,
          { ...member, taskWork: handle in workers ? [sessionOf(handle, workers[handle] ?? undefined)] : [] },
        ]),
      );
      const state = deriveTaskState(task, { ...ctx, members: team });
      renderUi(<TaskCard task={task} state={state} pipeline={pipeline} to="/p/AC/tasks/AC-20" labels={[]} />);
      return screen.getByRole('link');
    }

    it('names the worker with their own sentence, and keeps the longer text off the card', () => {
      const card = renderWith({ 'be-1': gateway });
      const line = `Backend fejlesztő: ${gateway.summary}`;
      expect(within(card).getByText(line)).toBeTruthy();
      expect(within(card).getByText(gateway.summary)).toBeTruthy();
      expect(card.querySelector(statusTitle)!.getAttribute('title')).toBe(line);
      expect(card.textContent).not.toContain(gateway.detail);
      expect(within(card).queryByText(working('Backend fejlesztő'))).toBeNull();
      expect(card.textContent).not.toContain('Bash');
    });

    it('keeps the line of the capacity for a worker who said nothing', () => {
      const card = renderWith({ 'be-1': null });
      expect(within(card).getByText(working('Backend fejlesztő'))).toBeTruthy();
    });

    it('gives each of two workers a row: the sentence of one, the capacity of the other', () => {
      const card = renderWith({ 'be-1': null, 'fe-1': { summary: 'A diff átnézése folyik' } });
      const fe = members.get('fe-1')!.displayName;
      expect(within(card).getByText(working('Backend fejlesztő'))).toBeTruthy();
      expect(within(card).getByText(`${fe}: A diff átnézése folyik`)).toBeTruthy();
      expect(card.querySelector(statusTitle)!.getAttribute('title')).toBe(
        [working('Backend fejlesztő'), `${fe}: A diff átnézése folyik`].join('\n'),
      );
      expect(within(card).queryByText(/^\+\d/)).toBeNull();
    });

    it('counts the workers beyond the second, and says so to a screen reader', () => {
      const card = renderWith({
        'be-1': gateway,
        'fe-1': null,
        'dev-1': { summary: 'A diff átnézése folyik' },
      });
      expect(within(card).getByText(t('taskStatus.workersMore', { more: 1 }))).toBeTruthy();
      expect(within(card).getByText(t('taskStatus.workersMoreLabel', { more: 1 }))).toBeTruthy();
      // Only two rows are named; the third worker is in the tooltip.
      expect(card.querySelector(statusTitle)!.getAttribute('title')!.split('\n')).toHaveLength(3);
    });
  });

  it('shows done tasks with the merged PR', () => {
    const card = renderCard('AC-16');
    expect(within(card).getByText('PR #18 · admin')).toBeTruthy();
    expect(
      within(card).getByText((text) => text.startsWith(t('taskStatus.done', { when: '' }))),
    ).toBeTruthy();
    expect(card.getAttribute('data-phase')).toBe('done');
  });
});

describe('deriveTaskState', () => {
  const phase = (key: string) => deriveTaskState(taskByKey(key), ctx);

  it('puts what waits for the viewer first', () => {
    expect(phase('AC-21')).toMatchObject({ phase: 'needs_you', label: permissionFor('git push') });
    expect(phase('AC-22')).toMatchObject({
      phase: 'needs_you',
      label: needsYou(t('inbox.kindsLower.question')),
    });
    expect(phase('AC-17')).toMatchObject({
      phase: 'needs_you',
      label: needsYou(t('inbox.kindsLower.decision')),
    });
    expect(phase('AC-27')).toMatchObject({ phase: 'needs_you', label: needsYou('Merge') });
  });

  it('tells working, waiting and ready tasks apart', () => {
    // The card names who works on it, not what their session runs.
    expect(phase('AC-20')).toMatchObject({ phase: 'working', label: working('Backend fejlesztő') });
    expect(phase('AC-19')).toMatchObject({ phase: 'waiting', label: waitingOn('Kata', 'Bence') });
    expect(phase('AC-26')).toMatchObject({
      phase: 'waiting',
      label: t('taskStatus.queuedFor', { stage: 'Integration' }),
    });
    expect(phase('AC-23')).toMatchObject({
      phase: 'waiting',
      label: t('taskStatus.prerequisiteOn', { key: 'AC-17' }),
    });
    expect(phase('AC-24')).toMatchObject({ phase: 'ready', label: t('taskStatus.ready') });
    expect(phase('AC-16').phase).toBe('done');
  });

  it('says who else is waited on when the item is assigned to someone else', () => {
    const noWorkers = new Map(
      [...members].map(([handle, member]) => [handle, { ...member, status: 'idle' as const, taskWork: [] }]),
    );
    expect(deriveTaskState(taskByKey('AC-18'), { ...ctx, members: noWorkers })).toMatchObject({
      phase: 'waiting',
      label: waitingOn('Kata'),
    });
  });

  describe('a member who works on another card (PM-207)', () => {
    // be-1 works on AC-20 and has an idle session on AC-22: only AC-20 is "working".
    const busy = (key: string, since: string) => {
      const be = members.get('be-1')!;
      const work = { sessionId: 'ses_work', taskKey: 'AC-20', activity: 'Bash: ls', since };
      return {
        ...ctx,
        members: new Map(members).set('be-1', {
          ...be,
          status: 'working' as const,
          activity: 'Bash: ls',
          currentTaskKeys: ['AC-20', key],
          taskWork: [work],
        }),
      };
    };

    it('shows who works and the age of the session on the card, not of the member', () => {
      const since = '2026-10-01T10:00:00.000Z';
      expect(deriveTaskState(taskByKey('AC-20'), busy('AC-22', since))).toMatchObject({
        phase: 'working',
        label: working('Backend fejlesztő'),
        since,
        worker: { handle: 'be-1' },
      });
    });

    it('does not call the card where the member only rests "working", nor shows the other card', () => {
      const state = deriveTaskState(taskByKey('AC-26'), busy('AC-26', '2026-10-01T10:00:00.000Z'));
      expect(state.phase).not.toBe('working');
      expect(state.worker).toBeNull();
      expect(state.label).not.toContain('Bash: ls');
    });
  });

  it('waits on an AI stage owner that already carries the task instead of queueing', () => {
    const task = taskByKey('AC-26');
    const owner = pipeline.stageById.get(task.stageId)!.owners!.find((h) => members.get(h)?.kind === 'ai')!;
    const holding = new Map(members);
    holding.set(owner, { ...members.get(owner)!, status: 'idle', currentTaskKeys: [task.key] });
    expect(deriveTaskState(task, { ...ctx, members: holding })).toMatchObject({
      phase: 'waiting',
      label: waitingOn(members.get(owner)!.displayName),
    });
  });

  it('names an earlier queue stage instead of calling its tasks ready to start', () => {
    const task = taskByKey('AC-24');
    const queue = pipeline.stageById.get(task.stageId)!;
    const incoming = { ...queue, id: 'incoming', name: 'Beérkezett' };
    const withIncoming = indexPipeline({
      stages: [incoming, ...pipeline.stages],
      columns: pipeline.columns.map((column, index) =>
        index === 0 ? { ...column, stageIds: ['incoming', ...column.stageIds] } : column,
      ),
    });
    expect(
      deriveTaskState({ ...task, stageId: 'incoming' }, { ...ctx, pipeline: withIncoming }),
    ).toMatchObject({
      phase: 'ready',
      label: 'Beérkezett',
    });
    expect(deriveTaskState(task, { ...ctx, pipeline: withIncoming })).toMatchObject({
      label: t('taskStatus.ready'),
    });
  });
});

describe('subtask card chips', () => {
  it('shows the parent key even on a compact phone card', () => {
    const task = { ...taskByKey('AC-20'), parentKey: 'AC-21' };
    renderUi(
      <TaskCard
        task={task}
        state={deriveTaskState(task, ctx)}
        pipeline={pipeline}
        to="/p/AC/tasks/AC-20"
        compact
      />,
    );
    expect(screen.getByText(t('task.parentChip', { key: 'AC-21' }))).toBeTruthy();
  });
  it('shows completed children out of all children', () => {
    const task = taskByKey('AC-20');
    renderUi(
      <TaskCard
        task={task}
        subtasks={[
          { ...taskByKey('AC-21'), parentKey: task.key, status: 'done' },
          { ...taskByKey('AC-22'), parentKey: task.key },
        ]}
        state={deriveTaskState(task, ctx)}
        pipeline={pipeline}
        to="/p/AC/tasks/AC-20"
      />,
    );
    expect(screen.getByText('1/2')).toBeTruthy();
  });

  it('a blocking label holds the task under the label name, and search finds labels by name', () => {
    const task = { ...taskByKey('AC-24'), labels: ['waiting-answer'] };
    expect(deriveTaskState(task, ctx).phase).toBe('ready');
    expect(deriveTaskState(task, { ...ctx, labels: labelViews })).toMatchObject({
      phase: 'waiting',
      label: 'Válaszra vár',
    });
    expect(matchesSearch(task, 'valaszra', labelViews)).toBe(true);
    expect(matchesSearch(task, 'valaszra')).toBe(false);
  });
});

describe('the prerequisite on the card (PM-203)', () => {
  const links = (...keys: string[]) => keys.map((ref) => ({ kind: 'prerequisite' as const, ref }));
  const on = (key: string, patch: Partial<Task>, context: TaskStateContext = ctx) => {
    const task = { ...taskByKey(key), ...patch };
    return { task, state: deriveTaskState(task, context) };
  };
  const draw = (task: Task, state: ReturnType<typeof deriveTaskState>, compact = false) => {
    renderUi(
      <TaskCard
        task={task}
        state={state}
        pipeline={pipeline}
        to={`/p/AC/tasks/${task.key}`}
        compact={compact}
      />,
    );
    return screen.getByRole('link');
  };
  const closing = (key: string, status: Task['status']): TaskStateContext => ({
    ...ctx,
    tasksByKey: new Map(ctx.tasksByKey).set(key, { ...taskByKey(key), status }),
  });
  const label = (key: string) => t('taskStatus.prerequisiteOn', { key });

  it('says it in the status line of a card that waits in a queue stage, once', () => {
    const { task, state } = on('AC-24', { links: links('AC-17'), status: 'active' });
    expect(state).toMatchObject({ phase: 'waiting', label: label('AC-17') });
    const card = draw(task, state);
    expect(within(card).getAllByText(label('AC-17'))).toHaveLength(1);
  });

  it.each(['claude', 'codex'] as const)(
    'names the provider that is not logged in in the status line (%s, PM-324)',
    (provider) => {
      const { task, state } = on('AC-22', {
        startWaiting: {
          reason: 'provider_not_logged_in',
          provider,
          member: 'be-1',
          since: '2026-10-01T10:00:00.000Z',
        },
      });
      const text = t('taskStatus.startWaiting.provider_not_logged_in', {
        provider: t(`providers.${provider}`),
      });
      expect(state).toMatchObject({ phase: 'waiting', label: text });
      expect(within(draw(task, state)).getByText(text)).toBeTruthy();
    },
  );

  it('says it in the status line for a start that waits for prerequisites in the work stage', () => {
    const { task, state } = on('AC-22', {
      links: links('AC-17'),
      startWaiting: {
        reason: 'prerequisite_open',
        prerequisites: ['AC-17'],
        since: '2026-10-01T10:00:00.000Z',
      },
    });
    expect(state).toMatchObject({ phase: 'waiting', label: label('AC-17') });
    expect(within(draw(task, state)).getAllByText(label('AC-17'))).toHaveLength(1);
  });

  it('names the first open prerequisite and counts the rest, with all of them in the tooltip', () => {
    const { task, state } = on('AC-24', { links: links('AC-19', 'AC-17'), status: 'active' });
    // By key, not by the order the links were set in.
    expect(state.label).toBe(t('taskStatus.prerequisiteOnMore', { key: 'AC-17', more: 1 }));
    const text = within(draw(task, state)).getByText(state.label);
    expect(text.getAttribute('title')).toBe(
      [taskByKey('AC-17'), taskByKey('AC-19')].map((card) => `${card.key} – ${card.title}`).join('\n'),
    );
  });

  it.each([
    ['AC-20', 'works on it'],
    ['AC-25', 'waits for the review'],
  ])('%s: the status line says what happens (%s) and a chip names the prerequisite, once', (key) => {
    const { task, state } = on(key, { links: links('AC-17', 'AC-19') });
    expect(state.label).not.toContain(t('taskStatus.prerequisite'));
    expect(state.prerequisite).toMatchObject({ key: 'AC-17', more: 1, inLabel: false });
    const card = draw(task, state);
    const chip = within(card).getByLabelText(
      t('taskStatus.prerequisiteOnMoreLabel', { key: 'AC-17', more: 1 }),
    );
    expect(chip.textContent).toBe(t('taskStatus.prerequisiteOnMore', { key: 'AC-17', more: 1 }));
    expect(chip.getAttribute('title')).toContain('AC-19');
    expect(card.textContent?.split(t('taskStatus.prerequisite'))).toHaveLength(2);
  });

  it('shows the chip on the phone list card too', () => {
    const { task, state } = on('AC-20', { links: links('AC-17') });
    const card = draw(task, state, true);
    expect(within(card).getByText(label('AC-17'))).toBeTruthy();
  });

  it('goes away when the prerequisite is closed, done or withdrawn', () => {
    const open = on('AC-24', { links: links('AC-17') });
    expect(open.state.label).toBe(label('AC-17'));
    for (const status of ['done', 'cancelled'] as const) {
      const closed = on('AC-24', { links: links('AC-17') }, closing('AC-17', status));
      expect(closed.state).toMatchObject({ phase: 'ready', label: t('taskStatus.ready') });
      expect(closed.state.prerequisite).toBeUndefined();
    }
    const busy = on('AC-20', { links: links('AC-17') }, closing('AC-17', 'done'));
    expect(busy.state.prerequisite).toBeUndefined();
    expect(within(draw(busy.task, busy.state)).queryByText(label('AC-17'))).toBeNull();
  });

  it('holds back only until the last of several is closed', () => {
    const after = on('AC-24', { links: links('AC-17', 'AC-19') }, closing('AC-17', 'done'));
    expect(after.state.label).toBe(label('AC-19'));
  });

  it('says nothing on a closed card', () => {
    const { state } = on('AC-16', { links: links('AC-17') });
    expect(state.prerequisite).toBeUndefined();
    expect(state.phase).toBe('done');
  });

  it('does not show a prerequisite the viewer cannot see', () => {
    const visible = new Map(ctx.tasksByKey);
    visible.delete('AC-17');
    const { state } = on('AC-20', { links: links('AC-17') }, { ...ctx, tasksByKey: visible });
    expect(state.prerequisite).toBeUndefined();
  });

  it('says which card a duplicate closed on', () => {
    const { state } = on('AC-24', { status: 'cancelled', links: [{ kind: 'duplicate_of', ref: 'AC-20' }] });
    expect(state).toMatchObject({ phase: 'cancelled', label: t('taskStatus.duplicateOf', { key: 'AC-20' }) });
  });
});
