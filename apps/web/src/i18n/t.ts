import { hu } from './hu';

/**
 * Type-safe translation. Keys are dot paths into `hu` ("board.filters.all"); placeholders
 * in the message ("{count} napja") become required params. Missing keys fail the
 * typecheck, so every key used in the code exists in the locale file.
 */

export type Messages = typeof hu;

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

type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never;

export type MessageParams<K extends MessageKey> = Placeholders<ValueAt<Messages, K>>;

export type TranslateArgs<K extends MessageKey> = [MessageParams<K>] extends [never]
  ? []
  : [params: Record<MessageParams<K>, string | number>];

/** Keys whose message has no placeholders (safe to store in lookup tables). */
export type PlainMessageKey = {
  [K in MessageKey]: [MessageParams<K>] extends [never] ? K : never;
}[MessageKey];

function resolve(key: string): string | undefined {
  let node: unknown = hu;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, params: Record<string, string | number> | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
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

/** Joins alternatives the Hungarian way: "a, b vagy c" (whoever of them may do it). */
export function joinAlternatives(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  const head = names.slice(0, -1).join(t('common.listSeparator'));
  return `${head}${t('common.or')}${names[names.length - 1]}`;
}

/** Joins names the Hungarian way: "a, b és c". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  const head = names.slice(0, -1).join(t('common.listSeparator'));
  return `${head}${t('common.and')}${names[names.length - 1]}`;
}
