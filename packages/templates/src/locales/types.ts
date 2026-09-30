import type { BuiltInRoleId, DutyId } from '@projectman/shared';

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

/** Members a template hires under a display name of their own (not the role's name). */
export type TemplateMemberKey = 'daily_worker';

/** Labels the templates may ship; rules live in ../labels.ts, words in the locales. */
export type StandardLabelId =
  | 'code-review-ok'
  | 'code-review-changes'
  | 'code-review-blocked'
  | 'security-ok'
  | 'security-changes'
  | 'qa-ok'
  | 'qa-failed'
  | 'qa-retest'
  | 'client-accepted'
  | 'client-changes'
  | 'pr-merged'
  | 'merge-approved'
  | 'release-approved'
  | 'waiting-answer';

export type TemplateId = 'web-client-project' | 'small-team' | 'internal-tool' | 'daily-routine';

/** How a built-in role is presented to people. */
export interface RoleText {
  /** Role name; also the default display name of an AI member hired for the role. */
  name: string;
  /** What the role does, one or two short sentences. */
  summary: string;
  /** What the role does not do (keeps roles apart). */
  notTheirJob: string;
}

/**
 * Default display names a template writes into a new project's configuration (after that
 * they are ordinary configuration data the team may rename), and the texts of the built-in
 * roles, duties and standard labels. Template names and descriptions are UI texts of the web
 * app (`TemplateSummary.nameKey` / `descriptionKey`).
 */
export interface TemplateLocale {
  /** Primary language subtag (BCP 47), e.g. "hu". */
  language: string;
  /** Time zone (IANA) of projects created in this language. */
  timezone: string;
  columns: Record<ColumnKey, { name: string; hint: string }>;
  stages: Record<StageKey, string>;
  duties: Record<DutyId, { name: string; description: string }>;
  roles: Record<BuiltInRoleId, RoleText>;
  members: Record<TemplateMemberKey, string>;
  specialties: Record<SpecialtyKey, string>;
  labels: Record<StandardLabelId, { name: string; meaning: string }>;
  /** Name of an approval label generated for a stage, e.g. "Merge: approved". */
  stageApproval: (stageName: string) => string;
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
