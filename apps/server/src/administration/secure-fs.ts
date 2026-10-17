import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

/**
 * The file rules of the administration adapter (PM-763): its state directory and socket directory are the
 * owner's or the service's alone (0700), its files 0600, none of them is reached through a symbolic link, and
 * a file is replaced only by writing a new one beside it and renaming. A path that breaks a rule is refused
 * with an `AdministrationSetupError`; nothing is repaired silently.
 */

export type SetupFailure =
  | 'symlink'
  | 'not_directory'
  | 'not_file'
  | 'not_socket'
  | 'wrong_owner'
  | 'too_open'
  | 'too_large'
  | 'missing'
  | 'unsupported';

export class AdministrationSetupError extends Error {
  readonly reason: SetupFailure;
  constructor(reason: SetupFailure, message: string) {
    super(message);
    this.name = 'AdministrationSetupError';
    this.reason = reason;
  }
}

/** The uid files must belong to; null where the platform has none (the checks of the owner are skipped). */
export const currentUid = (): number | null =>
  typeof process.getuid === 'function' ? process.getuid() : null;

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function checkOwner(stats: Stats, target: string, uid: number | null): void {
  if (uid !== null && stats.uid !== uid)
    throw new AdministrationSetupError('wrong_owner', `${target} is not owned by the service user`);
}

/** The directory must exist as a real directory of the service user, closed to group and others. */
export async function assertPrivateDir(dir: string, uid: number | null = currentUid()): Promise<void> {
  const stats = await lstatOrNull(dir);
  if (!stats) throw new AdministrationSetupError('missing', `${dir} does not exist`);
  if (stats.isSymbolicLink()) throw new AdministrationSetupError('symlink', `${dir} is a symbolic link`);
  if (!stats.isDirectory()) throw new AdministrationSetupError('not_directory', `${dir} is not a directory`);
  checkOwner(stats, dir, uid);
  if ((stats.mode & 0o077) !== 0)
    throw new AdministrationSetupError('too_open', `${dir} is open to group or others (must be 0700)`);
}

/** Makes the directory (0700) when it is missing, then asserts it. An existing one is never loosened or tightened. */
export async function ensurePrivateDir(dir: string, uid: number | null = currentUid()): Promise<void> {
  if (!(await lstatOrNull(dir))) await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertPrivateDir(dir, uid);
}

/**
 * Writes `content` as `<dir>/<name>` (0600) atomically: a new file beside it is written, flushed and renamed
 * over the old one. The directory must already be private; `name` is a plain file name.
 */
export async function writeFileAtomic(dir: string, name: string, content: string): Promise<void> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name === '.' || name === '..')
    throw new AdministrationSetupError('unsupported', 'not a plain file name');
  const target = path.join(dir, name);
  const existing = await lstatOrNull(target);
  if (existing?.isSymbolicLink())
    throw new AdministrationSetupError('symlink', `${target} is a symbolic link`);
  const temporary = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw err;
  }
  await handle.close();
  try {
    await rename(temporary, target);
  } catch (err) {
    await rm(temporary, { force: true });
    throw err;
  }
}

/**
 * Reads a regular file of the service user that is closed to group and others, opened without following a
 * link. `null`: the file is not there.
 */
export async function readPrivateFile(
  file: string,
  maxBytes: number,
  uid: number | null = currentUid(),
): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new AdministrationSetupError('symlink', `${file} is a symbolic link`);
    throw err;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new AdministrationSetupError('not_file', `${file} is not a regular file`);
    checkOwner(stats, file, uid);
    if ((stats.mode & 0o077) !== 0)
      throw new AdministrationSetupError('too_open', `${file} is open to group or others (must be 0600)`);
    if (stats.size > maxBytes) throw new AdministrationSetupError('too_large', `${file} is too large`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** The socket must be a real socket (not a link) of the expected user, closed to group and others. */
export async function assertSocketFile(socketPath: string, uid: number | null = currentUid()): Promise<void> {
  const stats = await lstatOrNull(socketPath);
  if (!stats) throw new AdministrationSetupError('missing', 'the administration socket does not exist');
  if (stats.isSymbolicLink())
    throw new AdministrationSetupError('symlink', 'the socket path is a symbolic link');
  if (!stats.isSocket()) throw new AdministrationSetupError('not_socket', 'the socket path is not a socket');
  checkOwner(stats, 'the socket', uid);
  if ((stats.mode & 0o077) !== 0)
    throw new AdministrationSetupError('too_open', 'the socket is open to group or others (must be 0600)');
}

/** Removes a stale socket file left by a previous run; refuses anything that is not a socket of this user. */
export async function removeStaleSocket(
  socketPath: string,
  uid: number | null = currentUid(),
): Promise<void> {
  const stats = await lstatOrNull(socketPath);
  if (!stats) return;
  if (stats.isSymbolicLink())
    throw new AdministrationSetupError('symlink', 'the socket path is a symbolic link');
  if (!stats.isSocket()) throw new AdministrationSetupError('not_socket', 'the socket path is not a socket');
  checkOwner(stats, 'the socket', uid);
  await rm(socketPath);
}
