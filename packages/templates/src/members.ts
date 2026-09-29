import type { AiRole } from '@projectman/shared';
import { getLocale } from './locales';

/**
 * Default display name for the index-th (1-based) member of a role, in the project's
 * language, e.g. "Developer", "Developer 2", or with a specialty "Frontend developer".
 */
export function defaultMemberName(role: AiRole, language: string, index: number, specialty?: string): string {
  const locale = getLocale(language);
  const roleName = locale.roles[role];
  const trimmed = specialty?.trim();
  const base = trimmed ? locale.specialist(trimmed, roleName) : roleName;
  return index > 1 ? `${base} ${index}` : base;
}

/** Handle stems for standing roles; developers get numbered handles (fe-1, be-1, dev-1). */
const ROLE_HANDLES: Record<Exclude<AiRole, 'developer'>, string> = {
  code_review: 'code-review',
  security_review: 'security',
  qa: 'qa',
  devops: 'devops',
  communication: 'communication',
  project_manager: 'pm',
  docs: 'docs',
  scheduled: 'daily',
};

const SPECIALTY_HANDLES: Record<string, string> = { frontend: 'fe', backend: 'be' };

/**
 * A readable handle for a new AI member that is not in `taken`: "qa", "code-review",
 * "fe-1", "dev-2"; a taken standing-role handle gets a suffix ("qa-2").
 */
export function defaultMemberHandle(role: AiRole, taken: Iterable<string>, specialty?: string): string {
  const used = new Set(taken);
  if (role === 'developer') {
    const stem = SPECIALTY_HANDLES[specialty?.trim().toLowerCase() ?? ''] ?? 'dev';
    for (let n = 1; ; n++) {
      if (!used.has(`${stem}-${n}`)) return `${stem}-${n}`;
    }
  }
  return uniqueHandle(ROLE_HANDLES[role], used);
}

/** `base` if free, otherwise the first free "base-2", "base-3", ... */
export function uniqueHandle(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}
