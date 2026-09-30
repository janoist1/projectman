import { memberOf } from '@projectman/shared';
import type {
  Actor,
  AiMemberConfig,
  HumanAccess,
  HumanMemberConfig,
  MemberConfig,
  ProjectConfig,
} from '@projectman/shared';
import { forbidden, invalid, notFound } from './errors';

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

/** A refusal other than the default 403 insufficient_access "requires <minimum> access". */
export interface AccessRefusal {
  code?: string;
  message?: string;
}

/** The member when it is a human with at least `minimum` access; otherwise 403. */
export function requireMemberAccess(
  member: MemberConfig | undefined,
  minimum: HumanAccess,
  refusal: AccessRefusal = {},
): HumanMemberConfig {
  if (member?.kind !== 'human' || !hasAccess(member.access, minimum))
    throw forbidden(refusal.code ?? 'insufficient_access', refusal.message ?? `requires ${minimum} access`);
  return member;
}

/** The acting member when it is a human with at least `minimum` access; otherwise 403. */
export function requireHuman(
  config: Pick<ProjectConfig, 'team'>,
  actor: Actor,
  minimum: HumanAccess,
  refusal: AccessRefusal = {},
): HumanMemberConfig {
  return requireMemberAccess(
    actor.kind === 'human' ? memberOf(config, actor.handle) : undefined,
    minimum,
    refusal,
  );
}

/** The AI member with this handle: 404 when there is none, 400 not_ai_member for a human. */
export function requireAiMember(config: Pick<ProjectConfig, 'team'>, handle: string): AiMemberConfig {
  const member = memberOf(config, handle);
  if (!member) throw notFound('member', handle);
  if (member.kind !== 'ai') throw invalid('not_ai_member', `${handle} is not an AI member`);
  return member;
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
