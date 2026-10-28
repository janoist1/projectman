import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Files compared and copied by size and checksum (PM-523): what `SessionFolders.materializeFile` puts in a folder. */

/**
 * Whether `file`, which the agent can write, is a regular file with exactly the size and checksum of
 * `source` (PM-523). It is opened without following a link and without blocking (a FIFO opens at
 * once and is refused by `fstat`), and everything is read through that one descriptor, at most
 * `size + 1` bytes: a name swapped for a FIFO or a link to a device, or a file that keeps growing,
 * cannot stop the server's read or keep it hashing. Anything that is not that file is `false`.
 */
export async function isSameFile(file: string, source: { size: number; sha256: string }): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== source.size) return false;
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ start: 0, end: source.size, autoClose: false })) {
      bytes += (chunk as Buffer).length;
      if (bytes > source.size) return false;
      hash.update(chunk as Buffer);
    }
    return bytes === source.size && hash.digest('hex') === source.sha256;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Copies a regular file (a link is refused) to `dest`, which must not exist, with mode 0600, and checks
 * that it has exactly the size and checksum the caller named; a copy that fails the check is removed.
 */
export async function copyChecked(
  source: { path: string; size: number; sha256: string },
  dest: string,
): Promise<void> {
  const handle = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('The file is not a regular file');
    if (stat.size !== source.size) throw new Error('The file does not have the size it was given with');
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        bytes += chunk.length;
        done(null, chunk);
      },
    });
    try {
      await pipeline(handle.createReadStream(), meter, createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
      if (bytes !== source.size || hash.digest('hex') !== source.sha256)
        throw new Error('The file does not match its size and checksum');
    } catch (err) {
      await rm(dest, { force: true });
      throw err;
    }
  } finally {
    await handle.close();
  }
}
