import { domToCanvas } from 'modern-screenshot';
import type { FeedbackScreenshotUpload } from '@projectman/shared';
import type { Point, Rect } from './anchor';

/**
 * The screenshot of a mark (PM-506): the visible part of the page, at most 1600 px wide, as a JPEG at
 * quality 0.8; over 2 MB at 0.6; over 2 MB again → no screenshot (the mark goes without one). The
 * widget's own elements are left out, and the marked place is drawn on the image in the marker's colour.
 *
 * PM-920: a picture that cannot be made says why (`ShotFailure`, one console line), and one slow or
 * blocked image no longer spoils the whole picture: each resource has its own short limit, a missing
 * one is replaced by a blank pixel, and images far outside the window are not downloaded at all.
 */
export const MAX_SHOT_WIDTH = 1600;
/** The server's limit (`MAX_FEEDBACK_SCREENSHOT_BYTES`; only types come from `shared` into the bundle). */
export const MAX_SHOT_BYTES = 2_000_000;
export const SHOT_QUALITIES = [0.8, 0.6] as const;
/** How long one image may take; the whole picture has 20 s (`SHOT_TIMEOUT_MS` in the controller). */
export const RESOURCE_TIMEOUT_MS = 5000;
/** Images this far (CSS px) outside the window are still downloaded, so a small scroll shows no blanks. */
const OFFSCREEN_MARGIN = 200;
const MAX_REPORTED_URLS = 5;
/** A transparent 1×1 GIF, shown where an image could not be loaded. */
export const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** The marked place in viewport coordinates (CSS pixels); null: the whole page. */
export interface ShotHighlight {
  rect: Rect | null;
  point: Point | null;
  color: string;
}

export type ShotFailure =
  /** The whole picture took longer than its limit. */
  | { kind: 'timeout' }
  /** Images that could not be loaded (their addresses without query and fragment, at most 5). */
  | { kind: 'resource'; urls: string[] }
  /** The canvas is tainted by an image from another origin. */
  | { kind: 'tainted' }
  /** The picture is over the size limit at the lowest quality. */
  | { kind: 'too_large' }
  /** Anything else: only the error's name, never its message. */
  | { kind: 'error'; name: string };

export type ShotOutcome =
  | {
      ok: true;
      upload: FeedbackScreenshotUpload;
      preview: string;
      /** Images missing from the finished picture (blank places). */
      missing: string[];
    }
  | { ok: false; failure: ShotFailure };

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

export function drawHighlight(
  canvas: HTMLCanvasElement,
  viewportWidth: number,
  highlight: ShotHighlight,
): void {
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

// --- why a picture failed (PM-920)

/**
 * An address safe to print: origin and path only (the query and the fragment may hold tokens);
 * inline data is just "data:".
 */
export function resourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      return `${parsed.origin}${parsed.pathname}`;
    return `${parsed.protocol}`;
  } catch {
    return '(invalid address)';
  }
}

const unique = (values: Iterable<string>): string[] => [...new Set(values)];

/** Sorts a thrown error into a failure kind; images that were missing along the way come first. */
export function classifyShotError(error: unknown, missing: string[]): ShotFailure {
  if (missing.length > 0) return { kind: 'resource', urls: unique(missing).slice(0, MAX_REPORTED_URLS) };
  const name = error instanceof Error || error instanceof DOMException ? error.name : typeof error;
  if (name === 'SecurityError') return { kind: 'tainted' };
  return { kind: 'error', name };
}

/** The console line for a failure (English; the address and the kind only, never page content). */
export function shotFailureLine(failure: ShotFailure): string {
  const prefix = '[projectman feedback] screenshot failed:';
  switch (failure.kind) {
    case 'timeout':
      return `${prefix} timeout`;
    case 'resource':
      return `${prefix} resource ${failure.urls.join(' ')}`;
    case 'tainted':
      return `${prefix} tainted canvas (an image from another origin without CORS headers)`;
    case 'too_large':
      return `${prefix} too large`;
    case 'error':
      return `${prefix} error ${failure.name}`;
  }
}

/** The console line for a picture that was made with blank places. */
export const shotMissingLine = (missing: string[]): string =>
  `[projectman feedback] screenshot made without ${missing.length} resource${missing.length === 1 ? '' : 's'}: ${missing.slice(0, MAX_REPORTED_URLS).join(' ')}`;

// --- resources (PM-920)

const rectsIntersect = (rect: DOMRect, width: number, height: number, margin: number): boolean =>
  rect.right > -margin && rect.left < width + margin && rect.bottom > -margin && rect.top < height + margin;

/**
 * The addresses of `<img>`s that are far outside the window and not used by any image inside it. They
 * are not downloaded for the picture (a long page full of lazy images would otherwise take ages).
 */
export function offscreenImageUrls(doc: Document, viewport: { width: number; height: number }): Set<string> {
  const visible = new Set<string>();
  const outside = new Set<string>();
  for (const image of Array.from(doc.querySelectorAll('img'))) {
    const url = image.currentSrc || image.src;
    if (!url || url.startsWith('data:')) continue;
    const rect = image.getBoundingClientRect();
    (rectsIntersect(rect, viewport.width, viewport.height, OFFSCREEN_MARGIN) ? visible : outside).add(url);
  }
  for (const url of visible) outside.delete(url);
  return outside;
}

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * The image downloader of the picture: data URL on success; on a failure or after `timeoutMs` the
 * address goes into `missing` and a blank pixel stands in, so one image never fails the picture.
 */
export function createImageFetcher(
  win: Window,
  options: { skip: ReadonlySet<string>; missing: Set<string>; timeoutMs?: number },
): (url: string) => Promise<string> {
  const timeoutMs = options.timeoutMs ?? RESOURCE_TIMEOUT_MS;
  return async (url) => {
    if (options.skip.has(url)) return BLANK_PIXEL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await win.fetch(url, { signal: controller.signal, cache: 'force-cache' });
      if (!response.ok) throw new Error(`status ${response.status}`);
      return await readAsDataUrl(await response.blob());
    } catch {
      options.missing.add(resourceUrl(url));
      return BLANK_PIXEL;
    } finally {
      clearTimeout(timer);
    }
  };
}

// --- the picture

export interface RenderHooks {
  /** Nodes that stay out of the picture (the widget's own). */
  skip(node: Node): boolean;
  /** Loads an image as a data URL (never rejects). */
  image(url: string): Promise<string>;
}

/** The one place that calls the rendering library: the visible part of the page as a canvas. */
export function renderViewport(
  win: Window,
  size: { width: number; height: number; scale: number },
  hooks: RenderHooks,
): Promise<HTMLCanvasElement> {
  return domToCanvas(win.document.documentElement, {
    width: size.width,
    height: size.height,
    scale: size.scale,
    backgroundColor: '#ffffff',
    // The library's own limit is 30 s for each font and stylesheet; ours is shorter than the whole.
    timeout: RESOURCE_TIMEOUT_MS * 2,
    style: { transform: `translate(${-win.scrollX}px, ${-win.scrollY}px)`, transformOrigin: 'top left' },
    filter: (node) => !hooks.skip(node),
    fetchFn: hooks.image,
  });
}

/** Renders the visible part of the page; says why when it could not be made or does not fit the limit. */
export async function captureScreenshot(win: Window, highlight: ShotHighlight | null): Promise<ShotOutcome> {
  const missing = new Set<string>();
  try {
    const width = Math.max(1, Math.round(win.innerWidth));
    const height = Math.max(1, Math.round(win.innerHeight));
    const image = createImageFetcher(win, {
      skip: offscreenImageUrls(win.document, { width, height }),
      missing,
    });
    const canvas = await renderViewport(
      win,
      { width, height, scale: shotScale(width) },
      { skip: (node) => node instanceof Element && node.hasAttribute(HOST_ATTRIBUTE), image },
    );
    if (highlight) drawHighlight(canvas, width, highlight);
    const upload = encodeWithinLimit(canvas);
    if (!upload) return { ok: false, failure: { kind: 'too_large' } };
    return {
      ok: true,
      upload,
      preview: `data:${upload.mediaType};base64,${upload.dataBase64}`,
      missing: [...missing],
    };
  } catch (error) {
    return { ok: false, failure: classifyShotError(error, [...missing]) };
  }
}
