import { evaluateStart, stageIndex } from '../config/gates';
import { developmentStage } from '../config/refinement';
import type { ProjectConfig } from '../config/schema';
import { startBlock } from '../config/start-block';
import { compareBoardOrder } from './board-order';
import { openPrerequisites } from './relations';
import { canAutomaticallyStartTask, isOpenTask } from './task';
import type { Task, TaskPriority } from './task';
import type { Stage } from './pipeline';

/**
 * How a start of a card ranks among the waiting ones (PM-436): the `urgent` cards (the card's priority is
 * `urgent`) first, then the `other` ones.
 */
export type StartClass = { kind: 'urgent' } | { kind: 'other' };

export const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

/**
 * The highest of the card's, its parent's and its theme's priority; a closed parent or theme does not
 * count. A subtask's theme is its parent's. `tasks` holds the parents and themes (and may hold more);
 * one that is not in it counts for nothing. `null`: none of them has a priority.
 */
export function effectivePriority(
  task: Pick<Task, 'priority' | 'parentKey' | 'themeKey'>,
  tasks: readonly Pick<Task, 'key' | 'priority' | 'themeKey' | 'status'>[],
): TaskPriority | null {
  const parent = task.parentKey ? tasks.find((card) => card.key === task.parentKey) : undefined;
  const themeKey = task.themeKey ?? parent?.themeKey;
  const theme = themeKey ? tasks.find((card) => card.key === themeKey) : undefined;
  let best = task.priority;
  for (const other of [parent, theme]) {
    if (!other?.priority || !isOpenTask(other)) continue;
    if (!best || PRIORITY_RANK[other.priority] < PRIORITY_RANK[best]) best = other.priority;
  }
  return best;
}

/**
 * `urgent` for an open card whose priority is urgent, else `other`. A start with no card (`null`) is `other`.
 * With `tasks` the priority is the {@link effectivePriority}: an urgent parent or theme counts too.
 */
export function startClass(
  task: Task | null,
  tasks?: readonly Pick<Task, 'key' | 'priority' | 'themeKey' | 'status'>[],
): StartClass {
  if (!task || !isOpenTask(task)) return { kind: 'other' };
  const priority = tasks ? effectivePriority(task, tasks) : task.priority;
  return priority === 'urgent' ? { kind: 'urgent' } : { kind: 'other' };
}

const CLASS_RANK = { urgent: 0, other: 1 } as const;

/** Urgent before other; 0 within the same class. */
export function compareStartClass(a: StartClass, b: StartClass): number {
  return CLASS_RANK[a.kind] - CLASS_RANK[b.kind];
}

/**
 * The stage cards are pulled from (PM-436): the step before the development stage, when it is a queue;
 * null when there is none, so nothing is pulled.
 */
export function pullSourceStage(config: Pick<ProjectConfig, 'pipeline'>): Stage | null {
  const development = developmentStage(config);
  if (!development) return null;
  const index = stageIndex(config.pipeline, development.id);
  const source = index > 0 ? config.pipeline.stages[index - 1] : undefined;
  return source?.kind === 'queue' ? source : null;
}

/**
 * The cards that may be pulled into development, in board order: the urgent ones (by their
 * {@link effectivePriority}: an urgent parent or theme counts). A card is a candidate when
 * it is an active card (not a theme or a collector with subtasks) in the source stage with no assignee and
 * no open prerequisite, its start is not blocked (`startBlock`: not being refined, no holding label, no
 * approval pending) and the gates on the way ask for nothing more: no missing label and no approval to request.
 */
export function pullCandidates(input: { config: ProjectConfig; tasks: readonly Task[] }): Task[] {
  const { config, tasks } = input;
  const source = pullSourceStage(config);
  const development = developmentStage(config);
  if (!source || !development) return [];
  const ranked = (task: Task) => ({ key: task.key, rank: task.boardRank, updatedAt: task.updatedAt });
  return startableCards({ config, tasks, fromStageId: source.id, toStageId: development.id })
    .filter((task) => startClass(task, tasks).kind === 'urgent')
    .sort((a, b) => compareBoardOrder(ranked(a), ranked(b)));
}

/** The cards of a queue stage a developer could start into the given work stage now (PM-665),
 * in the order of `tasks`: the rules of `pullCandidates` without its urgent condition.
 * A card that already has an assignee is left out unless `assigned` is set (PM-879): its assignee keeps it
 * and a `start_task` moves it into the work stage, which a plain move does not do. */
export function startableCards(input: {
  config: ProjectConfig;
  tasks: readonly Task[];
  fromStageId: string;
  toStageId: string;
  assigned?: boolean;
}): Task[] {
  const { config, tasks, fromStageId, toStageId, assigned } = input;
  return tasks.filter((task) => {
    if (
      !canAutomaticallyStartTask(task, tasks) ||
      task.status !== 'active' ||
      task.stageId !== fromStageId ||
      (task.assignee && !assigned)
    )
      return false;
    if (openPrerequisites(task, tasks).length > 0) return false;
    if (startBlock(task, config) !== null) return false;
    const evaluation = evaluateStart(task, config, toStageId);
    return evaluation.unmet.length === 0 && evaluation.approvals.length === 0;
  });
}
