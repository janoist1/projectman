import { isAbsolute, posix } from 'node:path';

/**
 * The explicit translation of the old machine's absolute paths to the new one (PM-143). Nothing is
 * guessed: a path is rewritten only when it lies under a `FROM` the person named, and every other
 * absolute path is reported, not changed.
 */
export interface PathMapping {
  from: string;
  to: string;
}

function cleanAbsolute(value: string, what: string): string {
  if (!isAbsolute(value)) throw new Error(`${what} must be an absolute path: ${value}`);
  const normal = posix.normalize(value);
  return normal.length > 1 ? normal.replace(/\/+$/, '') : normal;
}

/** `FROM=TO`, both absolute (`/Users/i/Dev/projectman=/var/lib/projectman/data/repos/PM`). */
export function parsePathMapping(spec: string): PathMapping {
  const at = spec.indexOf('=');
  if (at <= 0 || at === spec.length - 1) throw new Error(`a path mapping is FROM=TO, got: ${spec}`);
  return { from: cleanAbsolute(spec.slice(0, at), 'FROM'), to: cleanAbsolute(spec.slice(at + 1), 'TO') };
}

export function assertMappings(mappings: readonly PathMapping[]): void {
  const seen = new Set<string>();
  for (const { from } of mappings) {
    if (seen.has(from)) throw new Error(`the path ${from} is mapped twice`);
    seen.add(from);
  }
}

function under(path: string, root: string): boolean {
  return path === root || root === '/' || path.startsWith(`${root}/`);
}

/**
 * The new path for `path`, by the longest `from` that contains it at a path-segment boundary
 * (`/a/bc` is not under `/a/b`); null when none does or `path` is not absolute.
 */
export function mapPath(path: string, mappings: readonly PathMapping[]): string | null {
  if (!isAbsolute(path)) return null;
  const normal = posix.normalize(path);
  let best: PathMapping | null = null;
  for (const mapping of mappings)
    if (under(normal, mapping.from) && (!best || mapping.from.length > best.from.length)) best = mapping;
  if (!best) return null;
  const rest = normal === best.from ? '' : normal.slice(best.from === '/' ? 0 : best.from.length);
  return posix.normalize(`${best.to}${rest}`);
}

/** The absolute-path prefix this value would need a mapping for, for the report ("the first two segments"). */
export function pathGroup(path: string): string {
  const segments = posix.normalize(path).split('/').filter(Boolean);
  return `/${segments.slice(0, 3).join('/')}`;
}
