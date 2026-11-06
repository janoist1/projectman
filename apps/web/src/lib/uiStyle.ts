import { UiStyle } from '@projectman/shared';
import { readStorage, writeStorage } from './hooks';

/** The style a user who has not chosen one gets: today's look (PM-363). */
export const DEFAULT_UI_STYLE: UiStyle = 'classic';

const STORAGE_KEY = 'ui-style';
/** The choice that has not reached the account yet (the save failed): kept so a reload does not lose it. */
const PENDING_KEY = 'ui-style-pending';

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

/** The style chosen on this device that the account does not have yet, or null. */
export function pendingUiStyle(): UiStyle | null {
  const parsed = UiStyle.safeParse(readStorage(PENDING_KEY));
  return parsed.success ? parsed.data : null;
}

/** Remembers a choice before it is saved on the account; the app saves it again at the next start or when online. */
export function markUiStylePending(style: UiStyle): void {
  writeStorage(PENDING_KEY, style);
}

/** The account has this style now: forgets the pending mark if it is the same (a newer choice stays pending). */
export function clearUiStylePending(saved: UiStyle): void {
  if (pendingUiStyle() === saved) writeStorage(PENDING_KEY, '');
}
