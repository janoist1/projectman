import { roleBundle, DEFAULT_PERMISSION_LEVEL, DEFAULT_PROVIDER_MODELS, DUTIES } from '@projectman/shared';
import { aiMemberDefaults } from '@projectman/templates';
import type { AiMemberConfig, PermissionLevel, RoleId, ProjectConfig } from '@projectman/shared';

/**
 * Defaults shown in the preview. There is no role-template endpoint yet, so the preview
 * mirrors an existing member with the same role (the server applies the real defaults).
 */
export function previewFor(
  role: RoleId,
  specialty: string,
  config: ProjectConfig | undefined,
): Pick<AiMemberConfig, 'model' | 'capacity' | 'instructions'> & { permissionLevel: PermissionLevel } {
  const ai = (config?.team.members ?? []).filter(
    (member): member is AiMemberConfig => member.kind === 'ai' && member.role === role,
  );
  const wanted = specialty.trim().toLowerCase();
  const match = ai.find((member) => wanted && member.specialty?.toLowerCase().includes(wanted)) ?? ai[0];
  return {
    model: match?.model ?? DEFAULT_PROVIDER_MODELS.claude,
    // The server gives every new member the same level, whatever the role or provider.
    permissionLevel:
      (config && aiMemberDefaults(role, config.team.roles, config.team.roleOverrides)?.permissionLevel) ||
      DEFAULT_PERMISSION_LEVEL,
    capacity: match?.capacity ?? 1,
    instructions: config
      ? [
          ...roleBundle(config, role).duties.map((id) => DUTIES[id].prompt),
          roleBundle(config, role).instructions,
        ]
          .filter(Boolean)
          .join('\n\n')
      : '',
  };
}
