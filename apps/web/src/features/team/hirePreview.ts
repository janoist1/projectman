import type { AiMemberConfig, RoleId, ProjectConfig } from '@projectman/shared';

/**
 * Defaults shown in the preview. There is no role-template endpoint yet, so the preview
 * mirrors an existing member with the same role (the server applies the real defaults).
 */
export function previewFor(
  role: RoleId,
  specialty: string,
  config: ProjectConfig | undefined,
): Pick<AiMemberConfig, 'model' | 'permissionMode' | 'capacity' | 'instructions'> {
  const ai = (config?.team.members ?? []).filter(
    (member): member is AiMemberConfig => member.kind === 'ai' && member.role === role,
  );
  const wanted = specialty.trim().toLowerCase();
  const match = ai.find((member) => wanted && member.specialty?.toLowerCase().includes(wanted)) ?? ai[0];
  return {
    model: match?.model ?? 'opus',
    permissionMode: match?.permissionMode ?? 'default',
    capacity: match?.capacity ?? 1,
    instructions: match?.instructions ?? '',
  };
}
