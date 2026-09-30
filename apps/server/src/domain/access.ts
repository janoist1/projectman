import { isHumanOnlyLabel, labelDefinition, labelHolders } from '@projectman/shared';
import type { HumanAccess, HumanMemberConfig, ProjectConfig, Stage } from '@projectman/shared';

/** A logged-in user's membership in one project. */
export interface ProjectAccess {
  projectKey: string;
  handle: string;
  access: HumanAccess;
  member: HumanMemberConfig;
}

/** viewer and client can read; developer can work on tasks; admin changes the team; owner everything. */
const RANK: Record<HumanAccess, number> = { viewer: 0, client: 0, developer: 1, admin: 2, owner: 3 };

export function hasAccess(access: HumanAccess, minimum: HumanAccess): boolean {
  return RANK[access] >= RANK[minimum];
}

/** Human member linked to the user's email (case-insensitive). */
export function findHumanByEmail(config: ProjectConfig, email: string): HumanMemberConfig | undefined {
  const wanted = email.trim().toLowerCase();
  return config.team.members.find(
    (m): m is HumanMemberConfig => m.kind === 'human' && (m.email ?? '').trim().toLowerCase() === wanted,
  );
}

export function projectAccessFor(config: ProjectConfig, email: string): ProjectAccess | null {
  const member = findHumanByEmail(config, email);
  if (!member) return null;
  return { projectKey: config.project.key, handle: member.handle, access: member.access, member };
}

export function ownerHandles(config: ProjectConfig): string[] {
  return config.team.members.filter((m) => m.kind === 'human' && m.access === 'owner').map((m) => m.handle);
}

/**
 * The humans who approve a task into this stage: the holders of every label only humans may
 * set that its gate requires (one entry per label held).
 */
export function stageApprovers(config: ProjectConfig, stage: Stage): string[] {
  return (stage.gate?.conditions ?? []).flatMap((c) => {
    const label = c.type === 'has_label' ? labelDefinition(config, c.label) : undefined;
    return label && isHumanOnlyLabel(label) ? labelHolders(config, label) : [];
  });
}

/**
 * Signature of the release approvers (every release stage and its human approvers).
 * Changing it is owner-only.
 */
export function releaseApproversSignature(config: ProjectConfig): string {
  return config.pipeline.stages
    .filter((s) => s.kind === 'release')
    .map((s) => `${s.id}:${stageApprovers(config, s).sort().join(',')}`)
    .sort()
    .join('|');
}

/** Who holds owner access; changing it is owner-only. */
export function ownersSignature(config: ProjectConfig): string {
  return config.team.members
    .filter((m) => m.kind === 'human' && m.access === 'owner')
    .map((m) => `${m.handle}:${m.kind === 'human' ? m.email?.trim().toLowerCase() : ''}`)
    .sort()
    .join(',');
}
