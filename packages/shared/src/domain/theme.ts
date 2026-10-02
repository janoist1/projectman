import { isOpenTask, isTheme, taskSeq } from './task';
import type { Task, TaskKey } from './task';

/**
 * Themes (PM-192): a theme is a card of kind `theme` that groups other cards. Any card that is not a
 * theme (a collecting card too) belongs to at most one theme; its subtasks read their parent's theme
 * (`Task.themeKey`), so a collecting card changing theme moves its subtasks with it and nothing is
 * written to them. This module decides what may be stored and turns the stored form into what a theme
 * shows.
 */

/** Why a card may not be given a theme: codes of the shared error list. */
export type ThemeRefusal =
  | 'theme_on_theme'
  | 'theme_on_subtask'
  | 'theme_not_found'
  | 'theme_project'
  | 'theme_not_a_theme'
  | 'theme_closed';

/**
 * Why `card` may not be put into the theme stored under `themeKey`, or null when it may:
 * - the card is not a theme and not a subtask (a subtask gets its parent's theme, never its own);
 * - the theme exists, in the same project, is a theme, and is open (a closed theme takes no new card;
 *   what already belongs to it stays). `theme` is the card stored under `themeKey`.
 */
export function themeRefusal(
  theme: Pick<Task, 'projectKey' | 'kind' | 'status'> | null | undefined,
  card: Pick<Task, 'projectKey' | 'kind' | 'parentKey'>,
): ThemeRefusal | null {
  if (isTheme(card)) return 'theme_on_theme';
  if (card.parentKey) return 'theme_on_subtask';
  if (!theme) return 'theme_not_found';
  if (theme.projectKey !== card.projectKey) return 'theme_project';
  if (!isTheme(theme)) return 'theme_not_a_theme';
  if (!isOpenTask(theme)) return 'theme_closed';
  return null;
}

/** What a theme lists of a card. */
export type ThemeCardView = Pick<Task, 'key' | 'title' | 'stageId' | 'status'>;

/** A card of a theme with its subtasks, which belong to the theme through it. */
export interface ThemeCard extends ThemeCardView {
  subtasks: ThemeCardView[];
}

type ThemeInput = Pick<Task, 'key' | 'title' | 'stageId' | 'status' | 'kind' | 'parentKey' | 'themeKey'>;

function view(card: ThemeInput): ThemeCardView {
  return { key: card.key, title: card.title, stageId: card.stageId, status: card.status };
}

function bySeq(a: { key: string }, b: { key: string }): number {
  return taskSeq(a.key) - taskSeq(b.key);
}

/**
 * The cards of the theme `themeKey`, collecting cards with their subtasks, by number. Membership is
 * the computed theme (`Task.themeKey`), so the input must be cards as they are read; a subtask is
 * listed under its parent, and on its own when its parent is not among `tasks` (a viewer may not see it).
 */
export function themeCards(themeKey: TaskKey, tasks: readonly ThemeInput[]): ThemeCard[] {
  const members = tasks.filter((card) => card.themeKey === themeKey && !isTheme(card));
  const keys = new Set(members.map((card) => card.key));
  const top = members.filter((card) => !card.parentKey || !keys.has(card.parentKey)).sort(bySeq);
  return top.map((card) => ({
    ...view(card),
    subtasks: members
      .filter((child) => child.parentKey === card.key)
      .sort(bySeq)
      .map(view),
  }));
}

/** How far a theme is: `done` of `total` cards, the cancelled ones not counted at all. */
export interface ThemeProgress {
  done: number;
  total: number;
}

/**
 * The progress of a theme: every card that belongs to it (collecting cards and subtasks alike, by the
 * computed theme), without the cancelled ones; done are those with status `done`.
 */
export function themeProgress(themeKey: TaskKey, tasks: readonly ThemeInput[]): ThemeProgress {
  const counted = tasks.filter(
    (card) => card.themeKey === themeKey && !isTheme(card) && card.status !== 'cancelled',
  );
  return { done: counted.filter((card) => card.status === 'done').length, total: counted.length };
}
