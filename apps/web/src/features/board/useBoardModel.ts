import { useMemo } from 'react';
import type { Task } from '@projectman/shared';
import { useBoard, useInbox } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { deriveTaskState, groupOpenInboxByTask, phaseOrder } from '../../lib/taskState';
import type { TaskState, TaskStateContext } from '../../lib/taskState';

export interface BoardEntry {
  task: Task;
  state: TaskState;
}

export function sortEntries(entries: BoardEntry[]): BoardEntry[] {
  return [...entries].sort((a, b) => {
    const phase = phaseOrder[a.state.phase] - phaseOrder[b.state.phase];
    if (phase !== 0) return phase;
    if (a.state.phase === 'done') return (b.task.closedAt ?? '').localeCompare(a.task.closedAt ?? '');
    return b.task.updatedAt.localeCompare(a.task.updatedAt);
  });
}

/** Board data plus the derived state of every task, shared by the board, the phone list and the drawer. */
export function useBoardModel() {
  const { key, myHandle } = useProject();
  const board = useBoard(key);
  const inbox = useInbox(key);
  const { members, pipeline } = useProjectIndexes(key);
  const tasks = board.data?.tasks;
  const items = inbox.data?.items;

  const model = useMemo(() => {
    if (!tasks || !pipeline) return null;
    const ctx: TaskStateContext = {
      pipeline,
      members,
      openInboxByTask: groupOpenInboxByTask(items),
      tasksByKey: new Map(tasks.map((task) => [task.key, task])),
      myHandle,
    };
    const subtasksByParent = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.parentKey) continue;
      const children = subtasksByParent.get(task.parentKey) ?? [];
      children.push(task);
      subtasksByParent.set(task.parentKey, children);
    }
    const entries: BoardEntry[] = tasks.map((task) => ({ task, state: deriveTaskState(task, ctx) }));
    return {
      ctx,
      entries,
      subtasksByParent,
      byKey: new Map(entries.map((entry) => [entry.task.key, entry])),
    };
  }, [tasks, items, pipeline, members, myHandle]);

  return { board, inbox, members, pipeline, model };
}
