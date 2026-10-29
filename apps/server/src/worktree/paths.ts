import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** Real path when it exists (macOS: /var -> /private/var), else the resolved path. */
export async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const resolved = path.resolve(p);
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(await canonical(parent), path.basename(resolved));
  }
}

/** Serialises async work per key (git operations on one repository). */
export function createKeyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return async (key, fn) => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

/** Shared by both managers. Call with a canonical repository path, after any workspace lock. */
export const withRepoLock = createKeyedLock();
