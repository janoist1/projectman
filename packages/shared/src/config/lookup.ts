import type { Stage } from '../domain/pipeline';
import type { MemberConfig, ProjectConfig } from './schema';

/** The configured member with this handle. */
export function memberOf(
  config: Pick<ProjectConfig, 'team'>,
  handle: string | null | undefined,
): MemberConfig | undefined {
  return handle ? config.team.members.find((m) => m.handle === handle) : undefined;
}

/** The pipeline stage with this id. */
export function stageOf(config: Pick<ProjectConfig, 'pipeline'>, stageId: string): Stage | undefined {
  return config.pipeline.stages.find((s) => s.id === stageId);
}

/** The roles a member holds: an AI member exactly one, a human any number. */
export function memberRoles(member: MemberConfig): string[] {
  return member.kind === 'ai' ? [member.role] : member.roles;
}

export function ownerHandles(config: Pick<ProjectConfig, 'team'>): string[] {
  return config.team.members.filter((m) => m.kind === 'human' && m.access === 'owner').map((m) => m.handle);
}

/** Whether the person with this e-mail is an owner member of the project, as of its current configuration. */
export function holdsOwnershipByEmail(
  config: Pick<ProjectConfig, 'team'>,
  email: string | undefined,
): boolean {
  return (
    email !== undefined &&
    config.team.members.some(
      (member) =>
        member.kind === 'human' &&
        member.access === 'owner' &&
        member.email?.trim().toLowerCase() === email.trim().toLowerCase(),
    )
  );
}
