import { isBuiltInRole, roleBundle } from '@projectman/shared';
import type { DutyId, PatchConfigRequest, ProjectConfig } from '@projectman/shared';
import type { getLocale } from '@projectman/templates';

type Locale = ReturnType<typeof getLocale>;

/** The texts of a role the matrix edits; the first three have a default text in the language. */
export type RoleTextField = 'summary' | 'notTheirJob' | 'whenToAsk' | 'instructions';

/** The part of the configuration a roles save sends. */
export function rolesBody(
  config: ProjectConfig,
  baseVersion: string,
  teamSetting: boolean,
): PatchConfigRequest {
  return {
    baseVersion,
    roleOverrides: config.team.roleOverrides ?? {},
    roles: config.team.roles,
    releaseFourEyes: teamSetting,
  };
}

/** Changes one role's bundle in `config` (a built-in role gets an override, a custom role is edited in place). */
function editRole(
  config: ProjectConfig,
  role: string,
  update: (bundle: ReturnType<typeof roleBundle>) => void,
): void {
  const bundle = structuredClone(roleBundle(config, role));
  update(bundle);
  if (isBuiltInRole(role)) (config.team.roleOverrides ??= {})[role] = bundle;
  else
    Object.assign(
      config.team.roles.find((entry) => entry.id === role)!,
      bundle,
    );
}

/** Drops a built-in role's own settings, so its defaults apply again. */
export function resetRole(config: ProjectConfig, role: string): void {
  if (isBuiltInRole(role) && config.team.roleOverrides) delete config.team.roleOverrides[role];
}

/** Turns one duty of a role on or off. */
export function toggleDuty(config: ProjectConfig, role: string, duty: DutyId): void {
  editRole(config, role, (bundle) => {
    bundle.duties = bundle.duties.includes(duty)
      ? bundle.duties.filter((id) => id !== duty)
      : [...bundle.duties, duty];
  });
}

/** A built-in role shows its default text until the project writes its own. */
export function roleText(config: ProjectConfig, role: string, field: RoleTextField, locale: Locale): string {
  if (field === 'instructions') return roleBundle(config, role).instructions;
  return isBuiltInRole(role)
    ? (config.team.roleOverrides?.[role]?.[field] ?? locale.roles[role][field])
    : (config.team.roles.find((entry) => entry.id === role)?.[field] ?? '');
}

/** `config` with one text of a role written; a built-in role's text equal to the default is not stored. */
export function withRoleText(
  config: ProjectConfig,
  role: string,
  field: RoleTextField,
  value: string,
  locale: Locale,
): ProjectConfig {
  const next = structuredClone(config);
  if (!isBuiltInRole(role)) {
    const custom = next.team.roles.find((entry) => entry.id === role);
    if (custom) custom[field] = value;
    return next;
  }
  editRole(next, role, (bundle) => {
    if (field !== 'instructions' && value === locale.roles[role][field]) delete bundle[field];
    else bundle[field] = value;
  });
  return next;
}
