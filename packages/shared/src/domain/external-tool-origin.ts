import { z } from 'zod';
import { ActorCredential } from './actor-origin';
import type { SuperActor } from './actor-origin';
import { MemberHandle } from './member';

// A leaf of the domain (like actor-origin.ts): the inbox payload carries it, and the event schema is not
// imported here so no cycle forms through the inbox.

/** The super actor as a stored value: the project's Operator acting through the integrator with one key. */
const StoredSuperActor = z.strictObject({
  kind: z.literal('ai'),
  handle: MemberHandle,
  via: z.literal('integrator'),
  operatorMode: z.literal('super'),
  credential: ActorCredential,
});

/**
 * Where an item made through the bearer MCP came from (PM-784): the owner whose key it was, the super actor
 * (the Operator, the key's id and prefix) and the call's request id. The server builds it from the
 * authenticated scope; no public input carries it. It is provenance, never authority: a stored origin
 * grants nothing, and every use re-checks the key and the owner's membership.
 */
export const ExternalToolOrigin = z.strictObject({
  ownerUserId: z.string().min(1),
  actor: StoredSuperActor,
  requestId: z.string().min(1),
});
export type ExternalToolOrigin = z.infer<typeof ExternalToolOrigin>;

/** The origin as a `SuperActor` value (the shapes agree; the type narrows `Actor`). */
export function externalOriginActor(origin: ExternalToolOrigin): SuperActor {
  return { ...origin.actor, credential: { ...origin.actor.credential } };
}

/** The origin stored in a JSON value, or null when it is missing or does not parse. */
export function parseExternalToolOrigin(value: unknown): ExternalToolOrigin | null {
  const parsed = ExternalToolOrigin.safeParse(value);
  return parsed.success ? parsed.data : null;
}
