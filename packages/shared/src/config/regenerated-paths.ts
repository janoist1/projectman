const WILDCARD = /[*?[]/;

/**
 * A relative POSIX path of at least `minSegments` segments: no leading '/' or ':' (no pathspec magic of its
 * own), no '\\', NUL or line break, no empty, '.' or '..' segment, a literal first segment that is none of
 * the places that run code or hold repository settings (`.git*`, `.husky`, `node_modules`; compared without
 * case, as macOS does).
 */
function isSafeRelativePath(value: string, minSegments: number): boolean {
  if (value.length < 1 || value.length > 200) return false;
  if (value.startsWith('/') || value.startsWith(':')) return false;
  if (/[\\\0\r\n]/.test(value)) return false;
  const segments = value.split('/');
  if (segments.length < minSegments) return false;
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  const first = segments[0]!.toLowerCase();
  return !WILDCARD.test(first) && !first.startsWith('.git') && first !== '.husky' && first !== 'node_modules';
}

/**
 * A glob pattern for the generated files a conflicting merge makes again (PM-1050), in git's `:(glob)`
 * pathspec syntax: a safe relative path of at least two segments (a pattern names a directory) with a
 * literal first segment. The engine's limit and the engine's runner call this too, so the rule lives here only.
 */
export function isRegeneratedPathPattern(pattern: string): boolean {
  return isSafeRelativePath(pattern, 2);
}

/**
 * The directory a generator must be able to write for `pattern`: its literal leading segments (all but the
 * file name when there is no wildcard), or null for a pattern that is not valid. The regenerating run may
 * write nowhere else in the checkout.
 */
export function regeneratedWriteDir(pattern: string): string | null {
  if (!isRegeneratedPathPattern(pattern)) return null;
  const segments = pattern.split('/');
  const wild = segments.findIndex((segment) => WILDCARD.test(segment));
  return segments.slice(0, wild === -1 ? -1 : wild).join('/');
}

/** A directory of `regeneratedWriteDir`'s kind: a safe relative path without a wildcard. */
export function isRegeneratedWriteDir(dir: string): boolean {
  return isSafeRelativePath(dir, 1) && !WILDCARD.test(dir);
}
