import { z } from 'zod';
import type { Actor } from './event';

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
 * Whether the optional origin fields of an actor agree (PM-757): `operatorMode: 'super'` and `credential`
 * come together, and only on an AI member acting through the integrator; a credential alone, or a super
 * mode without one, is not a valid actor. A plain actor (no origin fields) is always consistent.
 */
export function actorOriginIssue(actor: {
  kind: 'human' | 'ai' | 'system';
  handle: string | null;
  via?: 'integrator' | undefined;
  operatorMode?: 'super' | undefined;
  credential?: ActorCredential | undefined;
}): string | null {
  if (actor.operatorMode === undefined && actor.credential === undefined) return null;
  if (actor.operatorMode !== 'super' || !actor.credential) return 'operatorMode and credential come together';
  if (actor.kind !== 'ai' || actor.handle === null || actor.via !== 'integrator')
    return 'a super-mode actor is an AI member acting through the integrator';
  return null;
}

/** What a stored row keeps of the super origin next to the old actor columns (`actor_meta`, PM-757). */
export const ActorOriginMeta = z.object({
  operatorMode: z.literal('super'),
  credential: ActorCredential,
});
export type ActorOriginMeta = z.infer<typeof ActorOriginMeta>;

/** An actor of the Operator's super mode: the consistent combination of the origin fields. */
export type SuperActor = Actor & {
  kind: 'ai';
  handle: string;
  via: 'integrator';
  operatorMode: 'super';
  credential: ActorCredential;
};

/** Whether the actor carries the super origin (its fields agree). It grants nothing by itself. */
export function hasSuperOrigin(actor: Actor | null | undefined): actor is SuperActor {
  return !!actor && actor.operatorMode === 'super' && actorOriginIssue(actor) === null;
}

/** The origin a store keeps beside the old actor columns; null for every actor but a consistent super one. */
export function actorOriginMetaOf(actor: Actor): ActorOriginMeta | null {
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
  return hasSuperOrigin(merged) ? merged : actor;
}
