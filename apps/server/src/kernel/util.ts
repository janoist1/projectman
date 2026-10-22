import { randomBytes, randomUUID } from 'node:crypto';
import type { Actor, SuperActor } from '@projectman/shared';

/** Sortable-ish unique id with a type prefix, e.g. "ses_lx2k9a1b2c3d4e5". */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

export function newUuid(): string {
  return randomUUID();
}

/** Unguessable token for per-session endpoints (MCP). */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

export const SYSTEM_ACTOR: Actor = { kind: 'system', handle: null };

/** Identity used for commits the app makes on its own (e.g. retiring a temp worker). */
export const SYSTEM_AUTHOR = { name: 'projectman', email: 'projectman@localhost' };

export function humanActor(handle: string): Actor {
  return { kind: 'human', handle };
}

export function aiActor(handle: string): Actor {
  return { kind: 'ai', handle };
}

/**
 * The actor a human member's step is recorded as (PM-757): the Operator's super actor when the step was made
 * in the super mode, otherwise the human with `via` when the owner's integrator key made it. `superActor`
 * is set only by `bindSuperPrincipal` from an authenticated principal; an `Actor` JSON never reaches here.
 */
export function attributedActor(by: {
  handle: string;
  via?: 'integrator' | null | undefined;
  superActor?: SuperActor | undefined;
}): Actor {
  if (by.superActor) return { ...by.superActor };
  return { ...humanActor(by.handle), ...(by.via ? { via: by.via } : {}) };
}

/** Member handle to store as the source/creator for an actor (the system has none). */
export function actorHandle(actor: Actor): string {
  return actor.handle ?? 'system';
}

export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** Serializes async work per key. Never re-enter the same key from inside `fn`. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short one-line excerpt of free text (for timeline data). */
export function excerpt(text: string, max = 140): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
