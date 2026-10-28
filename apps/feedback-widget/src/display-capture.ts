import {
  HOST_ATTRIBUTE,
  MAX_SHOT_WIDTH,
  drawHighlight,
  encodeWithinLimit,
  type ShotHighlight,
  type ShotOutcome,
} from './screenshot';

/**
 * A real picture of the page made with the browser's screen sharing (`getDisplayMedia`, PM-921). The
 * fallback for the automatic picture: the user allows it once and the share stays open until the marking
 * ends, so the following marks take their picture from it without asking again. The frames never leave
 * the browser; only the one picture that goes with the mark is uploaded, and there is no audio.
 */

export type ShareSurface = 'browser' | 'window' | 'monitor' | 'unknown';

export interface GrabResult {
  outcome: ShotOutcome;
  /** The marked place was drawn on the picture (only when the shared surface is this very tab). */
  marked: boolean;
}

export interface DisplayShare {
  readonly surface: ShareSurface;
  /** One picture of the visible page, made without the widget's own parts. */
  grab(win: Window, highlight: ShotHighlight | null): Promise<GrabResult>;
  /** Stops every track: the browser's sharing indicator goes away. */
  stop(): void;
  /** The browser (not `stop`) ended the share, for example from its sharing bar. */
  onEnded(listener: () => void): void;
}

export class ShareRefused extends Error {
  reason: 'denied' | 'error';
  constructor(reason: 'denied' | 'error') {
    super(`screen sharing ${reason}`);
    this.name = 'ShareRefused';
    this.reason = reason;
  }
}

/** The frame and the window may differ this much in aspect ratio and still be the same page. */
const FRAME_TOLERANCE = 0.02;
/** A new frame is waited for this long at most (a still or hidden page may not produce one). */
const FRAME_WAIT_MS = 1000;
const FALLBACK_FRAME_MS = 120;

type Policy = { allowsFeature?: (feature: string) => boolean };
type PolicyDocument = Document & { permissionsPolicy?: Policy; featurePolicy?: Policy };

/** Whether this browser, in this page, may share the screen at all. */
export function canShareDisplay(win: Window): boolean {
  if (!win.isSecureContext) return false;
  if (typeof win.navigator.mediaDevices?.getDisplayMedia !== 'function') return false;
  const doc = win.document as PolicyDocument;
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  return policy?.allowsFeature?.('display-capture') ?? true;
}

/**
 * The shared surface is the page itself, so the marked place can be drawn on it: a tab whose frame has
 * the window's proportions (the sharing bar may narrow the view, which changes them).
 */
export function framesMatch(
  frame: { width: number; height: number },
  view: { width: number; height: number },
  surface: ShareSurface,
): boolean {
  if (surface !== 'browser') return false;
  if (frame.width <= 0 || frame.height <= 0 || view.width <= 0 || view.height <= 0) return false;
  const framed = frame.width / frame.height;
  const viewed = view.width / view.height;
  return Math.abs(framed - viewed) / viewed <= FRAME_TOLERANCE;
}

const surfaceOf = (value: unknown): ShareSurface =>
  value === 'browser' || value === 'window' || value === 'monitor' ? value : 'unknown';

const nextFrames = (win: Window, video: HTMLVideoElement): Promise<void> =>
  new Promise<void>((resolve) => {
    win.requestAnimationFrame(() => {
      win.requestAnimationFrame(() => {
        if (typeof video.requestVideoFrameCallback === 'function') {
          const timer = setTimeout(resolve, FRAME_WAIT_MS);
          video.requestVideoFrameCallback(() => {
            clearTimeout(timer);
            resolve();
          });
        } else setTimeout(resolve, FALLBACK_FRAME_MS);
      });
    });
  });

/** Asks for the share. Throws `ShareRefused`: `denied` when the user (or the page's policy) said no. */
export async function startShare(win: Window): Promise<DisplayShare> {
  // The non-standard keys (Chrome's hints) are not in the DOM typings.
  const constraints: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: { displaySurface: 'browser', frameRate: 5 },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
  };
  let stream: MediaStream;
  try {
    stream = await win.navigator.mediaDevices.getDisplayMedia(constraints);
  } catch (error) {
    throw new ShareRefused(error instanceof Error && error.name === 'NotAllowedError' ? 'denied' : 'error');
  }
  const stopAll = (): void => stream.getTracks().forEach((track) => track.stop());
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopAll();
    throw new ShareRefused('error');
  }
  // The frames are read from a video that is never put on the page.
  const video = win.document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    stopAll();
    throw new ShareRefused('error');
  }
  const surface = surfaceOf(track.getSettings().displaySurface);

  return {
    surface,
    stop() {
      stopAll();
      video.srcObject = null;
    },
    onEnded(listener) {
      track.addEventListener('ended', listener);
    },
    async grab(target, highlight) {
      const hosts = [...target.document.querySelectorAll<HTMLElement>(`[${HOST_ATTRIBUTE}]`)];
      const before = hosts.map((host) => host.style.visibility);
      try {
        for (const host of hosts) host.style.visibility = 'hidden';
        await nextFrames(target, video);
        return paint(target, video, surface, highlight);
      } catch (error) {
        const name = error instanceof Error ? error.name : 'Error';
        return { outcome: { ok: false, failure: { kind: 'error', name } }, marked: false };
      } finally {
        hosts.forEach((host, index) => (host.style.visibility = before[index] ?? ''));
      }
    },
  };
}

function paint(
  win: Window,
  video: HTMLVideoElement,
  surface: ShareSurface,
  highlight: ShotHighlight | null,
): GrabResult {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) {
    return { outcome: { ok: false, failure: { kind: 'error', name: 'EmptyFrame' } }, marked: false };
  }
  const scale = Math.min(1, MAX_SHOT_WIDTH / videoWidth);
  const canvas = win.document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(videoWidth * scale));
  canvas.height = Math.max(1, Math.round(videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context)
    return { outcome: { ok: false, failure: { kind: 'error', name: 'NoCanvas' } }, marked: false };
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const marked =
    highlight !== null &&
    framesMatch(
      { width: videoWidth, height: videoHeight },
      { width: win.innerWidth, height: win.innerHeight },
      surface,
    );
  if (marked && highlight) drawHighlight(canvas, win.innerWidth, highlight);
  const upload = encodeWithinLimit(canvas);
  if (!upload) return { outcome: { ok: false, failure: { kind: 'too_large' } }, marked };
  return {
    outcome: {
      ok: true,
      upload,
      preview: `data:${upload.mediaType};base64,${upload.dataBase64}`,
      missing: [],
    },
    marked,
  };
}
