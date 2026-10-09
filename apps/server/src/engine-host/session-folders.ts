import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { EngineSessionFolders } from '../contracts';

/**
 * The session folders (PM-268): a Claude session's own writable directory for what its commands
 * produce (screenshots, reports), outside every checkout and the app home. The server computes the
 * path, makes it before the start and removes it when the process ends and at the server's start.
 * The registry (`of`, `allocate`) is synchronous; what touches the disk is asynchronous (PM-312), and
 * the caller awaits a removal before it makes the next folder of the same session: a restart's new
 * folder must come after the old one's removal.
 */

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A session's temporary directory name (`allocateTmp`); not a `.trash-*` name. */
const TMP_NAME = /^[0-9a-f]{12}$/;

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

function assertOwnDirectorySync(dir: string, mustExist = false): void {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  checkOwnDirectory(dir, stat, mustExist);
}

async function assertOwnDirectory(dir: string, mustExist = false): Promise<void> {
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
 * Removes `dir` (a direct child of `root`) with everything in it. It is renamed away first, inside
 * the root and to a name that is no session's, so a command of the old run that is still writing
 * in it cannot swap a directory for a link while the removal walks it; its sandbox rule does not
 * reach the new name.
 */
async function removeTree(root: string, dir: string): Promise<void> {
  const trash = path.join(root, `.trash-${randomBytes(8).toString('hex')}`);
  try {
    await rename(dir, trash);
  } catch (err) {
    if (code(err) === 'ENOENT') return;
    await rm(dir, { recursive: true, force: true });
    return;
  }
  await rm(trash, { recursive: true, force: true });
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
 * The canonical path of `target`, which need not exist: the nearest existing ancestor is resolved
 * (links followed, macOS `/tmp` is `/private/tmp`) and the rest is appended. The sandboxes
 * canonicalize the paths they are given, so overlaps are compared on these.
 */
export function realpathOfNearest(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.reverse());
    } catch (err) {
      const parent = path.dirname(current);
      // Only a path that is not there (or not a directory) is climbed past; anything else is a real error.
      if (parent === current || (code(err) !== 'ENOENT' && code(err) !== 'ENOTDIR')) throw err;
      missing.push(path.basename(current));
      current = parent;
    }
  }
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

/**
 * The session folders below one checked root. A folder lives for one process: every start gets a
 * new, unpredictable name (`<sessionId>.<random>`) and the server remembers which folder belongs to
 * which session. A command of an earlier run of the session that outlived its process (a detached
 * one) still holds the old path in its sandbox; it can neither reach the new folder nor put
 * anything at the new path, which it never learns, and the old path is gone with its folder.
 */
export class SessionFolders implements EngineSessionFolders {
  private readonly folders = new Map<string, string>();
  private readonly tmps = new Map<string, string>();
  readonly root: string;
  /** The root of the sessions' own temporary directories (Codex, PM-339), a short path; absent: none. */
  readonly tmpRoot: string | undefined;

  private readonly warn: ((err: unknown, dir: string) => void) | undefined;

  /** `warn` gets a temporary directory that could not be removed (the removal goes on). */
  constructor(root: string, tmpRoot?: string, warn?: (err: unknown, dir: string) => void) {
    this.root = root;
    this.tmpRoot = tmpRoot;
    this.warn = warn;
  }

  /**
   * A path for a session's own temporary directory, `<tmpRoot>/<12 random hex digits>`; nothing is
   * made. Not inside the folder: a Unix socket's path may be 104 bytes at most, and the tools open
   * sockets in their TMPDIR (Claude Code adds `/claude-<uid>`; below a long `CLAUDE_CODE_TMPDIR` it
   * falls back to a shared folder), so the name is short and carries no session id. It is new at
   * every start, so a path an earlier run's process still holds in its sandbox is never used again
   * (it could re-make a removed directory there, even as a link). Throws for an id that could leave
   * the root; `undefined` without a `tmpRoot`.
   */
  allocateTmp(sessionId: string): string | undefined {
    if (!this.tmpRoot) return undefined;
    if (!SESSION_ID.test(sessionId)) throw new Error(`Not a session id: ${JSON.stringify(sessionId)}`);
    return path.join(this.tmpRoot, randomBytes(6).toString('hex'));
  }

  /** A path no folder has had: `<root>/<sessionId>.<random>`; nothing is made. Throws for an id that could leave the root. */
  allocate(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`Not a session id: ${JSON.stringify(sessionId)}`);
    return path.join(this.root, `${sessionId}.${randomBytes(8).toString('hex')}`);
  }

  /**
   * Makes the folder `allocate` gave out and the temporary directory `allocateTmp` gave out (each
   * 0700; not recursive, so a path that exists, a link included, is an error), checks each is a real
   * directory of the server's user, and records them as the session's. What the session had before
   * is removed first. Either may be absent.
   */
  async make(sessionId: string, dir: string | undefined, tmpDir?: string): Promise<void> {
    if (dir && (path.dirname(dir) !== this.root || !path.basename(dir).startsWith(`${sessionId}.`)))
      throw new Error(`${dir} is not a folder of session ${sessionId}`);
    if (
      tmpDir &&
      (!this.tmpRoot || path.dirname(tmpDir) !== this.tmpRoot || !TMP_NAME.test(path.basename(tmpDir)))
    )
      throw new Error(`${tmpDir} is not a temporary directory of session ${sessionId}`);
    await this.remove(sessionId);
    // Recorded before the check: a directory that fails it is removed with the session's end.
    if (dir) {
      await mkdir(dir, { mode: 0o700 });
      this.folders.set(sessionId, dir);
      await assertOwnDirectory(dir, true);
    }
    if (tmpDir) {
      await mkdir(tmpDir, { mode: 0o700 });
      this.tmps.set(sessionId, tmpDir);
      await assertOwnDirectory(tmpDir, true);
    }
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
  async remove(sessionId: string): Promise<void> {
    // Both are taken out of the registry before the first await: a call that follows sees no folder.
    const tmp = this.takeTmp(sessionId);
    const dir = this.folders.get(sessionId);
    this.folders.delete(sessionId);
    if (tmp) await this.removeTmp(tmp);
    if (dir) await removeTree(this.root, dir);
  }

  private takeTmp(sessionId: string): string | undefined {
    const dir = this.tmps.get(sessionId);
    this.tmps.delete(sessionId);
    return dir;
  }

  /** A session's temporary directory goes the same way; a failure is reported to `warn`, never thrown. */
  private async removeTmp(dir: string): Promise<void> {
    try {
      await removeTree(this.tmpRoot!, dir);
    } catch (err) {
      this.warn?.(err, dir);
    }
  }

  /**
   * Removes every entry of the root (a symbolic link as a link, never its target) except the
   * folders of the sessions `keep` returns true for; returns the removed names.
   */
  async sweep(keep: (sessionId: string) => boolean): Promise<string[]> {
    const kept = new Set<string>();
    for (const [sessionId, dir] of this.folders) {
      if (keep(sessionId)) kept.add(path.basename(dir));
      else this.folders.delete(sessionId);
    }
    const keptTmps = new Set<string>();
    for (const [sessionId, dir] of this.tmps) {
      if (keep(sessionId)) keptTmps.add(path.basename(dir));
      else this.tmps.delete(sessionId);
    }
    const removed: string[] = [];
    for (const name of await readdir(this.root)) {
      if (kept.has(name)) continue;
      await rm(path.join(this.root, name), { recursive: true, force: true });
      removed.push(name);
    }
    await this.sweepTmp(keptTmps);
    return removed;
  }

  /**
   * Removes the temporary directories root when nothing is in it (at the server's stop), so an
   * instance that ran and left no session does not leave a folder in `/tmp` behind. A root with
   * entries stays (the next start sweeps it); never throws.
   */
  async releaseTmpRoot(): Promise<void> {
    if (!this.tmpRoot) return;
    try {
      await rmdir(this.tmpRoot);
    } catch {
      // Not empty, or already gone: nothing to do.
    }
  }

  /** The temporary directories of sessions that are gone (the root's own entries, a link as a link). */
  private async sweepTmp(keptNames: ReadonlySet<string>): Promise<void> {
    if (!this.tmpRoot) return;
    try {
      for (const name of await readdir(this.tmpRoot)) {
        if (keptNames.has(name)) continue;
        await rm(path.join(this.tmpRoot, name), { recursive: true, force: true });
      }
    } catch (err) {
      if (code(err) !== 'ENOENT') this.warn?.(err, this.tmpRoot);
    }
  }
}
