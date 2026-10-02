import { isOpenTask } from '@projectman/shared';
import type { Task, ThemeCard, ThemeProgress } from '@projectman/shared';
import { oneLine, PLAIN_STYLE, type TextStyle } from './text';

/** Longer card titles are shortened. */
const TITLE_LIMIT = 200;

/** A theme is open or closed, whatever status the card behind it has. */
export function themeState(theme: Pick<Task, 'status'>): 'open' | 'closed' {
  return isOpenTask(theme) ? 'open' : 'closed';
}

/** The theme a card belongs to: `PM-9 "Title" · Status: open`. */
export function describeTheme(
  theme: Pick<Task, 'key' | 'title' | 'status'>,
  style: Pick<TextStyle, 'code'> = PLAIN_STYLE,
): string {
  return `${style.code(theme.key)} "${oneLine(theme.title, TITLE_LIMIT)}" · Status: ${themeState(theme)}`;
}

/** How far a theme is: `3 of 7 cards done (cancelled cards are not counted)`. */
export function themeProgressText(progress: ThemeProgress): string {
  return `${progress.done} of ${progress.total} ${progress.total === 1 ? 'card' : 'cards'} done (cancelled cards are not counted)`;
}

/**
 * The cards of a theme, one line each with its subtasks under it. Empty without any card.
 */
export function themeCardLines(
  cards: readonly ThemeCard[],
  style: Pick<TextStyle, 'code' | 'stage'> = PLAIN_STYLE,
): string[] {
  const line = (card: Pick<Task, 'key' | 'title' | 'stageId' | 'status'>, indent: string) =>
    `${indent}- ${style.code(card.key)} "${oneLine(card.title, TITLE_LIMIT)}" · Stage: ${style.stage(card.stageId)} · Status: ${card.status}`;
  return cards.flatMap((card) => [line(card, ''), ...card.subtasks.map((subtask) => line(subtask, '  '))]);
}
