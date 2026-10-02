import { isOpenTask, isTheme, taskSeq, themeCards, themeProgress } from '@projectman/shared';
import type { Task, ThemeCard, ThemeCardView, ThemeProgress } from '@projectman/shared';

/** The themes of the project: the open ones first, each group by number. */
export function sortedThemes(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((task) => isTheme(task))
    .sort((a, b) => Number(!isOpenTask(a)) - Number(!isOpenTask(b)) || taskSeq(a.key) - taskSeq(b.key));
}

/** The themes a card can be put into: the open ones. */
export function openThemes(tasks: readonly Task[]): Task[] {
  return sortedThemes(tasks).filter((theme) => isOpenTask(theme));
}

export function progressOf(theme: Pick<Task, 'key'>, tasks: readonly Task[]): ThemeProgress {
  return themeProgress(theme.key, tasks);
}

export function percentOf(progress: ThemeProgress): number {
  return progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
}

/** Cancelled cards of a theme: they are listed but do not count towards its progress. */
export function cancelledIn(theme: Pick<Task, 'key'>, tasks: readonly Task[]): number {
  return tasks.filter((task) => !isTheme(task) && task.themeKey === theme.key && task.status === 'cancelled')
    .length;
}

function closed(card: Pick<ThemeCardView, 'status'>): number {
  return card.status === 'done' || card.status === 'cancelled' ? 1 : 0;
}

/** The cards of a theme as a tree (collecting cards with their subtasks), the open ones first. */
export function themeTree(theme: Pick<Task, 'key'>, tasks: readonly Task[]): ThemeCard[] {
  const byOpen = <T extends Pick<ThemeCardView, 'status' | 'key'>>(a: T, b: T) =>
    closed(a) - closed(b) || taskSeq(a.key) - taskSeq(b.key);
  return themeCards(theme.key, tasks)
    .map((card) => ({ ...card, subtasks: [...card.subtasks].sort(byOpen) }))
    .sort(byOpen);
}
