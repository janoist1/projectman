import { hasAccess, memberOf, superActorOf } from '@projectman/shared';
export { hasAccess, ownerHandles } from '@projectman/shared';
import type {
  Actor,
  AiMemberConfig,
  ErrorCode,
  HumanAccess,
  HumanMemberConfig,
  MemberConfig,
  ProjectConfig,
  SuperActor,
} from '@projectman/shared';
import type { IntegratorPrincipal } from '../../contracts';
import { forbidden, invalid, notFound } from '../../kernel';

/** A logged-in user's membership in one project. */
export interface ProjectAccess {
  via?: 'integrator';
  /**
   * What a step of this request is recorded as in the Operator's super mode (PM-757): set only by
   * `bindSuperPrincipal`, from an authenticated principal. The step's authority is still the owner's access
   * above.
   */
  superActor?: SuperActor;
  projectKey: string;
  handle: string;
  access: HumanAccess;
  member: HumanMemberConfig;
}

/** A refusal other than the default 403 insufficient_access "requires <minimum> access". */
export interface AccessRefusal {
  code?: ErrorCode;
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

/**
 * Binds a super principal to a project (PM-757): the token owner's membership now is the access basis (it
 * must be an owner's, checked again here, not at the time the key was made), and the actor is the project's
 * Operator, computed from the configuration. `handle` and `access` stay the owner's, because the authority
 * of a step is the token owner's; what a step is recorded as is `superActor`. Refuses a principal that is
 * not in the super mode, an owner who is no longer one, and a project without an Operator.
 */
export function bindSuperPrincipal(
  config: ProjectConfig,
  access: ProjectAccess,
  principal: IntegratorPrincipal,
): ProjectAccess {
  if (principal.mode !== 'super') throw forbidden('insufficient_access', 'not a super-mode credential');
  if (access.access !== 'owner' || access.projectKey !== config.project.key)
    throw forbidden('insufficient_access', 'the credential owner is no longer an owner of the project');
  const superActor = superActorOf(config, { id: principal.keyId, prefix: principal.prefix });
  if (!superActor) throw forbidden('insufficient_access', 'the project has no Operator');
  return { ...access, via: 'integrator', superActor };
}
