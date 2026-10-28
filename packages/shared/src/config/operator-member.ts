import { hasSuperOrigin } from '../domain/actor-origin';
import type { ActorCredential, SuperActor } from '../domain/actor-origin';
import type { Actor } from '../domain/event';
import type { MemberHandle } from '../domain/member';
import { isOnLeave } from './leave';
import { memberOf } from './lookup';
import { coordinationMemberOf } from './project-manager';
import type { AiMemberConfig, MemberConfig, ProjectConfig } from './schema';

// Kept apart from operator.ts, which pulls in the integrator and owner-only rules: domain/task.ts needs
// only these, and importing the rules there would close an import cycle through the event schema.

/** The built-in role of the Operator, the AI the owner talks to about how the project runs (PM-447). */
export const OPERATOR_ROLE = 'ai_operator';

/** An AI member holding the built-in ai_operator role; a temp worker never counts, leave does not matter. */
export function isOperator(
  member: { kind: MemberConfig['kind']; role?: string; temp?: boolean } | null | undefined,
): boolean {
  return member?.kind === 'ai' && member.role === OPERATOR_ROLE && member.temp !== true;
}

function operatorsOf(config: Pick<ProjectConfig, 'team'>): AiMemberConfig[] {
  return config.team.members.filter((m): m is AiMemberConfig => isOperator(m));
}

/** The team's Operator: the first not on leave, else the first; null when there is none. */
export function operatorOf(config: Pick<ProjectConfig, 'team'>): AiMemberConfig | null {
  const operators = operatorsOf(config);
  return operators.find((m) => !isOnLeave(m)) ?? operators[0] ?? null;
}

/** Whether `handle` is the team's only Operator: it cannot be retired (nor sent on leave, PM-473). */
export function isRequiredOperator(config: Pick<ProjectConfig, 'team'>, handle: MemberHandle): boolean {
  const operators = operatorsOf(config);
  return operators.length === 1 && operators[0]!.handle === handle;
}

/** How long the Operator's conversation with a person who is not an owner stands idle before it closes (PM-475). */
export const OPERATOR_GUEST_IDLE_CLOSE_MINUTES = 5;

/**
 * Whether the Operator member runs sessions in the app (PM-1045): no, it exists only while the owner connects
 * their own Claude with a super key. The `operator` member stays as the identity of that client's steps.
 */
export const operatorRunsInApp: boolean = false;

/** Whether a session may run for `member` in the app: not for the Operator, which exists only when connected. */
export function runsInApp(
  member: { kind: MemberConfig['kind']; role?: string; temp?: boolean } | null | undefined,
): boolean {
  return operatorRunsInApp || !isOperator(member);
}

/**
 * Whether the actor is the Operator at work: an AI member holding the role, not acting through the
 * integrator key. A person, the system or another AI member never is.
 */
export function isOperatorActor(
  config: Pick<ProjectConfig, 'team'>,
  actor: Pick<Actor, 'kind' | 'handle' | 'via'>,
): boolean {
  return actor.kind === 'ai' && !actor.via && isOperator(memberOf(config, actor.handle));
}

/**
 * The super actor (PM-757, PM-1041): the project's Operator, or the server-issued app session member
 * when it is the Operator or selected coordinator. A caller-supplied actor grants no authority.
 * Without a member the stored-key behavior is unchanged. Only authenticated execution may call this.
 */
export function superActorOf(
  config: Pick<ProjectConfig, 'team'>,
  credential: ActorCredential,
  member?: string,
): SuperActor | null {
  const operator =
    member === undefined
      ? operatorOf(config)
      : [operatorOf(config), coordinationMemberOf(config)].find((candidate) => candidate?.handle === member);
  if (!operator) return null;
  return {
    kind: 'ai',
    handle: operator.handle,
    via: 'integrator',
    operatorMode: 'super',
    credential: { id: credential.id, prefix: credential.prefix },
  };
}

/**
 * Whether the actor has the super mode's origin and is the current Operator or selected coordinator. It tells the
 * origin apart (the direct base mode stays `isOperatorActor`); it grants nothing: an actor read from a
 * JSON body or a stored row is not authority, only the authenticated principal is.
 */
export function isSuperOperatorActor(config: Pick<ProjectConfig, 'team'>, actor: Actor): boolean {
  return (
    hasSuperOrigin(actor) &&
    (operatorOf(config)?.handle === actor.handle || coordinationMemberOf(config)?.handle === actor.handle)
  );
}
