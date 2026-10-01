import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';
import { AttachmentId, TaskKey } from '@projectman/shared';
import type { AttachmentRef, AttachmentStorage, AttachmentWriter, StoredFile } from '../../contracts';

/** Suffix of a file still being written; recovery removes every one it finds. */
export const TEMPORARY_SUFFIX = '.part';

const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** A path component that is not what storage creates itself: a bug, never a user's input. */
function checkRef(ref: AttachmentRef): void {
  if (
    !PROJECT_KEY.test(ref.projectKey) ||
    !TaskKey.safeParse(ref.taskKey).success ||
    !AttachmentId.safeParse(ref.id).success
  ) {
    throw new Error('unsafe attachment storage reference');
  }
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** `FileHandle.write` may write less than asked. */
async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

async function unlinkIfThere(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
}

/**
 * Attachment files under `<root>/<projectKey>/<taskKey>/<id>` (`PROJECTMAN_HOME/attachments`).
 * The directories are private (0700) and the files 0600. The names are server made (keys and
 * generated ids, checked), never the uploaded file name. Every directory on the way is checked to
 * be a real directory (no symlink), a file is created exclusively and opened without following a
 * link, and only a regular file is ever read. The root itself may be a link the owner set up
 * (to another disk): it is resolved once.
 */
export class FileAttachmentStorage implements AttachmentStorage {
  private readonly rootDir: string;
  private resolvedRoot: Promise<string> | undefined;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private root(): Promise<string> {
    this.resolvedRoot ??= (async () => {
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      await chmod(this.rootDir, 0o700);
      return realpath(this.rootDir);
    })();
    // A failed attempt (disk trouble) is not remembered.
    this.resolvedRoot.catch(() => {
      this.resolvedRoot = undefined;
    });
    return this.resolvedRoot;
  }

  /** The task's directory; with `create`, made (privately) as needed. Every component must be a real directory. */
  private async taskDir(ref: AttachmentRef, create: boolean): Promise<string> {
    checkRef(ref);
    let dir = await this.root();
    for (const part of [ref.projectKey, ref.taskKey]) {
      dir = join(dir, part);
      if (create) {
        try {
          await mkdir(dir, { mode: 0o700 });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('unsafe attachment storage directory');
    }
    return dir;
  }

  async create(ref: AttachmentRef): Promise<AttachmentWriter> {
    const dir = await this.taskDir(ref, true);
    const temporary = join(dir, `${ref.id}${TEMPORARY_SUFFIX}`);
    const published = join(dir, ref.id);
    // O_EXCL: never an existing file, and never through a link.
    const handle = await open(temporary, 'wx', 0o600);
    // Flushed to disk when the stream ends, closed whenever it ends or fails.
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

  async openRead(ref: AttachmentRef, size: number): Promise<Readable> {
    const dir = await this.taskDir(ref, false);
    const handle = await open(join(dir, ref.id), constants.O_RDONLY | O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('attachment is not a regular file');
      if (stat.size !== size) throw new Error('attachment size does not match the stored metadata');
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
    return handle.createReadStream();
  }

  async remove(ref: AttachmentRef): Promise<void> {
    let dir: string;
    try {
      dir = await this.taskDir(ref, false);
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    await unlinkIfThere(join(dir, ref.id));
    await unlinkIfThere(join(dir, `${ref.id}${TEMPORARY_SUFFIX}`));
  }

  async removeTemporary(ref: AttachmentRef): Promise<void> {
    let dir: string;
    try {
      dir = await this.taskDir(ref, false);
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    await unlinkIfThere(join(dir, `${ref.id}${TEMPORARY_SUFFIX}`));
  }

  async scan(): Promise<StoredFile[]> {
    const root = await this.root();
    const found: StoredFile[] = [];
    for (const projectKey of await readdir(root)) {
      if (!PROJECT_KEY.test(projectKey)) continue;
      for (const taskKey of await entriesOfDirectory(join(root, projectKey))) {
        if (!TaskKey.safeParse(taskKey).success) continue;
        for (const name of await entriesOfDirectory(join(root, projectKey, taskKey))) {
          const stat = await lstat(join(root, projectKey, taskKey, name));
          if (stat.isFile()) found.push({ projectKey, taskKey, name });
        }
      }
    }
    return found;
  }
}

/** The names in a real directory; nothing for a file or a link (a scan never follows links). */
async function entriesOfDirectory(path: string): Promise<string[]> {
  const stat = await lstat(path);
  return stat.isDirectory() ? readdir(path) : [];
}
