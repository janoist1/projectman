import { hasConnectedOrigin, hasSuperOrigin } from '../domain/actor-origin';
import type { ActorCredential, SuperActor } from '../domain/actor-origin';
import type { Actor } from '../domain/event';
import { memberOf } from './lookup';
import { coordinationMemberOf } from './project-manager';
import type { ProjectConfig } from './schema';

// Kept apart from operator.ts, which pulls in the integrator and owner-only rules: domain/task.ts needs
// only these, and importing the rules there would close an import cycle through the event schema.
// There is no Operator member since decision 66 (PM-1076): a connected Claude acts as its holder or as the
// issuer of a queue item, and the project manager acts as the selected coordinator.

/**
 * The retired built-in role of the Operator (PM-447, PM-1076). It is no role any more: the configuration
 * migration removes the member that held it, and this id only lets that migration (and nothing else) find it.
 */
export const RETIRED_OPERATOR_ROLE = 'ai_operator';

/** The handle the Operator had. It stays taken for good: older events and messages name it. */
export const RETIRED_OPERATOR_HANDLE = 'operator';

/**
 * The super actor of an in-app session (PM-757, PM-1041): the server-issued session member when it is the
 * selected coordinator. A caller-supplied actor grants no authority. Without a member the stored-key behavior
 * is unchanged, which now means no actor. Only authenticated execution may call this.
 */
export function coordinatorSuperActorOf(
  config: Pick<ProjectConfig, 'team'>,
  credential: ActorCredential,
  member?: string,
): SuperActor | null {
  const coordinator = coordinationMemberOf(config);
  if (!coordinator || (member !== undefined && coordinator.handle !== member)) return null;
  return {
    kind: 'ai',
    handle: coordinator.handle,
    via: 'integrator',
    operatorMode: 'super',
    credential: { id: credential.id, prefix: credential.prefix },
  };
}

/**
 * Whether the actor has the old super mode's origin and is the selected coordinator. It tells the origin
 * apart; it grants nothing: an actor read from a JSON body or a stored row is not authority, only the
 * authenticated principal is.
 */
export function isCoordinatorSuperActor(config: Pick<ProjectConfig, 'team'>, actor: Actor): boolean {
  return hasSuperOrigin(actor) && coordinationMemberOf(config)?.handle === actor.handle;
}

/**
 * Whether the actor is a connected Claude's direct instruction (decision 66) whose holder is an owner of the
 * project now: the owner's own authority stands behind it. A step on a queue item (named for its issuer, an AI
 * member) runs with the issuer's rights, as a request of a member did before (PM-1010), so it never counts. An
 * old super step keeps the rule it had, for the selected coordinator. It tells the origin apart; it grants
 * nothing: only the authenticated principal is authority.
 */
export function isConnectedOwnerActor(config: Pick<ProjectConfig, 'team'>, actor: Actor): boolean {
  if (!hasConnectedOrigin(actor)) return isCoordinatorSuperActor(config, actor);
  if (actor.kind !== 'human') return false;
  const holder = memberOf(config, actor.through.holder);
  return holder?.kind === 'human' && holder.access === 'owner';
}
