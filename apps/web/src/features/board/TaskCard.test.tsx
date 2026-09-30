import { screen, within } from '@testing-library/react';
import type { Task } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { indexPipeline } from '../../lib/pipeline';
import { deriveTaskState, groupOpenInboxByTask } from '../../lib/taskState';
import type { TaskStateContext } from '../../lib/taskState';
import { inbox, tasks } from '../../mocks/fixtures';
import { mockIndexes, renderUi } from '../../test/render';
import { TaskCard } from './TaskCard';

const { pipeline, members } = mockIndexes();
const ctx: TaskStateContext = {
  pipeline,
  members,
  openInboxByTask: groupOpenInboxByTask(inbox),
  tasksByKey: new Map(tasks.map((task) => [task.key, task])),
  myHandle: 'owner',
};

function taskByKey(key: string): Task {
  const task = tasks.find((entry) => entry.key === key);
  if (!task) throw new Error(`no fixture ${key}`);
  return task;
}

function renderCard(key: string, selected = false) {
  const task = taskByKey(key);
  const state = deriveTaskState(task, ctx);
  renderUi(
    <TaskCard task={task} state={state} pipeline={pipeline} to={`/p/AC/tasks/${key}`} selected={selected} />,
  );
  return screen.getByRole('link');
}

describe('TaskCard', () => {
  it('shows the title, PR, labels, grouped-stage checks and the status line', () => {
    const card = renderCard('AC-21');
    expect(card.getAttribute('href')).toBe('/p/AC/tasks/AC-21');
    expect(within(card).getByText('Rendelés-visszaigazoló e-mail')).toBeTruthy();
    expect(within(card).getByText('PR #14 · webshop')).toBeTruthy();
    expect(within(card).getByText('Újrateszt kell')).toBeTruthy();
    const checks = within(card).getByRole('list', { name: 'Ellenőrzések' });
    expect(
      within(checks)
        .getAllByRole('listitem')
        .map((row) => row.textContent),
    ).toEqual(['Code review: rendben', 'Integration: kész', 'QA: újrateszt kell']);
    expect(within(card).getByText('Rád vár: engedély (git push)')).toBeTruthy();
    expect(card.getAttribute('data-phase')).toBe('needs_you');
    expect(within(card).getByRole('img', { name: /QA, 5\. lépés a 9-ból/ })).toBeTruthy();
  });

  it('marks the task that is open in the drawer', () => {
    const card = renderCard('AC-20', true);
    expect(card.getAttribute('aria-current')).toBe('true');
    expect(within(card).getByText('Dolgozik: Visszaállítási próba')).toBeTruthy();
    expect(within(card).queryByRole('list', { name: 'Ellenőrzések' })).toBeNull();
  });

  it('shows done tasks with the merged PR', () => {
    const card = renderCard('AC-16');
    expect(within(card).getByText('PR #18 · admin')).toBeTruthy();
    expect(within(card).getByText(/^Kész · /)).toBeTruthy();
    expect(card.getAttribute('data-phase')).toBe('done');
  });
});

describe('deriveTaskState', () => {
  const phase = (key: string) => deriveTaskState(taskByKey(key), ctx);

  it('puts what waits for the viewer first', () => {
    expect(phase('AC-21')).toMatchObject({ phase: 'needs_you', label: 'Rád vár: engedély (git push)' });
    expect(phase('AC-22')).toMatchObject({ phase: 'needs_you', label: 'Rád vár: kérdés' });
    expect(phase('AC-17')).toMatchObject({ phase: 'needs_you', label: 'Rád vár: döntés' });
    expect(phase('AC-27')).toMatchObject({ phase: 'needs_you', label: 'Rád vár: Merge' });
  });

  it('tells working, waiting and ready tasks apart', () => {
    expect(phase('AC-20')).toMatchObject({ phase: 'working', label: 'Dolgozik: Visszaállítási próba' });
    expect(phase('AC-19')).toMatchObject({ phase: 'waiting', label: 'Másra vár: Kata és Bence' });
    expect(phase('AC-26')).toMatchObject({ phase: 'waiting', label: 'Sorra kerül: Integration' });
    expect(phase('AC-23')).toMatchObject({ phase: 'waiting', label: 'Előfeltételre vár' });
    expect(phase('AC-24')).toMatchObject({ phase: 'ready', label: 'Indítható' });
    expect(phase('AC-16').phase).toBe('done');
  });

  it('says who else is waited on when the item is assigned to someone else', () => {
    const noWorkers = new Map(
      [...members].map(([handle, member]) => [handle, { ...member, status: 'idle' as const }]),
    );
    expect(deriveTaskState(taskByKey('AC-18'), { ...ctx, members: noWorkers })).toMatchObject({
      phase: 'waiting',
      label: 'Másra vár: Kata',
    });
  });

  it('waits on an AI stage owner that already carries the task instead of queueing', () => {
    const task = taskByKey('AC-26');
    const owner = pipeline.stageById.get(task.stageId)!.owners!.find((h) => members.get(h)?.kind === 'ai')!;
    const holding = new Map(members);
    holding.set(owner, { ...members.get(owner)!, status: 'idle', currentTaskKeys: [task.key] });
    expect(deriveTaskState(task, { ...ctx, members: holding })).toMatchObject({
      phase: 'waiting',
      label: `Másra vár: ${members.get(owner)!.displayName}`,
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
    expect(deriveTaskState(task, { ...ctx, pipeline: withIncoming })).toMatchObject({ label: 'Indítható' });
  });
});
