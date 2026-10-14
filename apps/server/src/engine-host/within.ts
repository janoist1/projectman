import { realpathSync } from 'node:fs';
import path from 'node:path';

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

/** `child` is `parent` itself or lies inside it, by whole path components. */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The canonical path of `target`, which need not exist: the nearest existing ancestor is resolved
 * (links followed, macOS `/tmp` is `/private/tmp`) and the rest is appended. The sandboxes
 * canonicalize the paths they are given, so overlaps are compared on these.
 */
export function realpathOfNearest(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.reverse());
    } catch (err) {
      const parent = path.dirname(current);
      // Only a path that is not there (or not a directory) is climbed past; anything else is a real error.
      if (parent === current || (code(err) !== 'ENOENT' && code(err) !== 'ENOTDIR')) throw err;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
