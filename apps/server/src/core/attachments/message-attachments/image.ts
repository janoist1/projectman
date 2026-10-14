import sharp from 'sharp';
import { MESSAGE_IMAGE_MAX_BYTES, MESSAGE_IMAGE_MAX_SIDE } from '../../../contracts';
import { MAX_INPUT_PIXELS, TIMEOUT_SECONDS } from '../attachments/thumbnail';

const FIRST_QUALITY = 85;
const SECOND_QUALITY = 60;
const MAX_CONCURRENT = 2;

/**
 * Renders a stored image as the WebP an AI member sees: the first frame, rotated by its EXIF
 * orientation, at most 1568 px a side (never enlarged), without metadata. Nothing is stored: it is
 * made on each request. The decoder runs on content a client uploaded, so it is bounded as the
 * thumbnails' is: a pixel limit, a time limit and at most two runs at a time.
 */
export class MessageImageRenderer {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  /**
   * The WebP bytes of the image (quality 85, or 60 when that is over the byte limit); null when even
   * that is over the limit. Throws when the image cannot be decoded.
   */
  async render(image: Buffer): Promise<Buffer | null> {
    if (this.active >= MAX_CONCURRENT) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      for (const quality of [FIRST_QUALITY, SECOND_QUALITY]) {
        const webp = await sharp(image, { limitInputPixels: MAX_INPUT_PIXELS })
          .rotate()
          .resize({
            width: MESSAGE_IMAGE_MAX_SIDE,
            height: MESSAGE_IMAGE_MAX_SIDE,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality })
          .timeout({ seconds: TIMEOUT_SECONDS })
          .toBuffer();
        if (webp.length <= MESSAGE_IMAGE_MAX_BYTES) return webp;
      }
      return null;
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
