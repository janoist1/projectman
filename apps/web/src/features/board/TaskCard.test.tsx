import { screen, within } from '@testing-library/react';
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
const working = (activity: string) => t('taskStatus.working', { activity });
const permissionFor = (detail: string) =>
  needsYou(t('taskStatus.needsYouDetail', { kind: t('inbox.kindsLower.permission'), detail }));

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
    expect(within(card).getByText(working('Bash: ./scripts/restore-drill.sh'))).toBeTruthy();
    expect(within(card).queryByRole('list', { name: t('taskCard.stageRows') })).toBeNull();
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
    // The card shows what the session on it does, not the member's own activity line.
    expect(phase('AC-20')).toMatchObject({
      phase: 'working',
      label: working('Bash: ./scripts/restore-drill.sh'),
    });
    expect(phase('AC-19')).toMatchObject({ phase: 'waiting', label: waitingOn('Kata', 'Bence') });
    expect(phase('AC-26')).toMatchObject({
      phase: 'waiting',
      label: t('taskStatus.queuedFor', { stage: 'Integration' }),
    });
    expect(phase('AC-23')).toMatchObject({ phase: 'waiting', label: t('taskStatus.prerequisite') });
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

    it('shows the activity and the age of the session on the card, not of the member', () => {
      const since = '2026-10-01T10:00:00.000Z';
      expect(deriveTaskState(taskByKey('AC-20'), busy('AC-22', since))).toMatchObject({
        phase: 'working',
        label: working('Bash: ls'),
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
