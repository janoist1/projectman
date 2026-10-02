import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import sharp from 'sharp';
import type { AttachmentRef, AttachmentStorage } from '../../contracts';

/** The longest side of a thumbnail, in pixels. */
export const THUMBNAIL_MAX_SIDE = 640;

/** An uploaded image above this many pixels (width x height) is not decoded. */
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_CONCURRENT = 2;
const TIMEOUT_SECONDS = 15;

// Thumbnails are made once and kept on disk: libvips' operation cache would only hold memory.
sharp.cache(false);

/**
 * Makes the thumbnail of an image attachment: a WebP of at most 640 px a side, from the first frame,
 * rotated by its EXIF orientation, without any metadata (EXIF, GPS). The decoder runs on content
 * a client uploaded, so it is bounded: a pixel limit, a time limit, sequential reading, one run
 * per attachment (callers share it) and at most two runs at a time. An image that cannot be
 * made into a thumbnail is remembered until the server restarts, so that it is not decoded again.
 */
export class ThumbnailMaker {
  private readonly storage: AttachmentStorage;
  private readonly running = new Map<string, Promise<boolean>>();
  private readonly failed = new Set<string>();
  private readonly waiting: Array<() => void> = [];
  private readonly onFailure: (err: unknown, id: string) => void;
  private active = 0;

  constructor(storage: AttachmentStorage, onFailure: (err: unknown, id: string) => void) {
    this.storage = storage;
    this.onFailure = onFailure;
  }

  /**
   * Makes and stores the thumbnail of `ref`, whose file is `size` bytes. Resolves true when it is
   * stored, false when the image cannot be decoded (now or in an earlier attempt).
   */
  make(ref: AttachmentRef, size: number): Promise<boolean> {
    if (this.failed.has(ref.id)) return Promise.resolve(false);
    let run = this.running.get(ref.id);
    if (!run) {
      run = this.limited(() => this.render(ref, size)).finally(() => this.running.delete(ref.id));
      this.running.set(ref.id, run);
    }
    return run;
  }

  /** Forgets what is remembered of a deleted attachment. */
  forget(id: string): void {
    this.failed.delete(id);
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private async render(ref: AttachmentRef, size: number): Promise<boolean> {
    let source: Readable | undefined;
    try {
      source = await this.storage.openRead(ref, size);
      const decoder = sharp({ limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true })
        .rotate()
        .resize({
          width: THUMBNAIL_MAX_SIDE,
          height: THUMBNAIL_MAX_SIDE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 75 })
        .timeout({ seconds: TIMEOUT_SECONDS });
      source.once('error', (err) => decoder.destroy(err));
      source.pipe(decoder);
      const bytes = await decoder.toBuffer();
      const writer = await this.storage.createThumbnail(ref);
      try {
        writer.stream.end(bytes);
        await finished(writer.stream);
        await writer.publish();
      } catch (err) {
        await writer.discard();
        throw err;
      }
      return true;
    } catch (err) {
      this.onFailure(err, ref.id);
      this.failed.add(ref.id);
      return false;
    } finally {
      source?.destroy();
    }
  }
}
