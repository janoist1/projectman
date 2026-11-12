import {
  compareThemes,
  isArchivedTheme,
  isOpenTask,
  isTheme,
  taskSeq,
  themeCards,
  themeProgress,
} from '@projectman/shared';
import type { BoardCard, Task, ThemeCard, ThemeCardView, ThemeProgress } from '@projectman/shared';
import { columnSegments } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';

/**
 * The themes of the project in three groups, each by priority and number (`compareThemes`, PM-1283): the
 * open ones that are not archived, the closed ones that are not archived, and the archived ones.
 */
export function themeGroups(tasks: readonly BoardCard[]): {
  open: BoardCard[];
  closed: BoardCard[];
  archived: BoardCard[];
} {
  const themes = tasks.filter((task) => isTheme(task)).sort(compareThemes);
  return {
    open: themes.filter((theme) => !isArchivedTheme(theme) && isOpenTask(theme)),
    closed: themes.filter((theme) => !isArchivedTheme(theme) && !isOpenTask(theme)),
    archived: themes.filter((theme) => isArchivedTheme(theme)),
  };
}

/** Every theme of the project: the open ones first, then the closed, then the archived. */
export function sortedThemes(tasks: readonly BoardCard[]): BoardCard[] {
  const { open, closed, archived } = themeGroups(tasks);
  return [...open, ...closed, ...archived];
}

/** The themes a card can be put into: the open ones that are not archived. */
export function openThemes(tasks: readonly BoardCard[]): BoardCard[] {
  return themeGroups(tasks).open;
}

export function progressOf(theme: Pick<Task, 'key'>, tasks: readonly BoardCard[]): ThemeProgress {
  return themeProgress(theme.key, tasks);
}

/** Count the same cards as themeProgress, grouped in board column order. */
export function columnProgressOf(
  theme: Pick<Task, 'key'>,
  tasks: readonly BoardCard[],
  pipeline: PipelineIndex,
) {
  const byStage: Record<string, number> = {};
  for (const card of themeCards(theme.key, tasks).flatMap((card) => [card, ...card.subtasks])) {
    if (card.status === 'cancelled') continue;
    byStage[card.stageId] = (byStage[card.stageId] ?? 0) + 1;
  }
  return columnSegments(byStage, pipeline);
}

export function percentOf(progress: ThemeProgress): number {
  return progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
}

/** Cancelled cards of a theme: they are listed but do not count towards its progress. */
export function cancelledIn(theme: Pick<Task, 'key'>, tasks: readonly BoardCard[]): number {
  return tasks.filter((task) => !isTheme(task) && task.themeKey === theme.key && task.status === 'cancelled')
    .length;
}

function closed(card: Pick<ThemeCardView, 'status'>): number {
  return card.status === 'done' || card.status === 'cancelled' ? 1 : 0;
}

/** The cards of a theme as a tree (collecting cards with their subtasks), the open ones first. */
export function themeTree(theme: Pick<Task, 'key'>, tasks: readonly BoardCard[]): ThemeCard[] {
  const byOpen = <T extends Pick<ThemeCardView, 'status' | 'key'>>(a: T, b: T) =>
    closed(a) - closed(b) || taskSeq(a.key) - taskSeq(b.key);
  return themeCards(theme.key, tasks)
    .map((card) => ({ ...card, subtasks: [...card.subtasks].sort(byOpen) }))
    .sort(byOpen);
}
