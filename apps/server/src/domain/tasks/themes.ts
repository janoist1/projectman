import { themeCards, themeProgress, themeRefusal } from '@projectman/shared';
import type { Actor, Task, ThemeCard, ThemeProgress, ThemeRefusal } from '@projectman/shared';
import { invalid } from '../errors';
import type { TaskStore } from './store';

/** Why a card may not be given a theme: the message of each refusal of the shared rule. */
export const THEME_REFUSALS: Record<ThemeRefusal, string> = {
  theme_on_theme: 'a theme cannot belong to a theme',
  theme_on_subtask: 'a subtask gets the theme of its parent: set the theme on the parent',
  theme_not_found: 'the theme does not exist',
  theme_project: 'the theme must belong to the same project',
  theme_not_a_theme: 'the card is not a theme',
  theme_closed: 'the theme is closed: reopen it, or choose another',
};

/** What a theme shows: the cards that belong to it, and how far it is. */
export interface ThemeView {
  cards: ThemeCard[];
  progress: ThemeProgress;
}

/**
 * Themes (PM-192): the rule is the shared `themeRefusal`; this part reads the theme as it is now,
 * records a change of theme on the timelines it concerns and reads what a theme lists. Only a card
 * that is not a subtask stores a theme; a subtask reads its parent's (see `db/tasks.ts`).
 */
export class TaskThemes {
  private readonly store: TaskStore;

  constructor(store: TaskStore) {
    this.store = store;
  }

  /**
   * Throws the refusal when `card` may not be put into the theme `themeKey`. `parentKey` is the card's
   * parent as the change will leave it (it may differ from the stored one), `kind` the card's kind.
   */
  require(
    themeKey: string,
    card: Pick<Task, 'projectKey' | 'kind'> & { parentKey?: string | null | undefined },
  ): void {
    const theme = this.store.ctx.repos.tasks.get(themeKey);
    const code = themeRefusal(theme, { ...card, parentKey: card.parentKey ?? null });
    if (code) throw invalid(code, THEME_REFUSALS[code], { themeKey });
  }

  /**
   * Records that `task` went from the theme `previous` to the theme `themeKey` (null: none) on its own
   * timeline and on the timeline of each theme: the one it left and the one it joined.
   */
  record(
    task: Pick<Task, 'projectKey' | 'key'>,
    previous: string | null,
    themeKey: string | null,
    actor: Actor,
    sessionId: string | null,
  ): void {
    if (previous === themeKey) return;
    for (const taskKey of new Set([task.key, previous, themeKey])) {
      if (!taskKey) continue;
      this.store.timeline.append({
        projectKey: task.projectKey,
        taskKey,
        sessionId,
        actor,
        type: 'task_theme_changed',
        data: { themeKey, previous },
      });
    }
  }

  /** Publishes the subtasks of a card and the themes it left or joined: what they show changed with it. */
  publishAround(task: Pick<Task, 'projectKey' | 'key'>, themes: ReadonlyArray<string | null>): void {
    const repo = this.store.ctx.repos.tasks;
    for (const child of repo.children(task.projectKey, task.key)) this.store.publish(child);
    for (const key of new Set(themes)) {
      const theme = key ? repo.get(key) : null;
      if (theme) this.store.publish(theme);
    }
  }

  /** The cards of a theme and its progress, from the cards of the project as they are read now. */
  of(theme: Task): ThemeView {
    const tasks = this.store.ctx.repos.tasks.list(theme.projectKey);
    return { cards: themeCards(theme.key, tasks), progress: themeProgress(theme.key, tasks) };
  }
}
