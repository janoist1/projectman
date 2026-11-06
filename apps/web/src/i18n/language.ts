import { DEFAULT_UI_LANGUAGE, UiLanguage } from '@projectman/shared';

/**
 * The UI language of this browser (PM-1168). It starts from the stored choice, otherwise English, and
 * changes without a reload: `App` reads it with `useSyncExternalStore` and remounts the routes.
 * Storage is kept here (not in `lib/hooks`) because `t()` depends on this module.
 */

const STORAGE_KEY = 'pm:language';

function readStored(): UiLanguage {
  try {
    const parsed = UiLanguage.safeParse(window.localStorage.getItem(STORAGE_KEY));
    return parsed.success ? parsed.data : DEFAULT_UI_LANGUAGE;
  } catch {
    return DEFAULT_UI_LANGUAGE;
  }
}

function writeStored(language: UiLanguage): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Storage can be unavailable (private mode); the next page then opens in English.
  }
}

let current: UiLanguage = readStored();
const listeners = new Set<() => void>();

export function currentLanguage(): UiLanguage {
  return current;
}

/** Sets the language and remembers it for the pages before login; does nothing when it already holds. */
export function setCurrentLanguage(language: UiLanguage): void {
  if (language === current) return;
  current = language;
  writeStored(language);
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  for (const listener of [...listeners]) listener();
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `<html lang>` follows the language from the first render on. */
if (typeof document !== 'undefined') document.documentElement.lang = current;
