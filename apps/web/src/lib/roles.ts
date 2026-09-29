import { holdersAllow, isBuiltInRole } from '@projectman/shared';
import type { BuiltInRoleId, RoleView as CatalogueRole } from '@projectman/shared';
import type { IconName } from '../components/Icon';
import { tDynamic } from '../i18n/t';

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

export interface StyledRole extends CatalogueRole {
  tone: RoleTone;
  icon: IconName;
}

const visuals: Record<BuiltInRoleId, { tone: RoleTone; icon: IconName }> = {
  developer: { tone: 'developer', icon: 'branch' },
  code_review: { tone: 'review', icon: 'code' },
  security_review: { tone: 'security', icon: 'shield' },
  qa: { tone: 'qa', icon: 'flask' },
  devops: { tone: 'devops', icon: 'server' },
  communication: { tone: 'comm', icon: 'mail' },
  project_manager: { tone: 'pm', icon: 'calendar' },
  docs: { tone: 'docs', icon: 'doc' },
  operator: { tone: 'owner', icon: 'user' },
  product_owner: { tone: 'human', icon: 'team' },
  business_analyst: { tone: 'pm', icon: 'doc' },
  architect: { tone: 'developer', icon: 'branch' },
  designer: { tone: 'frontend', icon: 'sparkle' },
  support: { tone: 'comm', icon: 'messages' },
  researcher: { tone: 'review', icon: 'search' },
  maintainer: { tone: 'devops', icon: 'settings' },
  coach: { tone: 'pm', icon: 'team' },
  watchdog: { tone: 'scheduled', icon: 'timer' },
  content: { tone: 'docs', icon: 'doc' },
  translator: { tone: 'comm', icon: 'messages' },
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

/** Catalogue texts stay in the project's language; visuals are local. */
export function roleView(role: CatalogueRole, specialty?: string | null): StyledRole {
  const kind = isDeveloperRole(role.id) ? specialtyKind(specialty) : null;
  const visual = isBuiltInRole(role.id)
    ? visuals[role.id]
    : { tone: 'system' as const, icon: 'sparkle' as const };
  return { ...role, tone: kind ?? visual.tone, icon: visual.icon };
}

export function aiRoleView(
  roleId: string,
  specialty?: string | null,
  catalogue: readonly CatalogueRole[] = [],
): StyledRole {
  return roleView(
    catalogue.find((role) => role.id === roleId) ?? {
      id: roleId,
      name: roleId,
      summary: '',
      notTheirJob: '',
      holders: 'both',
      builtIn: false,
    },
    specialty,
  );
}

/** Access level of a human ("Tulajdonos", "Megrendelő", ...). */
export function humanRoleName(access: string): string {
  return tDynamic(`roles.human.${access}`, access);
}

/** Built-in and custom roles whose holders allow AI. */
export function hireableRoles(catalogue: readonly CatalogueRole[]): StyledRole[] {
  return catalogue.filter((role) => holdersAllow(role.holders, 'ai')).map((role) => roleView(role));
}
