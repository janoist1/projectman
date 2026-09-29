import { AiRole } from '@projectman/shared';
import type { IconName } from '../components/Icon';
import { t, tDynamic } from '../i18n/t';

/**
 * Everything the UI shows about a role lives here: name, tagline, colour family and icon.
 * Roles are expected to become an open, server-provided catalogue
 * (GET /api/projects/:key/roles); when that lands, only this module should change.
 */

/** Colour family of a member (maps to --role-* tokens through data-tone). */
export type RoleTone =
  | 'devops'
  | 'review'
  | 'qa'
  | 'comm'
  | 'pm'
  | 'frontend'
  | 'backend'
  | 'developer'
  | 'security'
  | 'docs'
  | 'scheduled'
  | 'human'
  | 'owner'
  | 'system';

export interface RoleView {
  id: string;
  name: string;
  tagline: string;
  tone: RoleTone;
  icon: IconName;
}

const visuals: Record<string, { tone: RoleTone; icon: IconName }> = {
  developer: { tone: 'developer', icon: 'branch' },
  code_review: { tone: 'review', icon: 'code' },
  security_review: { tone: 'security', icon: 'shield' },
  qa: { tone: 'qa', icon: 'flask' },
  devops: { tone: 'devops', icon: 'server' },
  communication: { tone: 'comm', icon: 'mail' },
  project_manager: { tone: 'pm', icon: 'calendar' },
  docs: { tone: 'docs', icon: 'doc' },
  scheduled: { tone: 'scheduled', icon: 'timer' },
};

function specialtyKind(specialty: string | null | undefined): 'frontend' | 'backend' | null {
  const value = specialty?.toLowerCase() ?? '';
  if (value.includes('front')) return 'frontend';
  if (value.includes('back')) return 'backend';
  return null;
}

export function isDeveloperRole(roleId: string): boolean {
  return roleId === 'developer';
}

/** An AI role; developers with a frontend/backend specialty get their own name and colour. */
export function aiRoleView(roleId: string, specialty?: string | null): RoleView {
  const kind = isDeveloperRole(roleId) ? specialtyKind(specialty) : null;
  const visual = visuals[roleId] ?? { tone: 'developer', icon: 'sparkle' };
  return {
    id: roleId,
    name: kind ? t(`roles.specialties.${kind}`) : tDynamic(`roles.ai.${roleId}`, roleId),
    tagline: tDynamic(`roles.taglines.${roleId}`, ''),
    tone: kind ?? visual.tone,
    icon: visual.icon,
  };
}

/** Access level of a human ("Tulajdonos", "Megrendelő", ...). */
export function humanRoleName(access: string): string {
  return tDynamic(`roles.human.${access}`, access);
}

/** Roles an AI member can be hired into (the built-in list until the catalogue endpoint exists). */
export function hireableRoles(): RoleView[] {
  return AiRole.options.map((id) => aiRoleView(id));
}
