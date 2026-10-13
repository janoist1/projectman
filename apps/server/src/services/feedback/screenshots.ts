import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { FeedbackMarkId, MAX_FEEDBACK_SCREENSHOT_BYTES } from '@projectman/shared';
import type { FeedbackScreenshotUpload } from '@projectman/shared';
import type { StoredFeedbackScreenshot } from '../../db';
import { DomainError } from '../../domain/errors';
import { sniffMediaType } from '../../domain/attachments';

/** The longest side of a screenshot's thumbnail, in pixels. */
const THUMBNAIL_MAX_SIDE = 640;
/** A screenshot above this many pixels is not decoded. */
const MAX_INPUT_PIXELS = 100_000_000;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
const SHARP_FORMATS = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' } as const;

const invalidScreenshot = (message: string) =>
  new DomainError('feedback_screenshot_invalid', message, { status: 422 });

/** A screenshot checked and ready to store: the original bytes, its thumbnail and what the views show. */
export interface PreparedScreenshot {
  original: Buffer;
  thumbnail: Buffer;
  extension: 'jpg' | 'png' | 'webp';
  meta: Omit<StoredFeedbackScreenshot, 'file'>;
}

/**
 * Decodes and checks an uploaded screenshot: it must be at most 2 MB, and its own content must
 * prove it is the PNG, JPEG or WebP it says (the declared type is never trusted); width and height
 * come from the image header. Makes the WebP thumbnail (at most 640 px a side, no metadata).
 */
export async function prepareScreenshot(upload: FeedbackScreenshotUpload): Promise<PreparedScreenshot> {
  if (!BASE64.test(upload.dataBase64) || upload.dataBase64.length % 4 !== 0)
    throw invalidScreenshot('the screenshot is not base64');
  const original = Buffer.from(upload.dataBase64, 'base64');
  if (original.length > MAX_FEEDBACK_SCREENSHOT_BYTES)
    throw new DomainError('feedback_screenshot_too_large', 'the screenshot is too large', {
      status: 413,
      details: { maxBytes: MAX_FEEDBACK_SCREENSHOT_BYTES },
    });
  if (sniffMediaType(original.subarray(0, 16)) !== upload.mediaType)
    throw invalidScreenshot('the screenshot content is not the declared image type');
  try {
    const image = sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
    const meta = await image.metadata();
    if (meta.format !== SHARP_FORMATS[upload.mediaType] || !meta.width || !meta.height)
      throw invalidScreenshot('the screenshot content is not the declared image type');
    const thumbnail = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({
        width: THUMBNAIL_MAX_SIDE,
        height: THUMBNAIL_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 75 })
      .toBuffer();
    return {
      original,
      thumbnail,
      extension: EXTENSIONS[upload.mediaType],
      meta: { mediaType: upload.mediaType, size: original.length, width: meta.width, height: meta.height },
    };
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw invalidScreenshot('the screenshot could not be decoded');
  }
}

/**
 * The screenshots of marks, under `<root>/<projectKey>/<markId>.<ext>` and `<markId>.thumb`
 * (`PROJECTMAN_HOME/feedback`). The directories are private (0700), the files 0600. The names are
 * server made (a checked key and a generated id), never the client's; a file is written beside its
 * place and renamed into it, and only a regular file is ever read.
 */
export class FeedbackScreenshotStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private directory(projectKey: string): string {
    if (!PROJECT_KEY.test(projectKey)) throw new Error('unsafe feedback storage reference');
    return join(this.rootDir, projectKey);
  }

  private path(projectKey: string, name: string): string {
    return join(this.directory(projectKey), name);
  }

  /** Stores the screenshot and its thumbnail for the mark; returns what the mark's row keeps. */
  async put(
    projectKey: string,
    markId: string,
    prepared: PreparedScreenshot,
  ): Promise<StoredFeedbackScreenshot> {
    if (!FeedbackMarkId.safeParse(markId).success) throw new Error('unsafe feedback storage reference');
    const dir = this.directory(projectKey);
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const file = `${markId}.${prepared.extension}`;
    try {
      await this.write(this.path(projectKey, file), prepared.original);
      await this.write(this.path(projectKey, `${markId}.thumb`), prepared.thumbnail);
    } catch (err) {
      await this.remove(projectKey, { ...prepared.meta, file }).catch(() => undefined);
      throw err;
    }
    return { ...prepared.meta, file };
  }

  private async write(target: string, bytes: Buffer): Promise<void> {
    const part = `${target}.part`;
    await writeFile(part, bytes, { mode: 0o600, flag: 'w' });
    await chmod(part, 0o600);
    await rename(part, target);
  }

  /** The stored bytes of the original, or of the thumbnail (a WebP). */
  async open(
    projectKey: string,
    screenshot: StoredFeedbackScreenshot,
    thumbnail: boolean,
  ): Promise<{ stream: Readable; size: number; mediaType: string }> {
    const name = thumbnail ? screenshot.file.replace(/\.[a-z]+$/, '.thumb') : screenshot.file;
    const target = this.path(projectKey, name);
    const info = await lstat(target);
    if (!info.isFile()) throw new Error('the screenshot is not a regular file');
    return {
      stream: createReadStream(target),
      size: info.size,
      mediaType: thumbnail ? 'image/webp' : screenshot.mediaType,
    };
  }

  /** The path of the stored original on this machine, when it is a regular file (for a session that runs here). */
  async locate(projectKey: string, screenshot: StoredFeedbackScreenshot): Promise<string> {
    const target = this.path(projectKey, screenshot.file);
    if (!(await lstat(target)).isFile()) throw new Error('the screenshot is not a regular file');
    return target;
  }

  /** The original's bytes (to attach it to a card). */
  async read(projectKey: string, screenshot: StoredFeedbackScreenshot): Promise<Buffer> {
    const { stream } = await this.open(projectKey, screenshot, false);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async remove(projectKey: string, screenshot: StoredFeedbackScreenshot): Promise<void> {
    const thumb = screenshot.file.replace(/\.[a-z]+$/, '.thumb');
    for (const name of [screenshot.file, `${screenshot.file}.part`, thumb, `${thumb}.part`])
      await rm(this.path(projectKey, name), { force: true });
  }
}
