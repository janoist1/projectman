/**
 * A glob pattern for the generated files a conflicting merge makes again (PM-1050), in git's `:(glob)`
 * pathspec syntax. A relative POSIX path: no leading '/' or ':' (no pathspec magic of its own), no '\\',
 * NUL or line break, no empty, '.' or '..' segment, a literal first segment (a pattern cannot start with a
 * wildcard) and nothing under `.git`. The engine's limit calls this too, so the rule lives here only.
 */
export function isRegeneratedPathPattern(pattern: string): boolean {
  if (pattern.length < 1 || pattern.length > 200) return false;
  if (pattern.startsWith('/') || pattern.startsWith(':')) return false;
  if (/[\\\0\r\n]/.test(pattern)) return false;
  const segments = pattern.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  return !/[*?[]/.test(segments[0]!) && segments[0] !== '.git';
}
