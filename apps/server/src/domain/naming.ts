import type { AiRole } from '@projectman/shared';
import * as templatesPackage from '@projectman/templates';

/**
 * Handles and display names for new AI members. The rules belong to @projectman/templates
 * (`defaultMemberHandle`, `defaultMemberName` with a specialty); when the installed
 * templates package provides them they are used, otherwise the same rules apply locally.
 */

export type MemberHandleFn = (role: AiRole, taken: Iterable<string>, specialty?: string) => string;
export type MemberNameFn = (role: AiRole, language: string, index: number, specialty?: string) => string;

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

/** `base` if free, otherwise the first free "base-2", "base-3", ... */
function uniqueHandle(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

function localDefaultMemberHandle(role: AiRole, taken: Iterable<string>, specialty?: string): string {
  const used = new Set(taken);
  if (role === 'developer') {
    const stem = SPECIALTY_HANDLES[specialty?.trim().toLowerCase() ?? ''] ?? 'dev';
    for (let n = 1; ; n++) {
      if (!used.has(`${stem}-${n}`)) return `${stem}-${n}`;
    }
  }
  return uniqueHandle(ROLE_HANDLES[role], used);
}

const fromPackage = templatesPackage as unknown as { defaultMemberHandle?: MemberHandleFn };

/** A readable handle not in `taken` ("dev-3", "fe-2", "qa-2"). Pass retired handles too: they are never reused. */
export const defaultMemberHandle: MemberHandleFn =
  fromPackage.defaultMemberHandle ?? localDefaultMemberHandle;

/** Default display name in the project's language ("Developer 2", "Frontend developer"). */
export const defaultMemberName = templatesPackage.defaultMemberName as MemberNameFn;
