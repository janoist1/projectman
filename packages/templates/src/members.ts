import { isBuiltInRole, type BuiltInRoleId, type CustomRoleDefinition } from '@projectman/shared';
import { getLocale } from './locales';

/**
 * Name of a role in the project's language: the built-in role's name from the locale, or the
 * custom role's own name (custom texts are written in the project's language). The id itself
 * when the role is unknown.
 */
export function roleName(
  role: string,
  language: string,
  customRoles: readonly Pick<CustomRoleDefinition, 'id' | 'name'>[] = [],
): string {
  if (isBuiltInRole(role)) return getLocale(language).roles[role].name;
  return customRoles.find((r) => r.id === role)?.name ?? role;
}

/**
 * Default display name for the index-th (1-based) member of a role, in the project's
 * language, e.g. "Developer", "Developer 2", or with a specialty "Frontend developer".
 * Custom roles are named after their definition in `customRoles`.
 */
export function defaultMemberName(
  role: string,
  language: string,
  index: number,
  opts: { specialty?: string; customRoles?: readonly Pick<CustomRoleDefinition, 'id' | 'name'>[] } = {},
): string {
  const locale = getLocale(language);
  const name = roleName(role, language, opts.customRoles);
  const specialty = opts.specialty?.trim();
  const base = specialty ? locale.specialist(specialty, name) : name;
  return index > 1 ? `${base} ${index}` : base;
}

/** Handle stems per built-in role; developers get numbered handles (fe-1, be-1, dev-1). */
const ROLE_HANDLES: Record<Exclude<BuiltInRoleId, 'developer'>, string> = {
  operator: 'operator',
  product_owner: 'po',
  project_manager: 'pm',
  business_analyst: 'analyst',
  architect: 'architect',
  designer: 'designer',
  code_review: 'code-review',
  security_review: 'security',
  qa: 'qa',
  devops: 'devops',
  communication: 'communication',
  support: 'support',
  researcher: 'researcher',
  maintainer: 'maintainer',
  coach: 'coach',
  watchdog: 'watchdog',
  content: 'content',
  translator: 'translator',
  docs: 'docs',
};

const SPECIALTY_HANDLES: Record<string, string> = { frontend: 'fe', backend: 'be' };

/** Handles are at most 32 characters; the stem leaves room for a "-NN" suffix. */
const MAX_STEM_LENGTH = 28;

/** Handle stem of a role: its built-in stem, or the custom role id ("data_steward" -> "data-steward"). */
export function roleHandleStem(role: string): string {
  if (isBuiltInRole(role)) return role === 'developer' ? 'dev' : ROLE_HANDLES[role];
  return role.replace(/_/g, '-').slice(0, MAX_STEM_LENGTH).replace(/-+$/, '');
}

/**
 * A readable handle for a new AI member that is not in `taken`: "qa", "code-review",
 * "fe-1", "dev-2", "data-steward"; a taken standing-role handle gets a suffix ("qa-2").
 */
export function defaultMemberHandle(role: string, taken: Iterable<string>, specialty?: string): string {
  const used = new Set(taken);
  if (role === 'developer') {
    const stem = SPECIALTY_HANDLES[specialty?.trim().toLowerCase() ?? ''] ?? 'dev';
    for (let n = 1; ; n++) {
      if (!used.has(`${stem}-${n}`)) return `${stem}-${n}`;
    }
  }
  return uniqueHandle(roleHandleStem(role), used);
}

/** `base` if free, otherwise the first free "base-2", "base-3", ... */
export function uniqueHandle(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

/**
 * A handle for a new human member, from their name without diacritics ("Zoe Smith" ->
 * "zoe-smith"), not in `taken`. Pass past members' handles too: a handle never reuses a former
 * member's identity.
 */
export function humanMemberHandle(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'member';
  return uniqueHandle(base, taken);
}
