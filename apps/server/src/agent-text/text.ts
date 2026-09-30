/**
 * How a renderer quotes and names things. The context pack writes markdown with names
 * ("`fe-1`", "Code review", "`qa-ok` (QA ok)"); team tool results use plain ids.
 */
export interface TextStyle {
  /** Quotes a handle or a branch, e.g. as inline code. */
  code(value: string): string;
  /** Display form of a stage id, e.g. its name. */
  stage(id: string): string;
  /** Display form of a label id, e.g. with its name. */
  label(id: string): string;
}

/** Plain ids, nothing quoted. */
export const PLAIN_STYLE: TextStyle = {
  code: (value) => value,
  stage: (id) => id,
  label: (id) => id,
};

/** Shortens text to `max` characters (code points, so emoji stay whole), ending cut text with "…". */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : text;
}

/** Collapses whitespace to single spaces and shortens the text to `max` characters. */
export function oneLine(text: string, max: number): string {
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

/** "2026-09-29 14:05 UTC" (independent of the server's time zone); the input if it is not a date. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = date.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}
