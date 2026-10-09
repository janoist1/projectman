import { z } from 'zod';
import { dutyMembers } from '../config/duties';
import { ownerHandles } from '../config/lookup';
import type { ProjectConfig } from '../config/schema';
import { Actor } from './event';
import { isOpenTask, isTheme, TaskKey } from './task';
import type { Task } from './task';

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
