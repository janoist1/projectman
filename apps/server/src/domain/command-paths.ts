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
 * `word` resolved against `dir`, or `null` when the text cannot show where it leads:
 * - `..` follows a real directory name. The shell resolves such a `..` on disk, so behind a
 *   symbolic link it could lead somewhere else; a leading `..` (`../other`) has no such doubt.
 * - a component starts with a dot and holds a pattern character (`.*`, `.?`, `.[a]`). Before
 *   bash 5.2 (macOS still ships 3.2) such a pattern also matches `.` and `..`, so `.*` names the
 *   parent directory, and a few of them in a row climb out of the directory the word is meant
 *   to stay in.
 */
export function resolveWord(dir: string, word: string): string | null {
  let named = false;
  for (const part of word.split('/')) {
    if (part === '..') {
      if (named) return null;
    } else if (part !== '' && part !== '.') {
      if (part.startsWith('.') && hasGlobCharacter(part)) return null;
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
 * one or holds a pattern character: the shell expands `*.ts` and `.*` against the directory, so
 * they name places too. An option names the path it carries: the value of `--root=apps/web`, and
 * what sits right behind a short option (`-f/etc/passwd`), except a lone slash, which is a
 * delimiter (`cut -d/`).
 */
export function pathsIn(word: string): string[] {
  if (!word.startsWith('-')) return looksLikePath(word) || hasGlobCharacter(word) ? [word] : [];
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

/** Whether a word holds a character the shell expands as a pattern: `*`, `?` or `[`. */
export function hasGlobCharacter(word: string): boolean {
  return /[*?[]/.test(word);
}
