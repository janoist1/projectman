import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';
import { AttachmentId, TaskKey } from '@projectman/shared';
import type { AttachmentRef, AttachmentStorage, AttachmentWriter, StoredFile } from '../../contracts';

/** Suffix of a file still being written; recovery removes every one it finds. */
export const TEMPORARY_SUFFIX = '.part';

/**
 * The extension of a published file's view (`<id>.<ext>`, a second name of the same file): the
 * agents' readers pick images and PDFs by the extension of the path. Only the inline types, which
 * were proven from the content.
 */
const VIEW_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
const VIEW_SUFFIXES = Object.values(VIEW_EXTENSIONS).map((ext) => `.${ext}`);

/** The attachment id of a view's file name, or null when the name is not a view's. */
export function viewOwner(name: string): string | null {
  const suffix = VIEW_SUFFIXES.find((s) => name.endsWith(s));
  if (!suffix) return null;
  const id = name.slice(0, -suffix.length);
  return AttachmentId.safeParse(id).success ? id : null;
}

const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** A path component that is not what storage creates itself: a bug, never a user's input. */
function checkRef(ref: AttachmentRef): void {
  checkTask(ref.projectKey, ref.taskKey);
  if (!AttachmentId.safeParse(ref.id).success) throw new Error('unsafe attachment storage reference');
}

function checkTask(projectKey: string, taskKey: string): void {
  if (!PROJECT_KEY.test(projectKey) || !TaskKey.safeParse(taskKey).success) {
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
 * (to another disk): it is resolved once. An image or a PDF an agent asked for also has a view,
 * `<id>.<ext>`: a hard link to the same file, removed with it.
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
    const { handle } = await this.openChecked(ref, size);
    return handle.createReadStream();
  }

  async locate(ref: AttachmentRef, size: number, mediaType: string): Promise<string> {
    const { handle, path } = await this.openChecked(ref, size);
    try {
      const ext = VIEW_EXTENSIONS[mediaType];
      if (!ext) return path;
      // A hard link next to the file: the same bytes under a name with its extension, made once.
      const view = `${path}.${ext}`;
      const file = await handle.stat();
      try {
        await link(path, view);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const existing = await lstat(view);
        if (!existing.isFile() || existing.ino !== file.ino || existing.dev !== file.dev) {
          await unlink(view);
          await link(path, view);
        }
      }
      return view;
    } finally {
      await handle.close();
    }
  }

  async taskDirectory(projectKey: string, taskKey: string): Promise<string> {
    checkTask(projectKey, taskKey);
    return join(await this.root(), projectKey, taskKey);
  }

  /** The published file, opened without following a link; it must be a regular file of `size` bytes. */
  private async openChecked(ref: AttachmentRef, size: number): Promise<{ handle: FileHandle; path: string }> {
    const dir = await this.taskDir(ref, false);
    const path = join(dir, ref.id);
    const handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('attachment is not a regular file');
      if (stat.size !== size) throw new Error('attachment size does not match the stored metadata');
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
    return { handle, path };
  }

  async remove(ref: AttachmentRef): Promise<void> {
    let dir: string;
    try {
      dir = await this.taskDir(ref, false);
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    // The file first: a view made meanwhile is then removed below, and none can be made after.
    await unlinkIfThere(join(dir, ref.id));
    await unlinkIfThere(join(dir, `${ref.id}${TEMPORARY_SUFFIX}`));
    for (const suffix of VIEW_SUFFIXES) await unlinkIfThere(join(dir, `${ref.id}${suffix}`));
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
