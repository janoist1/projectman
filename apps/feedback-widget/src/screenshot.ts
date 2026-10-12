import { domToCanvas } from 'modern-screenshot';
import type { FeedbackScreenshotUpload } from '@projectman/shared';
import type { Point, Rect } from './anchor';

/**
 * The screenshot of a mark (PM-506): the visible part of the page, at most 1600 px wide, as a JPEG at
 * quality 0.8; over 2 MB at 0.6; over 2 MB again → no screenshot (the mark goes without one). The
 * widget's own elements are left out, and the marked place is drawn on the image in the marker's colour.
 */
export const MAX_SHOT_WIDTH = 1600;
/** The server's limit (`MAX_FEEDBACK_SCREENSHOT_BYTES`; only types come from `shared` into the bundle). */
export const MAX_SHOT_BYTES = 2_000_000;
export const SHOT_QUALITIES = [0.8, 0.6] as const;

/** The marked place in viewport coordinates (CSS pixels); null: the whole page. */
export interface ShotHighlight {
  rect: Rect | null;
  point: Point | null;
  color: string;
}

export const HOST_ATTRIBUTE = 'data-pm-feedback-host';

/** The decoded size of a base64 string. */
export const base64Bytes = (data: string): number => {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
};

type Encoder = { toDataURL(type: string, quality: number): string };

/** Encodes the canvas at the first quality that fits the limit, or returns null. */
export function encodeWithinLimit(canvas: Encoder): FeedbackScreenshotUpload | null {
  for (const quality of SHOT_QUALITIES) {
    const url = canvas.toDataURL('image/jpeg', quality);
    const data = url.slice(url.indexOf(',') + 1);
    if (data !== '' && base64Bytes(data) <= MAX_SHOT_BYTES) {
      return { mediaType: 'image/jpeg', dataBase64: data };
    }
  }
  return null;
}

/** The scale that keeps the image at most `MAX_SHOT_WIDTH` wide. */
export const shotScale = (viewportWidth: number): number => Math.min(1, MAX_SHOT_WIDTH / viewportWidth);

function drawHighlight(canvas: HTMLCanvasElement, viewportWidth: number, highlight: ShotHighlight): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const s = canvas.width / viewportWidth;
  context.lineWidth = 3 * s;
  context.strokeStyle = highlight.color;
  context.fillStyle = highlight.color;
  if (highlight.rect) {
    const { x, y, width, height } = highlight.rect;
    context.globalAlpha = 0.12;
    context.fillRect(x * s, y * s, width * s, height * s);
    context.globalAlpha = 1;
    context.strokeRect(x * s, y * s, width * s, height * s);
  } else if (highlight.point) {
    context.beginPath();
    context.arc(highlight.point.x * s, highlight.point.y * s, 12 * s, 0, Math.PI * 2);
    context.globalAlpha = 0.25;
    context.fill();
    context.globalAlpha = 1;
    context.stroke();
  }
}

/** Renders the visible part of the page; null when it could not be made or does not fit the limit. */
export async function captureScreenshot(
  win: Window,
  highlight: ShotHighlight | null,
): Promise<{ upload: FeedbackScreenshotUpload; preview: string } | null> {
  try {
    const width = Math.max(1, Math.round(win.innerWidth));
    const height = Math.max(1, Math.round(win.innerHeight));
    const canvas = await domToCanvas(win.document.documentElement, {
      width,
      height,
      scale: shotScale(width),
      backgroundColor: '#ffffff',
      style: { transform: `translate(${-win.scrollX}px, ${-win.scrollY}px)`, transformOrigin: 'top left' },
      filter: (node) => !(node instanceof Element && node.hasAttribute(HOST_ATTRIBUTE)),
    });
    if (highlight) drawHighlight(canvas, width, highlight);
    const upload = encodeWithinLimit(canvas);
    return upload ? { upload, preview: `data:${upload.mediaType};base64,${upload.dataBase64}` } : null;
  } catch {
    return null;
  }
}
