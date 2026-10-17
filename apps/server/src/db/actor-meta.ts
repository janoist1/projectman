import { actorOriginMetaOf } from '@projectman/shared';
import type { Actor } from '@projectman/shared';
import { toJson } from './json';

/**
 * The `actor_meta` column of an actor (PM-757): the super mode's origin as JSON, NULL for every other actor.
 * The old actor columns are written as before, so an older reader of the row sees the old actor.
 */
export function originMetaJson(actor: Actor): string | null {
  const meta = actorOriginMetaOf(actor);
  return meta ? toJson(meta) : null;
}
