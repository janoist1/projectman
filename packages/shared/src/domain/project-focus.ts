import { z } from 'zod';
import { dutyMembers } from '../config/duties';
import { evaluateStart, stageIndex } from '../config/gates';
import { ownerHandles } from '../config/lookup';
import { developmentStage } from '../config/refinement';
import type { ProjectConfig } from '../config/schema';
import { startBlock } from '../config/start-block';
import { compareBoardOrder } from './board-order';
import { Actor } from './event';
import { openPrerequisites } from './relations';
import { canAutomaticallyStartTask, isOpenTask, isTheme, TaskKey } from './task';
import type { Task } from './task';
import type { Stage } from './pipeline';

/**
 * The project's focus (PM-427): one ordered list per project of themes and cards the team works on now.
 * An item covers what it names while it is open (see `projectFocusPlaces`); the place is the 1-based
 * position in the list. Only people the project trusts with priorities set it.
 */

export const PROJECT_FOCUS_MAX_ITEMS = 20;

export const ProjectFocusItem = z.object({
  /** The theme or card. */
  key: TaskKey,
  addedAt: z.string(),
  addedBy: Actor,
});
export type ProjectFocusItem = z.infer<typeof ProjectFocusItem>;

export const ProjectFocus = z.object({
  /** In order: `[0]` is the 1st place. */
  items: z.array(ProjectFocusItem).max(PROJECT_FOCUS_MAX_ITEMS),
});
export type ProjectFocus = z.infer<typeof ProjectFocus>;

/** `canEdit`: whether the viewer may change the focus (`projectFocusRefusal` is null). */
export const ProjectFocusView = ProjectFocus.extend({ canEdit: z.boolean() });
export type ProjectFocusView = z.infer<typeof ProjectFocusView>;

/** A card's place: 1-based; `via` is the item that covers it, when the card is not the item itself. */
export const FocusPlace = z.object({ position: z.number().int().min(1), via: TaskKey.optional() });
export type FocusPlace = z.infer<typeof FocusPlace>;

export type ProjectFocusRefusal = 'focus_humans_only' | 'focus_not_allowed';

/**
 * Why the actor may not set the project's focus, or null when they may: only a person (the integrator's
 * owner too) who owns the project or holds the prioritization duty. No approval is needed.
 */
export function projectFocusRefusal(
  config: Pick<ProjectConfig, 'team'>,
  actor: Pick<Actor, 'kind' | 'handle' | 'via'>,
): ProjectFocusRefusal | null {
  if (actor.kind !== 'human') return 'focus_humans_only';
  const handle = actor.handle;
  if (!handle) return 'focus_not_allowed';
  if (ownerHandles(config).includes(handle)) return null;
  return dutyMembers(config, 'prioritization').some((m) => m.handle === handle) ? null : 'focus_not_allowed';
}

type PlaceTask = Pick<Task, 'key' | 'kind' | 'status' | 'parentKey' | 'themeKey'>;

/**
 * Key -> place of every open card and theme the focus covers. An item covers itself and, when it is
 * a card, its subtasks (`parentKey`); when it is a theme, every card whose `themeKey` it is, with their
 * subtasks (a subtask reads its parent's theme). A closed item covers nothing, and a closed card has no
 * place. A card several items cover gets the smallest place. Closed items still count in the numbering.
 */
export function projectFocusPlaces(
  items: readonly Pick<ProjectFocusItem, 'key'>[],
  tasks: readonly PlaceTask[],
): Map<string, FocusPlace> {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const places = new Map<string, FocusPlace>();
  const place = (key: string, position: number, via: string) => {
    if (!places.has(key)) places.set(key, via === key ? { position } : { position, via });
  };
  items.forEach((item, index) => {
    const root = byKey.get(item.key);
    if (!root || !isOpenTask(root)) return;
    const position = index + 1;
    place(root.key, position, root.key);
    for (const task of tasks) {
      if (task.key === root.key || !isOpenTask(task)) continue;
      // A subtask reads its parent's theme, so one whose theme is not filled in yet is looked up there.
      const themeOf = task.themeKey ?? (task.parentKey ? byKey.get(task.parentKey)?.themeKey : null);
      const covered = isTheme(root) ? !isTheme(task) && themeOf === root.key : task.parentKey === root.key;
      if (covered) place(task.key, position, root.key);
    }
  });
  return places;
}

/**
 * How a start of a card ranks among the waiting ones (PM-427): `urgent` first, then the cards the focus
 * covers by their place, then `other`.
 */
export type StartClass = { kind: 'urgent' } | { kind: 'focus'; position: number } | { kind: 'other' };

/**
 * The class of a start: `urgent` for an open card whose priority is urgent, `focus` for one with a place
 * in `places`, else `other`. A start with no card (`null`) is `other`.
 */
export function startClass(task: Task | null, places: ReadonlyMap<string, FocusPlace>): StartClass {
  if (!task || !isOpenTask(task)) return { kind: 'other' };
  if (task.priority === 'urgent') return { kind: 'urgent' };
  const place = places.get(task.key);
  return place ? { kind: 'focus', position: place.position } : { kind: 'other' };
}

const CLASS_RANK = { urgent: 0, focus: 1, other: 2 } as const;

/** Urgent before focus (the smaller place first) before other; 0 within the same class. */
export function compareStartClass(a: StartClass, b: StartClass): number {
  const byKind = CLASS_RANK[a.kind] - CLASS_RANK[b.kind];
  if (byKind !== 0) return byKind;
  return a.kind === 'focus' && b.kind === 'focus' ? a.position - b.position : 0;
}

/**
 * The stage cards are pulled from (PM-427): the step before the development stage, when it is a queue;
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
 * The cards that may be pulled into development, in order: the urgent ones in board order, then the
 * focus cards by place (the board order within one place). A card is a candidate when it is an active card
 * (not a theme or a collector with open subtasks) in the source stage with no assignee and no open
 * prerequisite, its start is not blocked (`startBlock`: not being refined, no holding label, no approval pending) and the gates on the way
 * ask for nothing more: no missing label and no approval to request.
 */
export function pullCandidates(input: {
  config: ProjectConfig;
  tasks: readonly Task[];
  places: ReadonlyMap<string, FocusPlace>;
}): Task[] {
  const { config, tasks, places } = input;
  const source = pullSourceStage(config);
  const development = developmentStage(config);
  if (!source || !development) return [];
  const ranked = (task: Task) => ({ key: task.key, rank: task.boardRank, updatedAt: task.updatedAt });
  const candidates: { task: Task; class: StartClass }[] = [];
  for (const task of tasks) {
    if (
      !canAutomaticallyStartTask(task, tasks) ||
      task.status !== 'active' ||
      task.stageId !== source.id ||
      task.assignee
    )
      continue;
    const cls = startClass(task, places);
    if (cls.kind === 'other') continue;
    if (openPrerequisites(task, tasks).length > 0) continue;
    if (startBlock(task, config) !== null) continue;
    const evaluation = evaluateStart(task, config, development.id);
    if (evaluation.unmet.length > 0 || evaluation.approvals.length > 0) continue;
    candidates.push({ task, class: cls });
  }
  return candidates
    .sort((a, b) => compareStartClass(a.class, b.class) || compareBoardOrder(ranked(a.task), ranked(b.task)))
    .map((candidate) => candidate.task);
}
