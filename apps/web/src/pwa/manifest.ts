/**
 * Colours of the installed app's chrome. They mirror `--c-page` in styles/tokens.css (light and dark);
 * `manifest.test.ts` checks that they still match.
 */
export const PWA_COLORS = {
  lightPage: '#F5F4EF',
  darkPage: '#141412',
} as const;

export interface PwaText {
  name: string;
  description: string;
}

interface ManifestIcon {
  src: string;
  sizes: string;
  type: 'image/png';
  purpose: 'any' | 'maskable';
}

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  lang: 'hu';
  dir: 'ltr';
  start_url: string;
  scope: string;
  display: 'standalone';
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

/** One icon per size and purpose: `any` is the rounded tile, `maskable` the full-bleed square. */
const ICONS: ManifestIcon[] = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

/** The web app manifest. The names come from the locale file (`app.name`, `pwa.description`). */
export function buildManifest(text: PwaText): WebManifest {
  return {
    id: '/',
    name: text.name,
    short_name: text.name,
    description: text.description,
    lang: 'hu',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: PWA_COLORS.lightPage,
    background_color: PWA_COLORS.lightPage,
    icons: ICONS.map((icon) => ({ ...icon })),
  };
}
