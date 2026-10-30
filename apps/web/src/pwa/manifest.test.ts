import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { buildPwaFiles } from '../../vite-plugin-pwa';
import { buildManifest, PWA_COLORS } from './manifest';

const here = (path: string) => resolve(dirname(fileURLToPath(import.meta.url)), path);
const read = (path: string) => readFileSync(here(path), 'utf8');

describe('web app manifest', () => {
  const manifest = buildManifest({ name: en.app.name, description: en.pwa.description });

  it('has the fields installability needs', () => {
    expect(manifest).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      lang: 'en',
      dir: 'ltr',
      name: en.app.name,
      short_name: en.app.name,
      description: en.pwa.description,
    });
    expect(manifest).not.toHaveProperty('orientation');
  });

  it('lists any and maskable icons at 192 and 512 px, and the files exist', () => {
    const key = (i: { sizes: string; purpose: string }) => `${i.purpose}-${i.sizes}`;
    expect(manifest.icons.map(key).sort()).toEqual([
      'any-192x192',
      'any-512x512',
      'maskable-192x192',
      'maskable-512x512',
    ]);
    for (const icon of manifest.icons) {
      expect(existsSync(here(`../../public${icon.src}`)), icon.src).toBe(true);
    }
    expect(existsSync(here('../../public/apple-touch-icon.png'))).toBe(true);
  });

  it('uses the page colours of the design tokens', () => {
    const tokens = read('../styles/tokens.css');
    expect(tokens.toLowerCase()).toContain(`--c-page: ${PWA_COLORS.lightPage.toLowerCase()};`);
    expect(tokens.toLowerCase()).toContain(`--c-page: ${PWA_COLORS.darkPage.toLowerCase()};`);
    expect(manifest.theme_color).toBe(PWA_COLORS.lightPage);
    expect(manifest.background_color).toBe(PWA_COLORS.lightPage);
  });
});

describe('build files', () => {
  const files = buildPwaFiles();

  it('serializes the manifest and fills the build id into the worker', () => {
    expect(JSON.parse(files.manifest).name).toBe(en.app.name);
    expect(files.serviceWorker()).not.toContain('__BUILD_ID__');
    expect(files.serviceWorker('dev')).toContain("'dev'");
  });

  it('changes the worker when the offline page changes', () => {
    expect(files.serviceWorker()).toMatch(/BUILD_ID = '[0-9a-f]{12}'/);
  });
});

describe('index.html', () => {
  const html = read('../../index.html');

  it('links the manifest with credentials, the icons and the iOS tags', () => {
    expect(html).toContain(
      '<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />',
    );
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(html).toContain('rel="icon" href="/favicon.svg"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="{{appName}}"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="default"');
    expect(html).not.toContain('black-translucent');
  });

  it('keeps both theme colours and paints the page before the stylesheet loads', () => {
    expect(html).toContain('content="#F5F4EF" media="(prefers-color-scheme: light)"');
    expect(html).toContain('content="#141412" media="(prefers-color-scheme: dark)"');
    expect(html).toMatch(/html\s*\{\s*background: #f5f4ef;\s*\}/);
    expect(html).toMatch(/prefers-color-scheme: dark\)\s*\{\s*html\s*\{\s*background: #141412;/);
  });
});
