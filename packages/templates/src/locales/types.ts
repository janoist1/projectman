import type { AiRole } from '@projectman/shared';

/** Board column keys used by the factory templates (also used as column ids). */
export type ColumnKey =
  | 'ready'
  | 'development'
  | 'in_progress'
  | 'review'
  | 'client_test'
  | 'awaiting_merge'
  | 'awaiting_release'
  | 'done';

/** Stage keys used by the factory templates (also used as stage ids). */
export type StageKey =
  | 'ready'
  | 'dev'
  | 'work'
  | 'code_review'
  | 'integration'
  | 'qa'
  | 'client_test'
  | 'merge'
  | 'release'
  | 'done';

export type SpecialtyKey = 'frontend' | 'backend';

export type TemplateId = 'web-client-project' | 'small-team' | 'internal-tool' | 'daily-routine';

/**
 * Default display names a template writes into a new project's configuration. After that
 * they are ordinary configuration data the team may rename.
 */
export interface TemplateLocale {
  /** Primary language subtag (BCP 47), e.g. "hu". */
  language: string;
  columns: Record<ColumnKey, { name: string; hint: string }>;
  stages: Record<StageKey, string>;
  /** Default display name of an AI member hired for the role. */
  roles: Record<AiRole, string>;
  specialties: Record<SpecialtyKey, string>;
  templates: Record<TemplateId, { name: string; description: string }>;
  /** Display name of a specialist, e.g. ("Frontend", "Developer") -> "Frontend developer". */
  specialist(specialty: string, roleName: string): string;
}

/**
 * Lowercases the first word of a role name when it is an ordinary capitalised word, so it
 * can follow a specialty ("Developer" -> "developer"); acronyms ("QA", "DevOps") stay.
 */
export function lowerFirstWord(name: string): string {
  const [first = '', ...rest] = name.split(' ');
  if (!/^\p{Lu}\p{Ll}*$/u.test(first)) return name;
  return [first.toLowerCase(), ...rest].join(' ');
}
