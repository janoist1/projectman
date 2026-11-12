/** The longest path pattern a configuration may hold. */
export const PATH_PATTERN_MAX = 200;

/** Why a path pattern is refused, or null when it is valid; the pattern is relative to the repository root. */
export function pathPatternIssue(
  pattern: string,
): 'empty' | 'absolute' | 'dot_segment' | 'backslash' | 'bad_glob' | 'too_long' | null {
  if (pattern.length === 0) return 'empty';
  if (pattern.length > PATH_PATTERN_MAX) return 'too_long';
  if (pattern.startsWith('/')) return 'absolute';
  if (pattern.includes('\\')) return 'backslash';
  for (const segment of pattern.split('/')) {
    if (segment === '.' || segment === '..') return 'dot_segment';
    if (segment.includes('**') && segment !== '**') return 'bad_glob';
  }
  return null;
}

/**
 * Whether a repository-relative path matches a valid pattern: `/` separates segments, `**` (a whole
 * segment) matches zero or more segments, `*` any run of characters inside one segment, `?` one character.
 * Everything else matches literally, case-sensitive.
 */
export function matchesPathPattern(pattern: string, path: string): boolean {
  return matchSegments(pattern.split('/'), path.split('/'));
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  const [head, ...rest] = pattern;
  if (head === undefined) return path.length === 0;
  if (head === '**') {
    for (let skip = 0; skip <= path.length; skip++) if (matchSegments(rest, path.slice(skip))) return true;
    return false;
  }
  const [segment, ...others] = path;
  return segment !== undefined && matchSegment(head, segment) && matchSegments(rest, others);
}

function matchSegment(pattern: string, text: string): boolean {
  // Iterative glob match with backtracking on the last `*`.
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const c = pattern[p];
    if (c === '*') {
      star = p++;
      mark = t;
    } else if (c !== undefined && (c === '?' || c === text[t])) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
