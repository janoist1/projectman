import { UiStyle } from '@projectman/shared';
import { readStorage, writeStorage } from './hooks';

/** The style a user who has not chosen one gets: today's look (PM-363). */
const DEFAULT_UI_STYLE: UiStyle = 'classic';

const STORAGE_KEY = 'ui-style';

/** The style this browser remembers (it also shows on the login page); the default when none or unknown. */
export function storedUiStyle(): UiStyle {
  const parsed = UiStyle.safeParse(readStorage(STORAGE_KEY));
  return parsed.success ? parsed.data : DEFAULT_UI_STYLE;
}

/**
 * Switches the interface to this style at once: the attribute on <html> picks the token layer in the style sheets
 * (`styles/win311.css`), and the browser remembers the choice so the next load does not flash the other style.
 * `index.html` sets the attribute from the same storage key before the first paint.
 */
export function applyUiStyle(style: UiStyle): void {
  document.documentElement.dataset.style = style;
  writeStorage(STORAGE_KEY, style);
}
