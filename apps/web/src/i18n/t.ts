import { en } from './en';
import { hu } from './hu';
import { currentLanguage } from './language';

/**
 * Type-safe translation. Keys are dot paths into `hu` ("board.filters.all"); placeholders
 * in the message ("{count} napja") become required params. Missing keys fail the
 * typecheck, so every key used in the code exists in the locale file.
 *
 * `hu` is the source of the key set and the placeholder types; `en` must hold every one of its
 * keys (PM-1168), so the lookup never falls back to the other language.
 */

export type Messages = typeof hu;

/** The same tree as `T` with string leaves, so a locale can be checked against `hu` without its literals. */
export type LocaleShape<T> = { readonly [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]> };

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<Messages>;

type ValueAt<T, K extends string> = K extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? ValueAt<T[Head], Rest>
    : never
  : K extends keyof T
    ? T[K]
    : never;

/** `{name}` and the plural form `{count|# card|# cards}` (placeholder `count`) both name a placeholder. */
type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}`
  ? (Name extends `${infer Plain}|${string}` ? Plain : Name) | Placeholders<Rest>
  : never;

export type MessageParams<K extends MessageKey> = Placeholders<ValueAt<Messages, K>>;

export type TranslateArgs<K extends MessageKey> = [MessageParams<K>] extends [never]
  ? []
  : [params: Record<MessageParams<K>, string | number>];

/** Keys whose message has no placeholders (safe to store in lookup tables). */
export type PlainMessageKey = {
  [K in MessageKey]: [MessageParams<K>] extends [never] ? K : never;
}[MessageKey];

function lookup(catalog: unknown, key: string): string | undefined {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** The message in the current language. */
function resolve(key: string): string | undefined {
  return lookup(currentLanguage() === 'en' ? en : hu, key);
}

const pluralRules = new Map<string, Intl.PluralRules>();

function pluralForm(count: number, one: string, other: string): string {
  const language = currentLanguage();
  let rules = pluralRules.get(language);
  if (!rules) {
    rules = new Intl.PluralRules(language);
    pluralRules.set(language, rules);
  }
  return (rules.select(count) === 'one' ? one : other).replace(/#/g, String(count));
}

/**
 * Fills `{name}` and the plural form `{count|# card|# cards}` (the first form for the language's "one",
 * the second for every other number; `#` stands for the number; the forms hold no braces).
 */
function interpolate(template: string, params: Record<string, string | number> | undefined): string {
  if (!params) return template;
  return template.replace(
    /\{(\w+)(?:\|([^|{}]*)\|([^|{}]*))?\}/g,
    (match, name: string, one: string | undefined, other: string | undefined) => {
      if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
      const value = params[name]!;
      return one !== undefined && other !== undefined ? pluralForm(Number(value), one, other) : String(value);
    },
  );
}

export function t<K extends MessageKey>(key: K, ...args: TranslateArgs<K>): string {
  const template = resolve(key);
  if (template === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] missing message: ${key}`);
    return key;
  }
  return interpolate(template, args[0] as Record<string, string | number> | undefined);
}

/** True when `key` names a message (used for keys that arrive as data, e.g. template names). */
export function hasMessage(key: string): key is MessageKey {
  return resolve(key) !== undefined;
}

/**
 * Translates a key that is only known at runtime (e.g. `TemplateSummary.nameKey` from the
 * server); returns `fallback` when the locale has no such message.
 */
export function tDynamic(key: string, fallback: string, params?: Record<string, string | number>): string {
  const template = resolve(key);
  return template === undefined ? fallback : interpolate(template, params);
}

/** Joins alternatives with the language's words: "a, b vagy c" / "a, b or c" (whoever of them may do it). */
export function joinAlternatives(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  const head = names.slice(0, -1).join(t('common.listSeparator'));
  return `${head}${t('common.or')}${names[names.length - 1]}`;
}

/** Joins names with the language's words: "a, b és c" / "a, b and c". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  const head = names.slice(0, -1).join(t('common.listSeparator'));
  return `${head}${t('common.and')}${names[names.length - 1]}`;
}
