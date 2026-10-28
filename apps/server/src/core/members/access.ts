import { connectedActorOf, hasAccess, memberOf, superActorOf } from '@projectman/shared';
import type {
  Actor,
  AiMemberConfig,
  BoundActor,
  ErrorCode,
  HumanAccess,
  HumanMemberConfig,
  MemberConfig,
  ProjectConfig,
} from '@projectman/shared';
import type { IntegratorPrincipal } from '../../contracts';
import { assertIntegratorAccess, forbidden, invalid, notFound } from '../../kernel';

/** A logged-in user's membership in one project. */
export interface ProjectAccess {
  via?: 'integrator';
  /**
   * What a step of this request is recorded as in the Operator's super mode (PM-757): set only by
   * `bindSuperPrincipal`, from an authenticated principal. The step's authority is still the owner's access
   * above.
   */
  superActor?: BoundActor;
  projectKey: string;
  handle: string;
  access: HumanAccess;
  member: HumanMemberConfig;
}

/** A refusal other than the default 403 insufficient_access "requires <minimum> access". */
interface AccessRefusal {
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
  const owner = assertIntegratorAccess(config as ProjectConfig, 'write', actor);
  return requireMemberAccess(
    owner ?? (actor.kind === 'human' ? memberOf(config, actor.handle) : undefined),
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
 * The actor of a step made with a super principal in a project (decision 66): the key's holder in person
 * (`holder`, a member now), or the AI member `issuer` of the queue item the step works on, in both cases
 * through the holder's connected Claude and the key. An in-app session (`source: 'app'`) keeps the old actor,
 * the project's Operator or selected coordinator. Null when there is no such member to act as.
 */
export function principalActorOf(
  config: Pick<ProjectConfig, 'team'>,
  principal: IntegratorPrincipal,
  holder: string | undefined,
  issuer?: string,
): BoundActor | null {
  const credential = { id: principal.keyId, prefix: principal.prefix };
  if (principal.source === 'app') return superActorOf(config, credential, principal.member);
  if (!holder || memberOf(config, holder)?.kind !== 'human') return null;
  return connectedActorOf(holder, credential, issuer === undefined ? {} : { issuer });
}

/**
 * Binds a super principal to a project (PM-757, decision 66): the key holder's membership now is the access
 * basis (checked again here, not at the time the key was made), and the actor is the holder in person, or the
 * issuer of the queue item worked on, through the holder's connected Claude. `handle` and `access` stay the
 * holder's, because the authority of a step is the holder's; what a step is recorded as is `superActor`. The
 * project needs no Operator. Refuses a principal that is not in the super mode and a holder who is no longer
 * a member of the project.
 */
export function bindSuperPrincipal(
  config: ProjectConfig,
  access: ProjectAccess,
  principal: IntegratorPrincipal,
  issuer?: string,
): ProjectAccess {
  if (principal.mode !== 'super') throw forbidden('insufficient_access', 'not a super-mode credential');
  if (access.projectKey !== config.project.key)
    throw forbidden('insufficient_access', 'the credential holder is no longer a member of the project');
  const superActor = principalActorOf(config, principal, access.handle, issuer);
  if (!superActor) throw forbidden('insufficient_access', 'the credential has no member to act as');
  return { ...access, via: 'integrator', superActor };
}
