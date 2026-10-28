import { z } from 'zod';
import type { Actor } from './event';
import { MemberHandle } from './member';

// A leaf of the domain: the config rules (operator-member.ts) need these, and importing the event schema
// there would close an import cycle through the task schema.

/**
 * The credential a super-mode step was made with (PM-757): its id and its visible prefix, never the
 * secret. The audit reads a step back to its token by the prefix.
 */
export const ActorCredential = z.object({
  id: z.string().min(1).max(100),
  prefix: z.string().min(1).max(40),
});
export type ActorCredential = z.infer<typeof ActorCredential>;

/**
 * The credential prefix of the in-app Operator on the shared super-operation path (decision 55, PM-888):
 * its credential id is the Operator session's id, and no stored key stands behind it.
 */
export const OPERATOR_APP_CREDENTIAL_PREFIX = 'operator-app';

/**
 * The connected Claude behind a step (decision 66): the person whose Claude acted (`holder`, a member
 * handle) and the key it connected with. It is provenance next to the actor, never a secret and never
 * authority by itself: the server sets it from the authenticated key.
 */
export const ActorThrough = z.object({
  holder: z.string().min(1).max(64),
  credential: ActorCredential,
});
export type ActorThrough = z.infer<typeof ActorThrough>;

/**
 * Whether the optional origin fields of an actor agree. The old super mode (PM-757): `operatorMode: 'super'`
 * and `credential` come together, and only on an AI member acting through the integrator. The connected
 * Claude (decision 66): `through` stands alone, on a person or an AI member with a handle acting through the
 * integrator; a person is the holder (a direct instruction), an AI member is the issuer of the queue item it
 * works on. `approvedBy` needs `through`. A plain actor (no origin fields) is always consistent.
 */
export function actorOriginIssue(actor: {
  kind: 'human' | 'ai' | 'system';
  handle: string | null;
  via?: 'integrator' | undefined;
  operatorMode?: 'super' | undefined;
  credential?: ActorCredential | undefined;
  through?: ActorThrough | undefined;
  approvedBy?: string | undefined;
}): string | null {
  if (actor.through !== undefined) {
    if (actor.operatorMode !== undefined || actor.credential !== undefined)
      return 'through excludes operatorMode and credential';
    if (actor.kind === 'system' || actor.handle === null || actor.via !== 'integrator')
      return 'a connected-Claude actor is a person or an AI member acting through the integrator';
    if (actor.kind === 'human' && actor.handle !== actor.through.holder)
      return 'a person acting through a connected Claude is its holder';
    return null;
  }
  if (actor.approvedBy !== undefined) return 'approvedBy needs through';
  if (actor.operatorMode === undefined && actor.credential === undefined) return null;
  if (actor.operatorMode !== 'super' || !actor.credential) return 'operatorMode and credential come together';
  if (actor.kind !== 'ai' || actor.handle === null || actor.via !== 'integrator')
    return 'a super-mode actor is an AI member acting through the integrator';
  return null;
}

/**
 * What a stored row keeps of the origin next to the old actor columns (`actor_meta`): the old super mode
 * (PM-757) or the connected Claude (decision 66). Rows written before the second shape read as before.
 */
export const ActorOriginMeta = z.union([
  z.object({
    operatorMode: z.literal('super'),
    credential: ActorCredential,
  }),
  z.object({
    through: ActorThrough,
    approvedBy: MemberHandle.optional(),
  }),
]);
export type ActorOriginMeta = z.infer<typeof ActorOriginMeta>;

/** An actor of the Operator's super mode: the consistent combination of the origin fields. */
export type SuperActor = Actor & {
  kind: 'ai';
  handle: string;
  via: 'integrator';
  operatorMode: 'super';
  credential: ActorCredential;
};

/** An actor of a connected Claude (decision 66): the holder in person, or the issuer of the queue item worked on. */
export type ConnectedActor = Actor & {
  kind: 'human' | 'ai';
  handle: string;
  via: 'integrator';
  through: ActorThrough;
};

/** Whether the actor carries the old super origin (its fields agree). It grants nothing by itself. */
export function hasSuperOrigin(actor: Actor | null | undefined): actor is SuperActor {
  return !!actor && actor.operatorMode === 'super' && actorOriginIssue(actor) === null;
}

/** Whether the actor carries the connected-Claude origin (its fields agree). It grants nothing by itself. */
export function hasConnectedOrigin(actor: Actor | null | undefined): actor is ConnectedActor {
  return !!actor && actor.through !== undefined && actorOriginIssue(actor) === null;
}

/** An actor bound from an authenticated key: the old super shape or the connected Claude's. */
export type BoundActor = SuperActor | ConnectedActor;

/** Whether the actor carries either origin (its fields agree). It grants nothing by itself. */
export function hasBoundOrigin(actor: Actor | null | undefined): actor is BoundActor {
  return hasSuperOrigin(actor) || hasConnectedOrigin(actor);
}

/**
 * The connected Claude behind a step, in either shape, or null for a plain actor: the key it acted with and
 * the person whose Claude it was. An old super step has no holder (its actor was the Operator).
 */
export function connectedOriginOf(
  actor: Actor | null | undefined,
): { holder: string | null; credential: ActorCredential } | null {
  if (hasConnectedOrigin(actor))
    return { holder: actor.through.holder, credential: actor.through.credential };
  if (hasSuperOrigin(actor)) return { holder: null, credential: actor.credential };
  return null;
}

/**
 * The actor of a connected Claude's step (decision 66): the holder in person for a direct instruction, or
 * the `issuer` AI member for work on its queue item. The caller (the server, from the authenticated key)
 * decides which; `approvedBy` only comes from a server-checked yes.
 */
export function connectedActorOf(
  holder: string,
  credential: ActorCredential,
  opts: { issuer?: string; approvedBy?: string } = {},
): ConnectedActor {
  return {
    kind: opts.issuer === undefined ? 'human' : 'ai',
    handle: opts.issuer ?? holder,
    via: 'integrator',
    through: { holder, credential: { id: credential.id, prefix: credential.prefix } },
    ...(opts.approvedBy === undefined ? {} : { approvedBy: opts.approvedBy }),
  };
}

/** The connected actor with the server-checked approver; any other actor is returned as it is. */
export function withApprovedBy<A extends Actor>(actor: A, approvedBy: string): A {
  return hasConnectedOrigin(actor) ? ({ ...actor, approvedBy } as A) : actor;
}

/** The origin a store keeps beside the old actor columns; null for every actor but a consistent connected one. */
export function actorOriginMetaOf(actor: Actor): ActorOriginMeta | null {
  if (hasConnectedOrigin(actor))
    return {
      through: {
        holder: actor.through.holder,
        credential: { id: actor.through.credential.id, prefix: actor.through.credential.prefix },
      },
      ...(actor.approvedBy === undefined ? {} : { approvedBy: actor.approvedBy }),
    };
  return hasSuperOrigin(actor)
    ? { operatorMode: 'super', credential: { id: actor.credential.id, prefix: actor.credential.prefix } }
    : null;
}

/**
 * The actor of a stored row: the old columns, plus the origin of `meta` when it parses and agrees with
 * them. A row without meta, or with an unreadable or disagreeing one, reads as the plain old actor.
 */
export function actorWithOriginMeta(actor: Actor, meta: unknown): Actor {
  const parsed = ActorOriginMeta.safeParse(meta);
  if (!parsed.success) return actor;
  const merged: Actor = { ...actor, ...parsed.data };
  return hasSuperOrigin(merged) || hasConnectedOrigin(merged) ? merged : actor;
}
