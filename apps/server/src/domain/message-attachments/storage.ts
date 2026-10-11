import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { MessageAttachmentId } from '@projectman/shared';
import type {
  AttachmentThumbnail,
  AttachmentWriter,
  MessageAttachmentFileRef,
  MessageAttachmentStorage,
  StoredMessageFile,
} from '../../contracts';
import {
  createWritableFile,
  isMissing,
  O_NOFOLLOW,
  TEMPORARY_SUFFIX,
  THUMBNAIL_SUFFIX,
  unlinkIfThere,
} from '../attachments/files';

const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;

/** A path component that is not what storage creates itself: a bug, never a user's input. */
function checkRef(ref: MessageAttachmentFileRef): void {
  if (!PROJECT_KEY.test(ref.projectKey) || !MessageAttachmentId.safeParse(ref.id).success) {
    throw new Error('unsafe message attachment storage reference');
  }
}

/**
 * The id a stored file's name belongs to: the name of a file, of its thumbnail (`.thumb`) or of
 * the temporary file of either (`.part`); null for a name storage did not make.
 */
export function messageFileOwner(name: string): string | null {
  let stem = name.endsWith(TEMPORARY_SUFFIX) ? name.slice(0, -TEMPORARY_SUFFIX.length) : name;
  if (stem.endsWith(THUMBNAIL_SUFFIX)) stem = stem.slice(0, -THUMBNAIL_SUFFIX.length);
  return MessageAttachmentId.safeParse(stem).success ? stem : null;
}

/**
 * Message attachment files under `<root>/<projectKey>/<id>` (`PROJECTMAN_HOME/message-attachments`),
 * with the same care as the card attachments' storage: private directories (0700) and files
 * (0600), server made names only, every directory a real one, files created exclusively and opened
 * without following a link, only regular files read. The root itself may be a link the owner set
 * up: it is resolved once.
 */
export class FileMessageAttachmentStorage implements MessageAttachmentStorage {
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

  /** The project's directory; with `create`, made (privately) as needed. It must be a real directory. */
  private async projectDir(ref: MessageAttachmentFileRef, create: boolean): Promise<string> {
    checkRef(ref);
    const dir = join(await this.root(), ref.projectKey);
    if (create) {
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('unsafe message attachment storage directory');
    }
    return dir;
  }

  async create(ref: MessageAttachmentFileRef): Promise<AttachmentWriter> {
    return createWritableFile(await this.projectDir(ref, true), ref.id);
  }

  async createThumbnail(ref: MessageAttachmentFileRef): Promise<AttachmentWriter> {
    return createWritableFile(await this.projectDir(ref, true), `${ref.id}${THUMBNAIL_SUFFIX}`);
  }

  async openRead(ref: MessageAttachmentFileRef, size: number): Promise<Readable> {
    const dir = await this.projectDir(ref, false);
    const handle = await open(join(dir, ref.id), constants.O_RDONLY | O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('message attachment is not a regular file');
      if (stat.size !== size) throw new Error('message attachment size does not match the stored metadata');
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
    return handle.createReadStream();
  }

  async openThumbnail(ref: MessageAttachmentFileRef): Promise<AttachmentThumbnail | null> {
    const dir = await this.projectDir(ref, false).catch((err: unknown) => {
      if (isMissing(err)) return null;
      throw err;
    });
    if (dir === null) return null;
    let handle: FileHandle;
    try {
      handle = await open(join(dir, `${ref.id}${THUMBNAIL_SUFFIX}`), constants.O_RDONLY | O_NOFOLLOW);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('message attachment thumbnail is not a regular file');
      return { stream: handle.createReadStream(), size: stat.size };
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
  }

  async remove(ref: MessageAttachmentFileRef): Promise<void> {
    const dir = await this.existingDir(ref);
    if (dir === null) return;
    await unlinkIfThere(join(dir, ref.id));
    await unlinkIfThere(join(dir, `${ref.id}${TEMPORARY_SUFFIX}`));
    await unlinkIfThere(join(dir, `${ref.id}${THUMBNAIL_SUFFIX}`));
    await unlinkIfThere(join(dir, `${ref.id}${THUMBNAIL_SUFFIX}${TEMPORARY_SUFFIX}`));
  }

  async removeTemporary(ref: MessageAttachmentFileRef): Promise<void> {
    const dir = await this.existingDir(ref);
    if (dir === null) return;
    await unlinkIfThere(join(dir, `${ref.id}${TEMPORARY_SUFFIX}`));
    await unlinkIfThere(join(dir, `${ref.id}${THUMBNAIL_SUFFIX}${TEMPORARY_SUFFIX}`));
  }

  async scan(): Promise<StoredMessageFile[]> {
    const root = await this.root();
    const found: StoredMessageFile[] = [];
    for (const projectKey of await readdir(root)) {
      if (!PROJECT_KEY.test(projectKey)) continue;
      const dir = join(root, projectKey);
      // A scan never follows links.
      if (!(await lstat(dir)).isDirectory()) continue;
      for (const name of await readdir(dir)) {
        if ((await lstat(join(dir, name))).isFile()) found.push({ projectKey, name });
      }
    }
    return found;
  }

  private async existingDir(ref: MessageAttachmentFileRef): Promise<string | null> {
    try {
      return await this.projectDir(ref, false);
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }
}
