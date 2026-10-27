const WILDCARD = /[*?[]/;

/** A segment that runs code or holds repository settings: git's own names, husky's hooks, installed packages. */
const isGuardedSegment = (segment: string): boolean => {
  const lower = segment.toLowerCase();
  return lower.startsWith('.git') || lower === '.husky' || lower === 'node_modules';
};

/**
 * A relative POSIX path: no leading '/' or ':' (no pathspec magic of its own), no '\\', NUL or line break,
 * no empty, '.' or '..' segment, and none of the guarded names (`isGuardedSegment`; compared without case,
 * as macOS does). `segments` of it are returned, or null.
 */
function safeSegments(value: string): string[] | null {
  if (value.length < 1 || value.length > 200) return null;
  if (value.startsWith('/') || value.startsWith(':')) return null;
  if (/[\\\0\r\n]/.test(value)) return null;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return segments.some(isGuardedSegment) ? null : segments;
}

/**
 * A glob pattern for the generated files a conflicting merge makes again (PM-1050), in git's `:(glob)`
 * pathspec syntax: a safe relative path with a literal directory before its last segment. The first
 * segment is literal and does not start with a dot. The engine's limit and the engine's runner call this
 * too, so the rule lives here only.
 */
export function isRegeneratedPathPattern(pattern: string): boolean {
  const segments = safeSegments(pattern);
  if (segments === null || segments.length < 2) return false;
  const first = segments[0]!;
  return !WILDCARD.test(first) && !first.startsWith('.');
}

/**
 * A path of a file the merge may take from a regenerating run: a safe relative path (the rule the engine's
 * limit and the engine's runner share; a guarded name is never taken, whatever the patterns say).
 */
export function isRegeneratedPath(path: string): boolean {
  return safeSegments(path) !== null;
}

/**
 * The directories a generator must be able to write for `patterns`: for each, its literal leading segments
 * before the last one (the file name, or a wildcard segment and what follows it). Directories inside
 * another listed one are left out. Null when a pattern is not valid. The regenerating run may write
 * nowhere else in the checkout.
 */
export function regeneratedWriteDirs(patterns: readonly string[]): string[] | null {
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    if (!isRegeneratedPathPattern(pattern)) return null;
    const segments = pattern.split('/');
    const wild = segments.findIndex((segment) => WILDCARD.test(segment));
    dirs.add(segments.slice(0, wild === -1 ? -1 : wild).join('/'));
  }
  return [...dirs].filter((dir) => ![...dirs].some((other) => other !== dir && dir.startsWith(`${other}/`)));
}

/** A directory of `regeneratedWriteDirs`' kind: a safe relative path without a wildcard or a leading dot. */
export function isRegeneratedWriteDir(dir: string): boolean {
  const segments = safeSegments(dir);
  return segments !== null && !WILDCARD.test(dir) && !segments[0]!.startsWith('.');
}
