import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
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

function assertOwnDirectory(dir: string, mustExist = false): void {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
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
  assertOwnDirectory(path.dirname(root));
  assertOwnDirectory(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertOwnDirectory(path.dirname(root));
  assertOwnDirectory(root);
  if ((lstatSync(root).mode & 0o077) !== 0) chmodSync(root, 0o700);
}

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

/**
 * The session folders below one checked root. A folder lives for one process: every start gets a
 * new, unpredictable name (`<sessionId>.<random>`) and the server remembers which folder belongs to
 * which session. A command of an earlier run of the session that outlived its process (a detached
 * one) still holds the old path in its sandbox; it can neither reach the new folder nor put
 * anything at the new path, which it never learns, and the old path is gone with its folder.
 */
export class SessionFolders {
  private readonly folders = new Map<string, string>();
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** A path no folder has had: `<root>/<sessionId>.<random>`; nothing is made. Throws for an id that could leave the root. */
  allocate(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`Not a session id: ${JSON.stringify(sessionId)}`);
    return path.join(this.root, `${sessionId}.${randomBytes(8).toString('hex')}`);
  }

  /**
   * Makes the folder `allocate` gave out (0700; not recursive, so a path that exists is an error),
   * checks it is a real directory of the server's user, and records it as the session's folder. The
   * folder the session had before is removed first.
   */
  make(sessionId: string, dir: string): void {
    if (path.dirname(dir) !== this.root || !path.basename(dir).startsWith(`${sessionId}.`))
      throw new Error(`${dir} is not a folder of session ${sessionId}`);
    this.remove(sessionId);
    mkdirSync(dir, { mode: 0o700 });
    // Recorded before the check: a folder that fails it is removed with the session's end.
    this.folders.set(sessionId, dir);
    assertOwnDirectory(dir, true);
  }

  /** The folder the session's current process has, if it has one. */
  of(sessionId: string): string | undefined {
    return this.folders.get(sessionId);
  }

  /**
   * Removes the session's folder with everything in it (a link inside goes as a link); nothing
   * when it has none. The folder is renamed away first, inside the root and to a name that is no
   * session's, so a command of the old run that is still writing in it cannot swap a directory for
   * a link while the removal walks it; its sandbox rule does not reach the new name.
   */
  remove(sessionId: string): void {
    const dir = this.folders.get(sessionId);
    if (!dir) return;
    this.folders.delete(sessionId);
    const trash = path.join(this.root, `.trash-${randomBytes(8).toString('hex')}`);
    try {
      renameSync(dir, trash);
    } catch (err) {
      if (code(err) === 'ENOENT') return;
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    rmSync(trash, { recursive: true, force: true });
  }

  /**
   * Removes every entry of the root (a symbolic link as a link, never its target) except the
   * folders of the sessions `keep` returns true for; returns the removed names.
   */
  sweep(keep: (sessionId: string) => boolean): string[] {
    const kept = new Set<string>();
    for (const [sessionId, dir] of this.folders) {
      if (keep(sessionId)) kept.add(path.basename(dir));
      else this.folders.delete(sessionId);
    }
    const removed: string[] = [];
    for (const name of readdirSync(this.root)) {
      if (kept.has(name)) continue;
      rmSync(path.join(this.root, name), { recursive: true, force: true });
      removed.push(name);
    }
    return removed;
  }
}
