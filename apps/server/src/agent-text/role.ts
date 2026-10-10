import { isBuiltInRole } from '@projectman/shared';
import type { BuiltInRoleId, CustomRoleDefinition } from '@projectman/shared';

/** English names of the built-in roles for prompt text. */
const ROLE_LABELS: Record<BuiltInRoleId, string> = {
  operator: 'owner',
  ai_operator: 'operator',
  product_owner: 'product owner',
  project_manager: 'project manager',
  business_analyst: 'business analyst',
  architect: 'architect',
  designer: 'UI/UX designer',
  developer: 'developer',
  lead_developer: 'lead developer',
  code_review: 'code reviewer',
  security_review: 'security reviewer',
  qa: 'QA engineer',
  devops: 'DevOps engineer',
  communication: 'communication member',
  support: 'support member',
  researcher: 'researcher',
  maintainer: 'maintainer',
  coach: 'coach',
  watchdog: 'watchdog',
  content: 'content writer',
  translator: 'translator',
  docs: 'technical writer',
};

/**
 * A role for prompt text: the English name of a built-in role, a custom role's own name (in the
 * project's language), else the value as it is.
 */
export function roleLabel(
  role: string,
  customRoles: readonly Pick<CustomRoleDefinition, 'id' | 'name'>[] = [],
): string {
  if (isBuiltInRole(role)) return ROLE_LABELS[role];
  return customRoles.find((r) => r.id === role)?.name ?? role;
}
