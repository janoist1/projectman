import fs from 'node:fs';
import path from 'node:path';

/**
 * The client's file rules (PM-765). A credential file must be a regular file of the current user with mode 0600
 * in a directory of the current user with mode 0700, and neither may be a symbolic link. Text the user asks
 * the client to send (`--file`) must not be a credential file either, or a mistyped path would publish it.
 */

export class ClientFileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ClientFileError';
  }
}

/** The user the checks compare with; tests lend another one. */
export interface FileOwner {
  uid: number | null;
}
export const currentOwner = (): FileOwner => ({
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
});

const MODE_BITS = 0o777;

function fail(code: string, message: string): never {
  throw new ClientFileError(code, message);
}

/** The directory holding a credential file: a real directory of the user, with no access for anyone else. */
export function assertPrivateDirectory(dir: string, owner: FileOwner = currentOwner()): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return fail('credential_directory_missing', `the directory ${dir} does not exist`);
  }
  if (stat.isSymbolicLink()) fail('credential_symlink', `the directory ${dir} is a symbolic link`);
  if (!stat.isDirectory()) fail('credential_directory_invalid', `${dir} is not a directory`);
  if (owner.uid !== null && stat.uid !== owner.uid)
    fail('credential_owner', `the directory ${dir} is not owned by the current user`);
  if ((stat.mode & MODE_BITS) !== 0o700)
    fail('credential_mode', `the directory ${dir} must have mode 0700 (chmod 700)`);
}

/**
 * Reads a credential file (the configuration, the key, the Access headers) as text, after the checks.
 * The file is opened without following a link and checked through the open descriptor, so a swap between
 * the check and the read cannot change what is read.
 */
export function readPrivateFile(file: string, owner: FileOwner = currentOwner()): string {
  assertPrivateDirectory(path.dirname(file), owner);
  let link: fs.Stats;
  try {
    link = fs.lstatSync(file);
  } catch {
    return fail('credential_file_missing', `the file ${file} does not exist`);
  }
  if (link.isSymbolicLink()) fail('credential_symlink', `the file ${file} is a symbolic link`);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return fail('credential_file_unreadable', `the file ${file} cannot be opened`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail('credential_file_invalid', `${file} is not a regular file`);
    if (owner.uid !== null && stat.uid !== owner.uid)
      fail('credential_owner', `the file ${file} is not owned by the current user`);
    if ((stat.mode & MODE_BITS) !== 0o600)
      fail('credential_mode', `the file ${file} must have mode 0600 (chmod 600)`);
    if (stat.size > 64 * 1024) fail('credential_file_invalid', `the file ${file} is too large`);
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export const MAX_INPUT_BYTES = 1024 * 1024;

/** A path of the user's own text: a regular file, not a link; never one of the credential files. */
export function readInputFile(file: string, protectedPaths: readonly string[]): string {
  const resolved = path.resolve(file);
  let link: fs.Stats;
  try {
    link = fs.lstatSync(resolved);
  } catch {
    return fail('input_file_missing', `the file ${file} does not exist`);
  }
  if (link.isSymbolicLink()) fail('input_file_symlink', `the file ${file} is a symbolic link`);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return fail('input_file_missing', `the file ${file} does not exist`);
  }
  for (const guarded of protectedPaths) {
    if (isInside(real, guarded))
      fail('input_file_protected', `the file ${file} is a credential or configuration file and is not sent`);
  }
  let fd: number;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return fail('input_file_unreadable', `the file ${file} cannot be opened`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail('input_file_invalid', `${file} is not a regular file`);
    if (stat.size > MAX_INPUT_BYTES) fail('input_file_too_large', `the file ${file} is larger than 1 MiB`);
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether `candidate` is the guarded path or lies below it (both already resolved). */
export function isInside(candidate: string, guarded: string): boolean {
  const relative = path.relative(guarded, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Reads all of a stream up to the limit, as text. An abort of `signal` ends the wait even while the stream is
 * open and silent (a terminal that waits for input must still answer Ctrl-C); the read then fails with an
 * `AbortError`.
 */
export async function readStream(
  stream: AsyncIterable<string | Uint8Array>,
  signal?: AbortSignal,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = stream[Symbol.asyncIterator]();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const abort = () => reject(Object.assign(new Error('the read was aborted'), { name: 'AbortError' }));
    if (signal.aborted) return abort();
    onAbort = abort;
    signal.addEventListener('abort', abort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) break;
      const chunk = next.value;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_INPUT_BYTES) fail('input_file_too_large', 'the input is larger than 1 MiB');
      chunks.push(buffer);
    }
  } catch (error) {
    // Do not wait for the reader to settle: a pending read on a silent pipe never does.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Replaces the file with the text in one step (a temporary file beside it, then a rename). */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
