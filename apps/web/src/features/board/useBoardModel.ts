import { useMemo, useRef } from 'react';
import { compareBoardOrder, isTheme } from '@projectman/shared';
import type { RankedCard, Task } from '@projectman/shared';
import { useBoard, useConfig, useEngineStatus, useInbox } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import type { MemberIndex } from '../../lib/members';
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
 * What of the members the card states read: everything but the activity text, which changes with every
 * tool call and says nothing about a card (PM-1109).
 */
function memberFingerprint(members: MemberIndex): string {
  return JSON.stringify(
    [...members.values()].map(({ activity: _activity, taskWork, ...rest }) => ({
      ...rest,
      taskWork: taskWork?.map(({ activity: _taskActivity, ...work }) => work),
    })),
  );
}

/** The member index, replaced only when a member changed in a way the card states can show. */
function useStableMembers(members: MemberIndex): MemberIndex {
  const fingerprint = memberFingerprint(members);
  const kept = useRef<{ fingerprint: string; members: MemberIndex } | null>(null);
  if (kept.current?.fingerprint !== fingerprint) kept.current = { fingerprint, members };
  return kept.current.members;
}

/** Board data plus the derived state of every task, shared by the board, the phone list and the drawer. */
export function useBoardModel() {
  const { key, myHandle, can } = useProject();
  const board = useBoard(key);
  const inbox = useInbox(key);
  // The shared start rule reads the team and the pipeline; the state line is the same for every viewer who gets them.
  const config = useConfig(key, can.readConfig).data?.config;
  const { members: indexed, pipeline } = useProjectIndexes(key);
  const members = useStableMembers(indexed);
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
