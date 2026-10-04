import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/** A FIFO would block the open until someone writes to it; with this the open returns and the type check refuses it. */
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

export type WorkspaceFileRefusalReason =
  'invalid' | 'outside' | 'missing' | 'link' | 'not_a_file' | 'too_large' | 'changed' | 'unreadable';

/** Why a file of the working directory is not taken; the message is for the agent that asked. */
export class WorkspaceFileRefusal extends Error {
  readonly reason: WorkspaceFileRefusalReason;
  constructor(reason: WorkspaceFileRefusalReason, message: string) {
    super(message);
    this.name = 'WorkspaceFileRefusal';
    this.reason = reason;
  }
}

/** A regular file of the working directory, opened for reading. */
export interface WorkspaceFile {
  /** The file's own name (the last path component), as metadata for the attachment. */
  name: string;
  /** Its size when it was opened. */
  size: number;
  /** The content, read once from the opened handle (one byte more than `size` at most, to notice growth). */
  stream(): Readable;
  /**
   * Refuses (`changed`) unless the whole file was read, exactly `size` bytes, and the open file
   * still has the size and modification time it had when it was opened.
   */
  verifyUnchanged(): Promise<void>;
  close(): Promise<void>;
}

/** Test hooks: run between the checks and the open, and after the open (to change the path meanwhile). */
export interface WorkspaceFileHooks {
  beforeOpen?: () => void | Promise<void>;
  afterOpen?: () => void | Promise<void>;
}

const errnoOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

/** `child` is inside `parent`, by whole path components (never `parent` itself). */
function relativeInside(parent: string, child: string): string | null {
  const relative = path.relative(parent, child);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return null;
  return relative;
}

const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * Opens `requested` for reading if, and only if, it is a regular file inside the directory `root`
 * (an AI session's working directory or session folder, as the server recorded it). A relative path is resolved
 * against `root`; an absolute one must lie inside it, spelled with `root` as recorded or resolved.
 *
 * What is refused: a path outside `root` (by whole components: `/work/app2` is not inside
 * `/work/app`), a symbolic link anywhere on the way (the file or a directory under `root`), a file
 * with several hard links (the other name may be outside), a directory, a FIFO, a socket or a
 * device, a file larger than `maxBytes`, and a path that changes while it is checked.
 *
 * The checks before the open only spare a needless open: the protection is that the file is opened
 * without following a link and without blocking, and the open file itself is checked afterwards.
 * Its real location, resolved after the open, must still be inside the resolved `root`, and the
 * file found there must be the very file that was opened (device and inode), so a directory
 * swapped for a link between the checks and the open is noticed whether or not it was swapped
 * back. The content is then read from that handle only.
 */
export async function openWorkspaceFile(
  root: string,
  requested: string,
  opts: {
    maxBytes: number;
    hooks?: WorkspaceFileHooks;
    /**
     * How the messages name `root` (default 'your working directory') and, for a file outside it,
     * the other place the caller may attach from (PM-268: the session folder).
     */
    place?: { name: string; other?: { name: string; path: string } };
    /**
     * `root` must be its own real path: it is refused (`unreadable`) when it, or a directory above
     * it, is a symbolic link. For a root a sandboxed member could have replaced by a link (the
     * session folder, PM-268); the final check then also catches a replacement made later.
     */
    exactRoot?: boolean;
  },
): Promise<WorkspaceFile> {
  if (!requested.trim() || requested.includes('\0'))
    throw new WorkspaceFileRefusal('invalid', 'The path is empty or not a valid path.');
  const placeName = opts.place?.name ?? 'your working directory';
  const recordedRoot = path.resolve(root);
  const unavailable = () =>
    new WorkspaceFileRefusal(
      'unreadable',
      `${placeName.charAt(0).toUpperCase()}${placeName.slice(1)} is not available.`,
    );
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw unavailable();
  }
  if (opts.exactRoot && realRoot !== recordedRoot) throw unavailable();
  const relative =
    relativeInside(recordedRoot, path.resolve(recordedRoot, requested)) ??
    relativeInside(realRoot, path.resolve(realRoot, requested));
  if (relative === null) {
    const other = opts.place?.other;
    throw new WorkspaceFileRefusal(
      'outside',
      `${requested} is not inside ${placeName} (${recordedRoot})${
        other ? ` or ${other.name} (${other.path})` : ''
      }; only files there can be attached.`,
    );
  }

  // Every directory on the way must be a real directory, not a link.
  const parts = relative.split(path.sep);
  let dir = realRoot;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    const stat = await lstatOrRefuse(dir, requested);
    if (stat.isSymbolicLink())
      throw new WorkspaceFileRefusal(
        'link',
        `${requested} leads through a symbolic link; attach the file itself.`,
      );
    if (!stat.isDirectory()) throw new WorkspaceFileRefusal('missing', `${requested} does not exist.`);
  }
  const full = path.join(realRoot, relative);
  const before = await lstatOrRefuse(full, requested);
  checkFileStat(before, requested, opts.maxBytes);

  await opts.hooks?.beforeOpen?.();
  let handle: FileHandle;
  try {
    handle = await open(full, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ELOOP' || code === 'EMLINK')
      throw new WorkspaceFileRefusal('link', `${requested} is a symbolic link; attach the file itself.`);
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new WorkspaceFileRefusal('changed', `${requested} changed while it was checked; try again.`);
    throw new WorkspaceFileRefusal('unreadable', `${requested} cannot be read.`);
  }

  try {
    await opts.hooks?.afterOpen?.();
    const opened = await handle.stat();
    checkFileStat(opened, requested, opts.maxBytes);
    if (!sameFile(opened, before))
      throw new WorkspaceFileRefusal('changed', `${requested} changed while it was checked; try again.`);
    // Where the name leads now must be inside the working directory and be the opened file.
    let resolved: string;
    let current: Stats;
    try {
      if ((await realpath(root)) !== realRoot) throw new Error('the working directory moved');
      resolved = await realpath(full);
      current = await lstat(resolved);
    } catch {
      throw new WorkspaceFileRefusal('changed', `${requested} changed while it was checked; try again.`);
    }
    if (relativeInside(realRoot, resolved) === null || !sameFile(current, opened))
      throw new WorkspaceFileRefusal('changed', `${requested} changed while it was checked; try again.`);
    return workspaceFile(handle, parts[parts.length - 1]!, opened, requested);
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

async function lstatOrRefuse(target: string, requested: string): Promise<Stats> {
  try {
    return await lstat(target);
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new WorkspaceFileRefusal('missing', `${requested} does not exist.`);
    throw new WorkspaceFileRefusal('unreadable', `${requested} cannot be read.`);
  }
}

function checkFileStat(stat: Stats, requested: string, maxBytes: number): void {
  if (stat.isSymbolicLink())
    throw new WorkspaceFileRefusal('link', `${requested} is a symbolic link; attach the file itself.`);
  if (stat.isDirectory())
    throw new WorkspaceFileRefusal('not_a_file', `${requested} is a directory; attach one file at a time.`);
  if (!stat.isFile())
    throw new WorkspaceFileRefusal(
      'not_a_file',
      `${requested} is not a regular file (a FIFO, socket or device); only regular files can be attached.`,
    );
  if (stat.nlink > 1)
    throw new WorkspaceFileRefusal(
      'link',
      `${requested} has several hard links; attach a copy that has only this name.`,
    );
  if (stat.size > maxBytes)
    throw new WorkspaceFileRefusal(
      'too_large',
      `${requested} is ${stat.size} bytes; an attachment is at most ${maxBytes} bytes.`,
    );
}

function workspaceFile(handle: FileHandle, name: string, opened: Stats, requested: string): WorkspaceFile {
  const size = opened.size;
  let read = 0;
  const changed = () =>
    new WorkspaceFileRefusal(
      'changed',
      `${requested} changed while it was read; try again once it is complete.`,
    );
  return {
    name,
    size,
    stream() {
      // One byte past the size it had: a file that grows meanwhile is noticed, not cut.
      const source = handle.createReadStream({ start: 0, end: size, autoClose: false });
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          read += chunk.length;
          done(null, chunk);
        },
      });
      source.once('error', (err) => counter.destroy(err));
      return source.pipe(counter);
    },
    async verifyUnchanged() {
      if (read !== size) throw changed();
      const now = await handle.stat();
      if (now.size !== size || now.mtimeMs !== opened.mtimeMs || !sameFile(now, opened)) throw changed();
    },
    async close() {
      await handle.close().catch(() => undefined);
    },
  };
}
