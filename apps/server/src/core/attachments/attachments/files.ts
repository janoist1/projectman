import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { AttachmentWriter } from '../../../contracts';

/** Suffix of a file still being written; recovery removes every one it finds. */
export const TEMPORARY_SUFFIX = '.part';

/** Suffix of a thumbnail (`<id>.thumb`); it is written as `<id>.thumb.part` first. */
export const THUMBNAIL_SUFFIX = '.thumb';

/** Opens a file without following a link at its last component. */
export const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export const isMissing = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** `FileHandle.write` may write less than asked. */
async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

export async function unlinkIfThere(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

/**
 * A file under `name` in `dir`, written as `name.part` and renamed into place (0600, created
 * exclusively and never through a link). The stream flushes the file to disk when it ends and
 * closes it whenever it ends or fails.
 */
export async function createWritableFile(dir: string, name: string): Promise<AttachmentWriter> {
  const temporary = join(dir, `${name}${TEMPORARY_SUFFIX}`);
  const published = join(dir, name);
  // O_EXCL: never an existing file, and never through a link.
  const handle = await open(temporary, 'wx', 0o600);
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      writeAll(handle, chunk).then(() => done(), done);
    },
    final(done) {
      handle.sync().then(() => done(), done);
    },
    destroy(err, done) {
      handle.close().then(
        () => done(err),
        () => done(err),
      );
    },
  });
  const discard = async () => {
    stream.destroy();
    await unlinkIfThere(temporary).catch(() => undefined);
  };
  return {
    stream,
    async publish() {
      try {
        // The stream has finished, and with it flushed and closed the file.
        await rename(temporary, published);
      } catch (err) {
        await discard();
        throw err;
      }
    },
    discard,
  };
}
