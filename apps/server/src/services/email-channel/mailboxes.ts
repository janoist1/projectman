import { emailMailboxOf, emailMailboxOwners, emailMemberAddress } from '@projectman/shared';
import type { AiMemberConfig, ProjectConfig } from '@projectman/shared';
import type { ProjectService } from '../../core/projects';

/** The configuration of every project: the members' addresses share one domain, so they are unique across projects. */
export async function projectConfigs(projects: ProjectService): Promise<ProjectConfig[]> {
  const configs = await Promise.all(
    projects.summaries().map((project) => projects.config(project.key).catch(() => null)),
  );
  return configs.filter((config): config is ProjectConfig => config !== null);
}

/** Whether this member is the only live owner of its mailbox name (PM-989); false: no address, or a conflict. */
export function ownsMailbox(
  configs: readonly ProjectConfig[],
  projectKey: string,
  member: AiMemberConfig,
): boolean {
  const owners = emailMailboxOwners(configs, emailMailboxOf(member));
  return owners.length === 1 && owners[0]!.projectKey === projectKey && owners[0]!.handle === member.handle;
}

/** The member's own address, or null while it has none (channel or switch off, or the name is shared). */
export function ownAddress(
  configs: readonly ProjectConfig[],
  projectKey: string,
  member: AiMemberConfig,
  domain: string,
): string | null {
  return ownsMailbox(configs, projectKey, member) ? emailMemberAddress(emailMailboxOf(member), domain) : null;
}
