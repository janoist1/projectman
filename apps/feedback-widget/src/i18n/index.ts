import { en } from './en';
import { hu } from './hu';
import type { TextKey } from './hu';

export type { TextKey };
export type WidgetLanguage = 'hu' | 'en';

const dictionaries: Record<WidgetLanguage, Record<TextKey, string>> = { hu, en };

let language: WidgetLanguage = 'hu';

/**
 * The widget's language: the embedding page's `<html lang>` decides, the browser's language only
 * when the page names none. Hungarian for `hu*`, English for everything else.
 */
export function widgetLanguage(
  htmlLang: string | undefined,
  navigatorLanguage: string | undefined,
): WidgetLanguage {
  const declared = htmlLang?.trim() ?? '';
  const chosen = declared !== '' ? declared : (navigatorLanguage ?? '');
  return /^hu(-|_|$)/i.test(chosen.trim()) ? 'hu' : 'en';
}

/** Chosen once, when the widget loads. */
export function setWidgetLanguage(next: WidgetLanguage): void {
  language = next;
}

export function currentLanguage(): WidgetLanguage {
  return language;
}

/** `{name}` is replaced by its parameter; `{name|one|other}` picks a plural form, `#` being the number. */
export function t(key: TextKey, params: Record<string, string | number> = {}): string {
  return dictionaries[language][key].replace(
    /\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g,
    (match, name: string, one: string | undefined, other: string | undefined) => {
      if (!(name in params)) return match;
      const value = params[name];
      if (one === undefined || other === undefined) return String(value);
      const form = new Intl.PluralRules(language).select(Number(value)) === 'one' ? one : other;
      return form.replace(/#/g, String(value));
    },
  );
}
