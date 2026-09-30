/** Reading loosely typed JSON (transcript entries, CLI answers) without trusting its shape. */

export type Json = Record<string, unknown>;

/** `value` when it is a plain object, else null. */
export function rec(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
}

/** `value` when it is a string, else null. */
export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** `value` when it is a finite number, else null. */
export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
