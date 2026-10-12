import { hu } from './hu';
import type { TextKey } from './hu';

export type { TextKey };

/** The text of `key` with every `{name}` replaced by its parameter. */
export function t(key: TextKey, params: Record<string, string | number> = {}): string {
  return hu[key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
