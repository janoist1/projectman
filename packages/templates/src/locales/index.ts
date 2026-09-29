import { en } from './en';
import { hu } from './hu';
import type { TemplateLocale } from './types';

export type { ColumnKey, SpecialtyKey, StageKey, TemplateId, TemplateLocale } from './types';
export { en, hu };

const locales: Record<string, TemplateLocale> = { en, hu };

/** Locale for a project language (BCP 47, e.g. "hu" or "hu-HU"); English when unknown. */
export function getLocale(language: string): TemplateLocale {
  const primary = language.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return locales[primary] ?? en;
}
