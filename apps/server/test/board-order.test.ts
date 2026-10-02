import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOARD_RANK_STEP, sortBoardOrder, stagesOfColumn } from '@projectman/shared';
import type { BoardPlacement, ProjectConfig, ServerEvent } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';

/** The manual order of the board columns (PM-118), through the domain. */
describe('board order', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness({
      persistent: true,
      adjust: (config) => {
        // A column of its own for a gated stage: dropping on it asks for an approval.
        config.pipeline.columns.push({ id: 'merging', name: 'Merging' });
        config.pipeline.stages.find((stage) => stage.id === 'merge')!.columnId = 'merging';
      },
    });
  });
  afterEach(() => h.cleanup());

  const tasks = () => h.domain.tasks;
  const create = async (title: string) => (await tasks().create('AR', { title }, OWNER_ACTOR)).key;
  let stages: ProjectConfig['pipeline']['stages'] = [];
  beforeEach(async () => {
    stages = (await h.domain.projects.config('AR')).pipeline.stages;
  });
  const stagesIn = (columnId: string) => new Set(stagesOfColumn(stages, columnId).map((stage) => stage.id));
  /** The open cards of a column, in the order the board shows them. */
  const column = (columnId: string, source: DomainHarness = h) => {
    const ids = stagesIn(columnId);
    const open = source.domain.tasks
      .list('AR')
      .filter((task) => ids.has(task.stageId) && task.status !== 'cancelled');
    return sortBoardOrder(open.map((task) => ({ ...task, rank: task.boardRank }))).map((task) => task.key);
  };
  const drop = (
    taskKey: string,
    columnId: string,
    placement: BoardPlacement,
    fromStageId = tasks().get('AR', taskKey).stageId,
  ) => tasks().moveOnBoard('AR', taskKey, { columnId, fromStageId, placement }, OWNER_ACTOR);
  const upserts = (events: ServerEvent[]) =>
    events.flatMap((event) => (event.type === 'task_upserted' ? [event.task.key] : []));
  const record = () => {
    const events: ServerEvent[] = [];
    h.domain.bus.subscribe((event) => events.push(event));
    return events;
  };

  it('puts a new card on the top of its column', async () => {
    await create('One');
    await create('Two');
    await create('Three');
    expect(column('todo')).toEqual(['AR-3', 'AR-2', 'AR-1']);
    expect(Number.isInteger(tasks().get('AR', 'AR-1').boardRank)).toBe(true);
  });

  it('moves a card to any place of its own column, changing nothing else of it', async () => {
    for (const title of ['A', 'B', 'C', 'D']) await create(title);
    expect(column('todo')).toEqual(['AR-4', 'AR-3', 'AR-2', 'AR-1']);
    const before = tasks().get('AR', 'AR-1');
    const events = record();
    const result = await drop('AR-1', 'todo', { at: 'before', anchor: 'AR-3' });
    expect(result.outcome).toBe('reordered');
    expect(column('todo')).toEqual(['AR-4', 'AR-1', 'AR-3', 'AR-2']);
    const after = tasks().get('AR', 'AR-1');
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.closedAt).toBe(before.closedAt);
    expect(after.stageId).toBe(before.stageId);
    // A move between neighbours needs one rank, so one card is announced.
    expect(upserts(events)).toEqual(['AR-1']);
    expect(result.reranked).toEqual(['AR-1']);
    await drop('AR-4', 'todo', { at: 'end' });
    expect(column('todo')).toEqual(['AR-1', 'AR-3', 'AR-2', 'AR-4']);
    await drop('AR-2', 'todo', { at: 'top' });
    expect(column('todo')).toEqual(['AR-2', 'AR-1', 'AR-3', 'AR-4']);
    await drop('AR-3', 'todo', { at: 'after', anchor: 'AR-4' });
    expect(column('todo')).toEqual(['AR-2', 'AR-1', 'AR-4', 'AR-3']);
  });

  it('answers a drop where the card already is with no change and no event', async () => {
    for (const title of ['A', 'B', 'C']) await create(title);
    const events = record();
    const result = await drop('AR-2', 'todo', { at: 'after', anchor: 'AR-3' });
    expect(result.outcome).toBe('unchanged');
    expect(upserts(events)).toEqual([]);
    expect(column('todo')).toEqual(['AR-3', 'AR-2', 'AR-1']);
  });

  it('keeps a card in its place when its status, labels or assignee change', async () => {
    for (const title of ['A', 'B', 'C']) await create(title);
    await tasks().changeLabels('AR', 'AR-1', { add: ['tag'] }, OWNER_ACTOR);
    tasks().assign('AR', 'AR-1', 'dev-1', OWNER_ACTOR);
    await tasks().update('AR', 'AR-1', { title: 'Renamed' }, OWNER_ACTOR);
    expect(column('todo')).toEqual(['AR-3', 'AR-2', 'AR-1']);
  });

  it('puts a card that another way (PATCH, team tool) moves to a column on its top', async () => {
    for (const title of ['A', 'B', 'C']) await create(title);
    await tasks().update('AR', 'AR-1', { stageId: 'development' }, OWNER_ACTOR);
    await tasks().update('AR', 'AR-2', { stageId: 'development' }, OWNER_ACTOR);
    expect(column('doing')).toEqual(['AR-2', 'AR-1']);
    expect(column('todo')).toEqual(['AR-3']);
    const moved = tasks().get('AR', 'AR-2');
    expect(moved.stageId).toBe('development');
  });

  it('drops a card on another column at the chosen place, in one step with the stage change', async () => {
    for (const title of ['A', 'B', 'C']) await create(title);
    await tasks().update('AR', 'AR-1', { stageId: 'development' }, OWNER_ACTOR);
    await tasks().update('AR', 'AR-2', { stageId: 'development' }, OWNER_ACTOR);
    expect(column('doing')).toEqual(['AR-2', 'AR-1']);
    const events = record();
    const result = await drop('AR-3', 'doing', { at: 'after', anchor: 'AR-2' });
    expect(result.outcome).toBe('moved');
    expect(result.task.stageId).toBe('development');
    expect(column('doing')).toEqual(['AR-2', 'AR-3', 'AR-1']);
    // The card is announced once, with its new stage and its new rank together.
    expect(upserts(events)).toEqual(['AR-3']);
    const stageEvents = h.domain.timeline
      .list('AR', { taskKey: 'AR-3' })
      .filter((e) => e.type === 'task_stage_changed');
    expect(stageEvents).toHaveLength(1);
    expect(column('todo')).toEqual([]);
  });

  it('drops a card on an empty column', async () => {
    await create('A');
    const result = await drop('AR-1', 'doing', { at: 'top' });
    expect(result.outcome).toBe('moved');
    expect(column('doing')).toEqual(['AR-1']);
  });

  it('refuses a drop whose anchor left the column, and one whose source stage changed (409 board_stale)', async () => {
    for (const title of ['A', 'B', 'C']) await create(title);
    await tasks().update('AR', 'AR-1', { stageId: 'development' }, OWNER_ACTOR);
    // The anchor is not in that column.
    const gone = await rejection(drop('AR-3', 'doing', { at: 'before', anchor: 'AR-2' }));
    expect(gone.code).toBe('board_stale');
    expect(gone.status).toBe(409);
    expect(tasks().get('AR', 'AR-3').stageId).toBe('backlog');
    // The card is no longer where the person saw it.
    const moved = await rejection(drop('AR-2', 'todo', { at: 'top' }, 'development'));
    expect(moved.code).toBe('board_stale');
    // The anchor is the card itself.
    const itself = await rejection(drop('AR-2', 'todo', { at: 'before', anchor: 'AR-2' }));
    expect(itself.code).toBe('board_stale');
  });

  it('refuses an unknown column, a cancelled card and a theme', async () => {
    await create('A');
    const unknown = await rejection(drop('AR-1', 'nowhere', { at: 'top' }));
    expect(unknown.code).toBe('unknown_column');
    expect(unknown.status).toBe(400);
    const theme = await tasks().create('AR', { title: 'Theme', kind: 'theme' }, OWNER_ACTOR);
    const refused = await rejection(
      tasks().moveOnBoard(
        'AR',
        theme.key,
        { columnId: 'todo', fromStageId: 'backlog', placement: { at: 'top' } },
        OWNER_ACTOR,
      ),
    );
    expect(refused.code).toBe('task_is_theme');
    await tasks().cancel('AR', 'AR-1', { reason: 'no' }, OWNER_ACTOR);
    const closed = await rejection(drop('AR-1', 'todo', { at: 'top' }, 'backlog'));
    expect(closed.code).toBe('task_closed');
  });

  it('orders the Done column by closing time and gives it no manual order', async () => {
    for (const [title, importedAt] of [
      ['Closed first', '2026-01-01T10:00:00.000Z'],
      ['Closed second', '2026-01-02T10:00:00.000Z'],
    ] as const)
      await tasks().create('AR', { title, stageId: 'done', importedAt }, OWNER_ACTOR);
    expect(tasks().get('AR', 'AR-1')).toMatchObject({ status: 'done', stageId: 'done', boardRank: 0 });
    const reorder = await rejection(drop('AR-1', 'done', { at: 'top' }));
    expect(reorder.code).toBe('board_column_chronological');
    expect(tasks().get('AR', 'AR-1').boardRank).toBe(0);
    // Reopened, a card takes the place it is dropped at in the column it goes back to.
    await create('C');
    const reopened = await drop('AR-1', 'todo', { at: 'after', anchor: 'AR-3' }, 'done');
    expect(reopened.task).toMatchObject({ status: 'active', closedAt: null });
    expect(column('todo')).toEqual(['AR-3', 'AR-1']);
  });

  it('keeps the cards of several stages of one column in one order', async () => {
    for (const title of ['A', 'B', 'C']) await create(title);
    await tasks().update('AR', 'AR-1', { stageId: 'code_review' }, OWNER_ACTOR);
    await tasks().update('AR', 'AR-2', { stageId: 'code_review' }, OWNER_ACTOR);
    await tasks()
      .update('AR', 'AR-2', { stageId: 'release' }, OWNER_ACTOR)
      .catch(() => undefined);
    await tasks().update('AR', 'AR-3', { stageId: 'code_review' }, OWNER_ACTOR);
    const inReview = column('review');
    expect(inReview).toHaveLength(3);
    // A drop inside the column is a reorder whatever stage a card stands in.
    await drop(inReview[2]!, 'review', { at: 'top' });
    expect(column('review')[0]).toBe(inReview[2]);
    expect(tasks().get('AR', inReview[2]!).stageId).toBe('code_review');
  });

  it('numbers the column afresh when two cards have no room between them, and announces each card written', async () => {
    for (const title of ['A', 'B', 'C', 'D']) await create(title);
    // AR-4 AR-3 AR-2 AR-1, with no room between the two on top.
    h.repos.tasks.setBoardRanks('AR', [
      { key: 'AR-4', rank: 10 },
      { key: 'AR-3', rank: 11 },
      { key: 'AR-2', rank: 5000 },
      { key: 'AR-1', rank: 9000 },
    ]);
    const events = record();
    const result = await drop('AR-1', 'todo', { at: 'before', anchor: 'AR-3' });
    expect(column('todo')).toEqual(['AR-4', 'AR-1', 'AR-3', 'AR-2']);
    // Every card of the column is written and announced once: the cost of a renumbering.
    expect(new Set(upserts(events))).toEqual(new Set(['AR-1', 'AR-2', 'AR-3', 'AR-4']));
    expect(upserts(events)).toHaveLength(4);
    expect(result.reranked.slice().sort()).toEqual(['AR-1', 'AR-2', 'AR-3', 'AR-4']);
    const ranks = column('todo').map((key) => tasks().get('AR', key).boardRank!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ranks[1]! - ranks[0]!).toBe(BOARD_RANK_STEP);
  });

  it('settles drops made at the same time one after the other, each on the order the other left', async () => {
    for (const title of ['A', 'B', 'C', 'D']) await create(title);
    const results = await Promise.all([
      drop('AR-1', 'todo', { at: 'top' }),
      drop('AR-2', 'todo', { at: 'end' }),
      drop('AR-3', 'todo', { at: 'before', anchor: 'AR-4' }),
    ]);
    // AR-2 is already last by the time its drop is settled.
    expect(results.map((r) => r.outcome)).toEqual(['reordered', 'unchanged', 'reordered']);
    expect(column('todo')).toEqual(['AR-1', 'AR-3', 'AR-4', 'AR-2']);
  });

  describe('a move that waits for approval', () => {
    const OWNER_ACCESS = { handle: 'owner', access: 'owner' } as const;
    /** Three cards in Code review, with the label the merge gate wants. */
    const setup = async () => {
      for (const title of ['A', 'B', 'C']) await create(title);
      for (const key of ['AR-1', 'AR-2', 'AR-3']) {
        await tasks().update('AR', key, { stageId: 'code_review' }, OWNER_ACTOR);
        await tasks().changeLabels('AR', key, { add: ['code-review-ok'] }, aiActor('cr'));
      }
    };
    const request = async (taskKey: string, placement: BoardPlacement) => {
      const err = await rejection(drop(taskKey, 'merging', placement));
      expect(err.code).toBe('approval_requested');
      return h.domain.inbox.list('AR', { kind: 'decision', state: 'open', taskKey });
    };
    const approve = async (items: { id: string }[]) => {
      for (const item of items)
        await h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, OWNER_ACCESS);
    };

    it('leaves the card where it is and keeps the placement on the request', async () => {
      await setup();
      const items = await request('AR-1', { at: 'end' });
      expect(items.length).toBeGreaterThan(0);
      expect(tasks().get('AR', 'AR-1')).toMatchObject({ stageId: 'code_review', status: 'waiting' });
      expect(JSON.stringify(items[0]!.payload)).toContain('"placement":{"at":"end"}');
    });

    it('puts the card at the chosen place once approved, after a restart too', async () => {
      await setup();
      await approve(await request('AR-1', { at: 'top' }));
      expect(column('merging')).toEqual(['AR-1']);
      const items = await request('AR-2', { at: 'after', anchor: 'AR-1' });
      h = await restartDomainHarness(h);
      await approve(items);
      expect(h.domain.tasks.get('AR', 'AR-2')).toMatchObject({ stageId: 'merge' });
      expect(column('merging', h)).toEqual(['AR-1', 'AR-2']);
    });

    it('puts the card on the top of the column when its anchor has left it by the approval', async () => {
      await setup();
      await approve(await request('AR-1', { at: 'top' }));
      const items = await request('AR-2', { at: 'after', anchor: 'AR-1' });
      // The anchor goes back to work while the approval waits.
      await tasks().update('AR', 'AR-1', { stageId: 'development' }, OWNER_ACTOR);
      await approve(items);
      expect(column('merging')).toEqual(['AR-2']);
    });
  });

  it('refuses a drop on a gated column without the label it needs, and writes nothing', async () => {
    for (const title of ['A', 'B']) await create(title);
    const err = await rejection(drop('AR-1', 'merging', { at: 'top' }));
    expect(err.code).toBe('gate_blocked');
    expect(tasks().get('AR', 'AR-1')).toMatchObject({ stageId: 'backlog', status: 'active' });
    expect(column('todo')).toEqual(['AR-2', 'AR-1']);
    expect(column('merging')).toEqual([]);
  });

  it('keeps the order across a restart', async () => {
    for (const title of ['A', 'B', 'C']) await create(title);
    await drop('AR-1', 'todo', { at: 'top' });
    const order = column('todo');
    h = await restartDomainHarness(h);
    expect(column('todo')).toEqual(order);
  });
});
