import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { realpathOfNearest } from './within';

/** Where the session folders' roots are and how they are made safe (PM-268, PM-339, PM-353). */

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

function assertOwnDirectorySync(dir: string, mustExist = false): void {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  checkOwnDirectory(dir, stat, mustExist);
}

export async function assertOwnDirectory(dir: string, mustExist = false): Promise<void> {
  const stat = await lstat(dir).catch((err: unknown) => {
    if (code(err) === 'ENOENT') return undefined;
    throw err;
  });
  checkOwnDirectory(dir, stat, mustExist);
}

function checkOwnDirectory(
  dir: string,
  stat: ReturnType<typeof lstatSync> | undefined,
  mustExist: boolean,
): void {
  if (!stat) {
    if (mustExist) throw new Error(`${dir} is gone`);
    return;
  }
  if (stat.isSymbolicLink()) throw new Error(`${dir} is a symbolic link`);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    throw new Error(`${dir} belongs to another user`);
}

/**
 * Makes the root (0700) and checks it and its parent: a real directory (no symbolic link) owned
 * by the server's user. A root with group or other bits is made 0700. The root is predictable and
 * the parent may be a shared `/tmp`, where another user could have made it first (a link to a
 * directory the sweep would then empty). Throws with the reason.
 */
export function prepareSessionFoldersRoot(root: string): void {
  // Before the mkdir as well: nothing is made behind a link that is already there.
  assertOwnDirectorySync(path.dirname(root));
  assertOwnDirectorySync(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertOwnDirectorySync(path.dirname(root));
  assertOwnDirectorySync(root);
  if ((lstatSync(root).mode & 0o077) !== 0) chmodSync(root, 0o700);
}

/**
 * The parent of the sessions' own temporary directories (PM-339): a short path below the real
 * `/tmp` (macOS: `/private/tmp/...`). A sibling of the heavy-run queue folder
 * (`projectman-<uid>`), never below it: the sandbox of every member's commands writes that one, so
 * a path in it could be pre-empted or read by any member. This folder is 0700 and no sandbox rule
 * names it. An installation's root is a folder of its own in it (like its session folders root:
 * one's sweep must not remove another's).
 */
export function defaultSessionTmpRoot(): string {
  return path.join(realpathSync('/tmp'), `projectman-${process.getuid?.() ?? 'user'}-tmp`);
}

/**
 * Claude Code's temporary roots every Claude Code process of the user shares (PM-353): its
 * `<base>/claude-<uid>` (the base is `CLAUDE_CODE_TMPDIR`, else `/tmp`), where the scratchpads, the
 * background commands' `tasks/*.output` and the `bash-edit-diff` of every session of every project
 * live, and the sandbox runtime's default `/tmp/claude`. Each as given and as its canonical path
 * (macOS: `/private/tmp/...`), once.
 */
export function sharedClaudeTmpRoots(
  input: { claudeTmpBase?: string; uid?: number | string } = {},
): string[] {
  const uid = input.uid ?? process.getuid?.() ?? 'user';
  const given = [
    path.join('/tmp', `claude-${uid}`),
    ...(input.claudeTmpBase ? [path.join(input.claudeTmpBase, `claude-${uid}`)] : []),
    '/tmp/claude',
  ];
  return [...new Set(given.flatMap((root) => [root, realpathOfNearest(root)]))];
}

/**
 * Makes an installation's temporary directories root (`<defaultSessionTmpRoot()>/<instance>`, both
 * 0700) and checks it and the folder above it: real directories of the server's user, none a link.
 * Throws with the reason.
 */
export function prepareSessionTmpRoot(root: string): void {
  const base = path.dirname(root);
  assertOwnDirectorySync(base);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  assertOwnDirectorySync(base, true);
  if ((lstatSync(base).mode & 0o077) !== 0) chmodSync(base, 0o700);
  prepareSessionFoldersRoot(root);
}
