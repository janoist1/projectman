import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * The session folders (PM-268): a Claude session's own writable directory for what its commands
 * produce (screenshots, reports), outside every checkout and the app home. The server computes the
 * path, makes it before the start and removes it when the process ends and at the server's start.
 * Everything here is synchronous on purpose: a restart's new folder must come after the old one's
 * removal.
 */

/**
 * The variables of the session folder and of Playwright's browsers directory, set in the sandbox's
 * environment of the members that get them.
 */
export const SESSION_DIR_VARIABLE = 'PROJECTMAN_SESSION_DIR';
export const BROWSERS_PATH_VARIABLE = 'PLAYWRIGHT_BROWSERS_PATH';

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `<root>/<sessionId>`; throws when the id could leave the root. */
export function sessionFolderOf(root: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`Not a session id: ${JSON.stringify(sessionId)}`);
  return path.join(root, sessionId);
}

function assertOwnDirectory(dir: string): void {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return;
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
  assertOwnDirectory(path.dirname(root));
  assertOwnDirectory(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertOwnDirectory(path.dirname(root));
  assertOwnDirectory(root);
  if ((lstatSync(root).mode & 0o077) !== 0) chmodSync(root, 0o700);
}

/** Makes one session's folder (0700; the root is already checked). */
export function makeSessionFolder(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Removes one session's folder with everything in it; a link inside goes as a link. */
export function removeSessionFolder(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Removes every entry of the root (a symbolic link as a link, never its target) except the
 * folders of the sessions `keep` returns true for; returns the removed names.
 */
export function sweepSessionFolders(root: string, keep: (sessionId: string) => boolean): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (SESSION_ID.test(name) && keep(name)) continue;
    rmSync(path.join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
