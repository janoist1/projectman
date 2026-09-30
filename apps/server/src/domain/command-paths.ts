import path from 'node:path';

/**
 * Where the words of a shell command point, read from the text alone (nothing touches the disk):
 * the automatic command rules let a command through only when every path in it stays inside the
 * directories it may use.
 */

/** `child` is `parent` itself or lies inside it. */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function isWithinAny(parents: readonly string[], child: string): boolean {
  return parents.some((parent) => isWithin(parent, child));
}

/**
 * `word` resolved against `dir`, or `null` when `..` follows a real directory name. The shell
 * resolves such a `..` on disk, so behind a symbolic link it could lead somewhere the text does
 * not show; a leading `..` (`../other`) has no such doubt.
 */
export function resolveWord(dir: string, word: string): string | null {
  let named = false;
  for (const part of word.split('/')) {
    if (part === '..') {
      if (named) return null;
    } else if (part !== '' && part !== '.') {
      named = true;
    }
  }
  return path.resolve(dir, word);
}

/** A word that looks like a path: it has a slash, or is `.` or `..`. */
export function looksLikePath(word: string): boolean {
  return word.includes('/') || word === '.' || word === '..';
}

/**
 * The parts of a word that name a place on disk. A plain word is one path when it looks like
 * one. An option names the path it carries: the value of `--root=apps/web`, and what sits right
 * behind a short option (`-f/etc/passwd`), except a lone slash, which is a delimiter (`cut -d/`).
 */
export function pathsIn(word: string): string[] {
  if (!word.startsWith('-')) return looksLikePath(word) ? [word] : [];
  const paths: string[] = [];
  const equals = word.indexOf('=');
  const name = equals < 0 ? word : word.slice(0, equals);
  if (equals >= 0 && looksLikePath(word.slice(equals + 1))) paths.push(word.slice(equals + 1));
  const slash = name.indexOf('/');
  if (slash >= 0 && !/^-[A-Za-z]\/$/.test(name)) paths.push(name.slice(slash));
  return paths;
}

/**
 * Every path in `word`, resolved against each of `dirs` (the directories the word may run in),
 * lies inside one of `roots`.
 */
export function pathsInside(word: string, dirs: readonly string[], roots: readonly string[]): boolean {
  return pathsIn(word).every((candidate) =>
    dirs.every((dir) => {
      const resolved = resolveWord(dir, candidate);
      return resolved !== null && isWithinAny(roots, resolved);
    }),
  );
}

/** Whether a word holds characters the shell expands as a pattern. */
export function hasGlobCharacter(word: string): boolean {
  return /[*?[\]]/.test(word);
}
