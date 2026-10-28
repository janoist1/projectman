import { randomBytes } from 'node:crypto';
import { link, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { EngineSessionFolders } from '../contracts';
import { copyChecked, isSameFile } from './checked-copy';
import { assertOwnDirectory } from './session-roots';

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
   * A file of the server's storage into the session's folder, `<folder>/<name>` (PM-518, PM-523).
   * Only the folder this registry recorded for the session is written, never a path the caller names:
   * a session the registry does not know (not started here, already ended) is refused. The content is
   * copied to a name in the root, which no session reaches, checked against the size and checksum,
   * and then linked into place, so the file the agent sees is complete and made exclusively (0600,
   * never through a link).
   *
   * The file goes straight into the session folder and there is no subfolder: the agent writes inside
   * the folder, so a directory in it could be renamed away and replaced by a link between the check
   * and the use, and the server (outside the sandbox) would write and remove through that link. The
   * folder itself lives in the root, which the agent cannot write, so it cannot be swapped, and its
   * last element is safe by itself: `link` refuses an existing name (a link included, it is never
   * followed) and a name that is not the same file is renamed into the root and removed there, so the
   * agent's own entry (a link, or a folder it keeps changing) is never walked in its place. A file
   * already there with the same checksum stays as the answer.
   */
  async materializeFile(
    sessionId: string,
    input: { name: string; source: { path: string; size: number; sha256: string } },
  ): Promise<{ path: string }> {
    const { name, source } = input;
    if (!name || name.length > 255 || name === '.' || name === '..' || /[/\\\0]/.test(name))
      throw new Error(`Not a plain file name: ${JSON.stringify(name)}`);
    const folder = this.folders.get(sessionId);
    if (!folder) throw new Error(`Session ${sessionId} has no folder on this engine`);
    const staged = path.join(this.root, `.part-${randomBytes(8).toString('hex')}`);
    try {
      await copyChecked(source, staged);
      await assertOwnDirectory(folder, true);
      const dest = path.join(folder, name);
      if (await isSameFile(dest, source)) return { path: dest };
      // The slow check above is over: what is there now (nothing, mostly) is moved out of the agent's
      // reach by its name alone (a link moves as a link), and only then removed.
      const trash = path.join(this.root, `.trash-${randomBytes(8).toString('hex')}`);
      try {
        await rename(dest, trash);
        await rm(trash, { recursive: true, force: true });
      } catch (err) {
        if (code(err) !== 'ENOENT') throw err;
      }
      await link(staged, dest);
      return { path: dest };
    } finally {
      await rm(staged, { force: true });
    }
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
