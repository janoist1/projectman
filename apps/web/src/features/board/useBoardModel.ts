import { useMemo } from 'react';
import { compareBoardOrder, isTheme } from '@projectman/shared';
import type { RankedCard, Task } from '@projectman/shared';
import { useBoard, useConfig, useEngineStatus, useInbox } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import type { PipelineIndex } from '../../lib/pipeline';
import { deriveTaskState, groupOpenInboxByTask } from '../../lib/taskState';
import type { TaskState, TaskStateContext } from '../../lib/taskState';
import { engineNameMap } from '../engines/engineView';
import { pausedSessionMap } from '../pause/pauseView';

export interface BoardEntry {
  task: Task;
  state: TaskState;
}

/** Cards with the same time keep a stable order: the higher key (the newer card) first. */
const newerKeyFirst = (a: BoardEntry, b: BoardEntry) =>
  b.task.key.localeCompare(a.task.key, undefined, { numeric: true });

const byClosing = (a: BoardEntry, b: BoardEntry) =>
  (b.task.closedAt ?? '').localeCompare(a.task.closedAt ?? '') || newerKeyFirst(a, b);

const rankedOf = ({ task }: BoardEntry): RankedCard => ({
  key: task.key,
  rank: task.boardRank,
  updatedAt: task.updatedAt,
});
const byRank = (a: BoardEntry, b: BoardEntry) => compareBoardOrder(rankedOf(a), rankedOf(b));

/**
 * The cards of one board column in the order the board shows them (PM-118): the stored manual order,
 * the same for everyone; a column of finished work by closing time, newest first. A card's phase or
 * colour never decides its place.
 */
export function sortColumnEntries(entries: BoardEntry[], chronological: boolean): BoardEntry[] {
  return [...entries].sort(chronological ? byClosing : byRank);
}

/**
 * The phone list's group: the finished ones by closing time; the others with the later column first
 * (the card nearest to done), each column in its stored order. There is no manual ordering on a phone.
 */
export function sortGroupEntries(entries: BoardEntry[], pipeline: PipelineIndex): BoardEntry[] {
  const columnOf = (entry: BoardEntry) => {
    const column = pipeline.columnOfStage.get(entry.task.stageId);
    return column ? pipeline.columns.indexOf(column) : -1;
  };
  return [...entries].sort((a, b) => {
    if (a.state.phase === 'done' && b.state.phase === 'done') return byClosing(a, b);
    return columnOf(b) - columnOf(a) || byRank(a, b);
  });
}

/** Board data plus the derived state of every task, shared by the board, the phone list and the drawer. */
export function useBoardModel() {
  const { key, myHandle, can } = useProject();
  const board = useBoard(key);
  const inbox = useInbox(key);
  // The shared start rule reads the team and the pipeline; the state line is the same for every viewer who gets them.
  const config = useConfig(key, can.readConfig).data?.config;
  const { members, pipeline } = useProjectIndexes(key);
  const tasks = board.data?.tasks;
  const labels = board.data?.labels;
  const items = inbox.data?.items;
  const pause = board.data?.pause;
  const engines = useEngineStatus().data?.engines;
  const engineNames = useMemo(() => engineNameMap(engines), [engines]);

  const model = useMemo(() => {
    if (!tasks || !pipeline) return null;
    const ctx: TaskStateContext = {
      pipeline,
      members,
      openInboxByTask: groupOpenInboxByTask(items),
      tasksByKey: new Map(tasks.map((task) => [task.key, task])),
      myHandle,
      labels,
      pausedSessions: pausedSessionMap(pause),
      config,
      engineNames,
    };
    const subtasksByParent = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.parentKey) continue;
      const children = subtasksByParent.get(task.parentKey) ?? [];
      children.push(task);
      subtasksByParent.set(task.parentKey, children);
    }
    // A theme is no card of the pipeline: it has no state and stays out of the columns and the lists.
    const entries: BoardEntry[] = tasks
      .filter((task) => !isTheme(task))
      .map((task) => ({ task, state: deriveTaskState(task, ctx) }));
    return {
      ctx,
      entries,
      subtasksByParent,
      byKey: new Map(entries.map((entry) => [entry.task.key, entry])),
    };
  }, [tasks, labels, items, pipeline, members, myHandle, pause, config, engineNames]);

  return { board, inbox, members, pipeline, model };
}
