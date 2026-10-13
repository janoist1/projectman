import type { FeedbackEnvironment } from '@projectman/shared';

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const major = (match: RegExpMatchArray | null): string => (match?.[1] ? ` ${match[1]}` : '');

/** The browser name and major version from the user agent (a rough label for the processor). */
export function browserOf(userAgent: string): string {
  const pick = (re: RegExp): RegExpMatchArray | null => re.exec(userAgent);
  const edge = pick(/Edg(?:e|A|iOS)?\/(\d+)/);
  if (edge) return `Edge${major(edge)}`;
  const opera = pick(/OPR\/(\d+)/);
  if (opera) return `Opera${major(opera)}`;
  const firefox = pick(/(?:Firefox|FxiOS)\/(\d+)/);
  if (firefox) return `Firefox${major(firefox)}`;
  const chrome = pick(/(?:Chrome|CriOS)\/(\d+)/);
  if (chrome) return `Chrome${major(chrome)}`;
  const safari = pick(/Version\/(\d+).*Safari/);
  if (safari) return `Safari${major(safari)}`;
  return 'unknown';
}

export function osOf(userAgent: string): string {
  if (/Windows/.test(userAgent)) return 'Windows';
  if (/Android/.test(userAgent)) return 'Android';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'macOS';
  if (/CrOS/.test(userAgent)) return 'ChromeOS';
  if (/Linux/.test(userAgent)) return 'Linux';
  return 'unknown';
}

type Win = Pick<
  Window,
  'innerWidth' | 'innerHeight' | 'scrollX' | 'scrollY' | 'devicePixelRatio' | 'navigator'
>;

/** What the browser looked like when the mark was made (the processor reads it with the mark). */
export function collectEnvironment(win: Win): FeedbackEnvironment {
  const userAgent = (win.navigator.userAgent ?? '').slice(0, 500);
  return {
    viewport: {
      width: clamp(Math.round(win.innerWidth) || 1, 1, 20000),
      height: clamp(Math.round(win.innerHeight) || 1, 1, 20000),
    },
    scroll: { x: clamp(win.scrollX || 0, 0, 1_000_000), y: clamp(win.scrollY || 0, 0, 1_000_000) },
    devicePixelRatio: clamp(win.devicePixelRatio || 1, 0.25, 8),
    userAgent,
    browser: browserOf(userAgent).slice(0, 60),
    os: osOf(userAgent).slice(0, 60),
    language: (win.navigator.language ?? '').slice(0, 35),
  };
}
