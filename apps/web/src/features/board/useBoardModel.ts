import { useMemo } from 'react';
import { isTheme } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { useBoard, useInbox } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { deriveTaskState, groupOpenInboxByTask, phaseOrder } from '../../lib/taskState';
import type { TaskState, TaskStateContext } from '../../lib/taskState';

export interface BoardEntry {
  task: Task;
  state: TaskState;
}

/** Cards with the same time keep a stable order: the higher key (the newer card) first. */
function newerKeyFirst(a: BoardEntry, b: BoardEntry): number {
  return b.task.key.localeCompare(a.task.key, undefined, { numeric: true });
}

export function sortEntries(entries: BoardEntry[]): BoardEntry[] {
  return [...entries].sort((a, b) => {
    const phase = phaseOrder[a.state.phase] - phaseOrder[b.state.phase];
    if (phase !== 0) return phase;
    const time =
      a.state.phase === 'done'
        ? (b.task.closedAt ?? '').localeCompare(a.task.closedAt ?? '')
        : b.task.updatedAt.localeCompare(a.task.updatedAt);
    return time !== 0 ? time : newerKeyFirst(a, b);
  });
}

/** Board data plus the derived state of every task, shared by the board, the phone list and the drawer. */
export function useBoardModel() {
  const { key, myHandle } = useProject();
  const board = useBoard(key);
  const inbox = useInbox(key);
  const { members, pipeline } = useProjectIndexes(key);
  const tasks = board.data?.tasks;
  const labels = board.data?.labels;
  const items = inbox.data?.items;

  const model = useMemo(() => {
    if (!tasks || !pipeline) return null;
    const ctx: TaskStateContext = {
      pipeline,
      members,
      openInboxByTask: groupOpenInboxByTask(items),
      tasksByKey: new Map(tasks.map((task) => [task.key, task])),
      myHandle,
      labels,
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
  }, [tasks, labels, items, pipeline, members, myHandle]);

  return { board, inbox, members, pipeline, model };
}
