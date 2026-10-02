import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sortBoardOrder, stagesOfColumn } from '@projectman/shared';
import type { BoardGroupItem, BoardPlacement, ProjectConfig, ServerEvent } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';

/** A collecting card dragged to another column with the subtasks that stand in its column (PM-121). */
describe('board group move', () => {
  let h: DomainHarness;
  let stages: ProjectConfig['pipeline']['stages'] = [];
  beforeEach(async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        // A column of its own for a gated stage: dropping on it asks for an approval.
        config.pipeline.columns.push({ id: 'merging', name: 'Merging' });
        config.pipeline.stages.find((stage) => stage.id === 'merge')!.columnId = 'merging';
      },
    });
    stages = (await h.domain.projects.config('AR')).pipeline.stages;
  });
  afterEach(() => h.cleanup());

  const tasks = () => h.domain.tasks;
  const create = async (title: string, parentKey?: string) =>
    (await tasks().create('AR', { title, ...(parentKey ? { parentKey } : {}) }, OWNER_ACTOR)).key;
  const column = (columnId: string) => {
    const ids = new Set(stagesOfColumn(stages, columnId).map((stage) => stage.id));
    const open = tasks()
      .list('AR')
      .filter((task) => ids.has(task.stageId) && task.status !== 'cancelled');
    return sortBoardOrder(open.map((task) => ({ ...task, rank: task.boardRank }))).map((task) => task.key);
  };
  const stageOf = (key: string) => tasks().get('AR', key).stageId;
  const place = (key: string, stageId: string) => tasks().update('AR', key, { stageId }, OWNER_ACTOR);
  const dropGroup = (
    taskKey: string,
    columnId: string,
    placement: BoardPlacement,
    extra: { despitePrerequisites?: boolean } = {},
  ) =>
    tasks().moveOnBoard(
      'AR',
      taskKey,
      {
        columnId,
        fromStageId: stageOf(taskKey),
        placement,
        withSubtasks: true,
        ...extra,
      },
      OWNER_ACTOR,
    );
  const outcomes = (items: BoardGroupItem[] | undefined) =>
    Object.fromEntries((items ?? []).map((item) => [item.taskKey, item.outcome]));
  const record = () => {
    const events: ServerEvent[] = [];
    h.domain.bus.subscribe((event) => events.push(event));
    return events;
  };
  const stageChanges = (key: string) =>
    h.domain.timeline.list('AR', { taskKey: key }).filter((event) => event.type === 'task_stage_changed');

  /** AR-1 with the subtasks AR-2, AR-3 (its column) and AR-4 (another column). */
  const family = async () => {
    await create('Collecting');
    await create('Same one', 'AR-1');
    await create('Same two', 'AR-1');
    await create('Elsewhere', 'AR-1');
    await place('AR-4', 'development');
  };

  it('moves the collecting card with the subtasks of its column and leaves the others', async () => {
    await family();
    await create('Other');
    const events = record();
    const result = await dropGroup('AR-1', 'doing', { at: 'top' });
    expect(result.outcome).toBe('moved');
    expect(result.task).toMatchObject({ key: 'AR-1', stageId: 'development' });
    // The collecting card first, then its subtasks in the order they had in their column.
    expect(result.group).toEqual([
      { taskKey: 'AR-1', outcome: 'moved' },
      { taskKey: 'AR-3', outcome: 'moved' },
      { taskKey: 'AR-2', outcome: 'moved' },
    ]);
    expect(column('doing')).toEqual(['AR-1', 'AR-3', 'AR-2', 'AR-4']);
    expect(column('todo')).toEqual(['AR-5']);
    expect(stageOf('AR-4')).toBe('development');
    // Each card has its own stage change on its timeline and is announced once.
    for (const key of ['AR-1', 'AR-2', 'AR-3']) expect(stageChanges(key)).toHaveLength(1);
    expect(stageChanges('AR-4')).toHaveLength(1);
    const upserted = events.flatMap((event) => (event.type === 'task_upserted' ? [event.task.key] : []));
    expect(upserted).toEqual(expect.arrayContaining(['AR-1', 'AR-2', 'AR-3']));
    expect(upserted).not.toContain('AR-5');
  });

  it('puts the block at a chosen place, before and after an anchor', async () => {
    await family();
    await create('Left');
    await create('Right');
    await place('AR-5', 'development');
    await place('AR-6', 'development');
    expect(column('doing')).toEqual(['AR-6', 'AR-5', 'AR-4']);
    await dropGroup('AR-1', 'doing', { at: 'after', anchor: 'AR-6' });
    expect(column('doing')).toEqual(['AR-6', 'AR-1', 'AR-3', 'AR-2', 'AR-5', 'AR-4']);
  });

  it('puts the block at the end of the column', async () => {
    await family();
    await dropGroup('AR-1', 'doing', { at: 'end' });
    expect(column('doing')).toEqual(['AR-4', 'AR-1', 'AR-3', 'AR-2']);
  });

  it('does not move the subtasks of another column along', async () => {
    await create('Collecting');
    await create('Late', 'AR-1');
    await place('AR-1', 'code_review');
    await tasks().changeLabels('AR', 'AR-2', { add: ['code-review-ok'] }, aiActor('cr'));
    await tasks().changeLabels('AR', 'AR-2', { add: ['merge-ok'] }, OWNER_ACTOR);
    await place('AR-2', 'merge');
    const result = await dropGroup('AR-1', 'todo', { at: 'top' });
    // Nothing of the column stands with it: the plain move of PM-118, no group.
    expect(result.group).toBeUndefined();
    expect(stageOf('AR-2')).toBe('merge');
  });

  it('leaves a cancelled subtask where it is', async () => {
    await family();
    await tasks().cancel('AR', 'AR-3', { reason: 'no' }, OWNER_ACTOR);
    const result = await dropGroup('AR-1', 'doing', { at: 'top' });
    expect(outcomes(result.group)).toEqual({ 'AR-1': 'moved', 'AR-2': 'moved' });
    expect(stageOf('AR-3')).toBe('backlog');
  });

  it('moves a card without subtasks like any drop, and refuses it like any drop', async () => {
    await create('Alone');
    const plain = await dropGroup('AR-1', 'doing', { at: 'top' });
    expect(plain.group).toBeUndefined();
    expect(plain.outcome).toBe('moved');
    const err = await rejection(dropGroup('AR-1', 'merging', { at: 'top' }));
    expect(err.code).toBe('gate_blocked');
  });

  it('only changes the place of a collecting card dropped in its own column', async () => {
    await family();
    await create('Other');
    const result = await dropGroup('AR-1', 'todo', { at: 'top' });
    expect(result.group).toBeUndefined();
    expect(column('todo')).toEqual(['AR-1', 'AR-5', 'AR-3', 'AR-2']);
    expect(stageChanges('AR-2')).toHaveLength(0);
  });

  it('moves only the subtasks when the collecting card is refused, and tells why', async () => {
    await create('Collecting');
    await create('Ready', 'AR-1');
    await create('Not ready', 'AR-1');
    for (const key of ['AR-1', 'AR-2', 'AR-3']) await place(key, 'code_review');
    // Only AR-2 has both labels the merge gate asks for.
    await tasks().changeLabels('AR', 'AR-2', { add: ['code-review-ok'] }, aiActor('cr'));
    await tasks().changeLabels('AR', 'AR-2', { add: ['merge-ok'] }, OWNER_ACTOR);
    const result = await dropGroup('AR-1', 'merging', { at: 'top' });
    expect(outcomes(result.group)).toEqual({ 'AR-1': 'blocked', 'AR-2': 'moved', 'AR-3': 'blocked' });
    expect(result.outcome).toBe('unchanged');
    const blocked = result.group!.find((item) => item.taskKey === 'AR-3');
    expect(blocked).toMatchObject({ outcome: 'blocked', code: 'gate_blocked' });
    expect(JSON.stringify(blocked)).toContain('code-review-ok');
    expect(stageOf('AR-1')).toBe('code_review');
    expect(stageOf('AR-2')).toBe('merge');
    expect(stageOf('AR-3')).toBe('code_review');
    expect(column('merging')).toEqual(['AR-2']);
    expect(stageChanges('AR-1')).toHaveLength(1);
  });

  it('checks each subtask on its own when the collecting card is refused', async () => {
    await create('Collecting');
    await create('Child', 'AR-1');
    for (const key of ['AR-1', 'AR-2']) await place(key, 'code_review');
    const result = await dropGroup('AR-1', 'merging', { at: 'top' });
    expect(outcomes(result.group)).toEqual({ 'AR-1': 'blocked', 'AR-2': 'blocked' });
    expect(result.task.stageId).toBe('code_review');
  });

  describe('a move that waits for approval', () => {
    const OWNER_ACCESS = { handle: 'owner', access: 'owner' } as const;
    const setup = async () => {
      await create('Collecting');
      await create('One', 'AR-1');
      await create('Two', 'AR-1');
      for (const key of ['AR-1', 'AR-2', 'AR-3']) {
        await place(key, 'code_review');
        await tasks().changeLabels('AR', key, { add: ['code-review-ok'] }, aiActor('cr'));
      }
    };
    const items = (key: string) =>
      h.domain.inbox.list('AR', { kind: 'decision', state: 'open', taskKey: key });
    const approve = async (key: string) => {
      for (const item of items(key))
        await h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, OWNER_ACCESS);
    };

    it('asks for every card and moves each on its own after the person approves', async () => {
      await setup();
      const result = await dropGroup('AR-1', 'merging', { at: 'top' });
      expect(outcomes(result.group)).toEqual({
        'AR-1': 'approval_pending',
        'AR-2': 'approval_pending',
        'AR-3': 'approval_pending',
      });
      const pending = result.group!.find((item) => item.taskKey === 'AR-2');
      expect(pending).toMatchObject({ outcome: 'approval_pending' });
      expect((pending as { inboxItemIds: string[] }).inboxItemIds).toEqual(items('AR-2').map((i) => i.id));
      expect(stageOf('AR-1')).toBe('code_review');
      // One card's approval moves that card only, not the group again.
      await approve('AR-3');
      expect(stageOf('AR-3')).toBe('merge');
      expect(stageOf('AR-1')).toBe('code_review');
      expect(stageOf('AR-2')).toBe('code_review');
      await approve('AR-1');
      await approve('AR-2');
      expect(
        stageChanges('AR-1').filter((event) => (event.data as { to: string }).to === 'merge'),
      ).toHaveLength(1);
      expect(column('merging')).toHaveLength(3);
    });

    it('keeps the card that was refused a gate out of the pending ones', async () => {
      await setup();
      await tasks().changeLabels('AR', 'AR-3', { remove: ['code-review-ok'] }, aiActor('cr'));
      const result = await dropGroup('AR-1', 'merging', { at: 'top' });
      expect(outcomes(result.group)).toEqual({
        'AR-1': 'approval_pending',
        'AR-2': 'approval_pending',
        'AR-3': 'blocked',
      });
    });
  });

  it('takes the labels that expire off every card that goes back', async () => {
    await family();
    for (const key of ['AR-1', 'AR-2', 'AR-3']) {
      await place(key, 'code_review');
      await tasks().changeLabels('AR', key, { add: ['code-review-ok'] }, aiActor('cr'));
    }
    const result = await dropGroup('AR-1', 'doing', { at: 'top' });
    expect(outcomes(result.group)).toEqual({ 'AR-1': 'moved', 'AR-2': 'moved', 'AR-3': 'moved' });
    for (const key of ['AR-1', 'AR-2', 'AR-3'])
      expect(tasks().get('AR', key).labels).not.toContain('code-review-ok');
  });

  it('rolls everything back when a card fails for a reason that is no business refusal', async () => {
    await family();
    const append = h.domain.timeline.append.bind(h.domain.timeline);
    const spy = vi.spyOn(h.domain.timeline, 'append').mockImplementation((entry) => {
      if (entry.taskKey === 'AR-2' && entry.type === 'task_stage_changed') throw new Error('disk full');
      return append(entry);
    });
    const events = record();
    await expect(dropGroup('AR-1', 'doing', { at: 'top' })).rejects.toThrow('disk full');
    spy.mockRestore();
    expect(['AR-1', 'AR-2', 'AR-3'].map(stageOf)).toEqual(['backlog', 'backlog', 'backlog']);
    expect(stageChanges('AR-1')).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it('refuses the whole drop when the collecting card is not in the stage the person saw', async () => {
    await family();
    const err = await rejection(
      tasks().moveOnBoard(
        'AR',
        'AR-1',
        { columnId: 'doing', fromStageId: 'development', placement: { at: 'top' }, withSubtasks: true },
        OWNER_ACTOR,
      ),
    );
    expect(err.code).toBe('board_stale');
    expect(['AR-1', 'AR-2', 'AR-3'].map(stageOf)).toEqual(['backlog', 'backlog', 'backlog']);
  });

  it('refuses the whole drop when its anchor left the column', async () => {
    await family();
    const err = await rejection(dropGroup('AR-1', 'doing', { at: 'before', anchor: 'AR-2' }));
    expect(err.code).toBe('board_stale');
    expect(['AR-1', 'AR-2', 'AR-3'].map(stageOf)).toEqual(['backlog', 'backlog', 'backlog']);
  });

  it('starts no work itself: the cards that enter the work stage are left to the admission', async () => {
    await family();
    await dropGroup('AR-1', 'doing', { at: 'top' });
    // The group move assigns nobody and starts no session of its own.
    for (const key of ['AR-1', 'AR-2', 'AR-3']) expect(tasks().get('AR', key).assignee).toBeNull();
    expect(h.repos.sessions.list('AR', {})).toEqual([]);
  });
});

/** The subtasks of a column that has several stages: each is taken from the stage it stands on. */
describe('board group move from a column of several stages', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
  });
  afterEach(() => h.cleanup());

  it('takes the subtasks of every stage of the column back to the first stage of the target', async () => {
    const tasks = h.domain.tasks;
    for (const [title, parentKey] of [['Collecting'], ['On merge', 'AR-1'], ['On review', 'AR-1']] as const)
      await tasks.create('AR', { title, ...(parentKey ? { parentKey } : {}) }, OWNER_ACTOR);
    for (const key of ['AR-1', 'AR-2', 'AR-3']) {
      await tasks.update('AR', key, { stageId: 'code_review' }, OWNER_ACTOR);
      await tasks.changeLabels('AR', key, { add: ['code-review-ok'] }, aiActor('cr'));
    }
    await tasks.changeLabels('AR', 'AR-2', { add: ['merge-ok'] }, OWNER_ACTOR);
    await tasks.update('AR', 'AR-2', { stageId: 'merge' }, OWNER_ACTOR);
    const result = await tasks.moveOnBoard(
      'AR',
      'AR-1',
      { columnId: 'doing', fromStageId: 'code_review', placement: { at: 'top' }, withSubtasks: true },
      OWNER_ACTOR,
    );
    expect(result.group?.map((item) => [item.taskKey, item.outcome])).toEqual([
      ['AR-1', 'moved'],
      ['AR-3', 'moved'],
      ['AR-2', 'moved'],
    ]);
    for (const key of ['AR-1', 'AR-2', 'AR-3']) expect(tasks.get('AR', key).stageId).toBe('development');
  });
});
