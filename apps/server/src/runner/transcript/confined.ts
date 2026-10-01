import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open, realpath, stat } from 'node:fs/promises';

/** A transcript larger than this is not read whole (a worker could make a huge sparse file). */
export const MAX_CONFINED_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

/**
 * Opens a file a worker controls (a transcript in its home, PM-140) without letting it lead the
 * server elsewhere: no following a symlink at the end, no blocking on a FIFO (`O_NONBLOCK`), a
 * regular file only, and the opened file must be the one the real path names inside the real
 * `root` (same device and inode), so a directory swapped for a symlink between the check and the
 * open is caught. Rejects otherwise; the caller closes the handle.
 */
export async function openConfined(path: string, root: string): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a regular file');
    const [real, realRoot] = await Promise.all([realpath(path), realpath(root)]);
    if (!real.startsWith(`${realRoot}/`)) throw new Error('outside the worker home');
    const named = await stat(real);
    if (named.dev !== info.dev || named.ino !== info.ino)
      throw new Error('the file changed while it was opened');
    return handle;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}
