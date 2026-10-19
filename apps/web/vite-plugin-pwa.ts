import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { hu } from './src/i18n/hu';
import { buildManifest } from './src/pwa/manifest';
import { buildOfflineHtml } from './src/pwa/offline';

const SW_SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), 'src/pwa/sw.js');
const MANIFEST_FILE = 'manifest.webmanifest';
const APP_NAME_PLACEHOLDER = '{{appName}}';

/** The files the app needs to be installable, built from the locale file (hu.ts). */
export function buildPwaFiles(): {
  manifest: string;
  offline: string;
  serviceWorker: (buildId?: string) => string;
} {
  const name = hu.app.name;
  const manifest = JSON.stringify(buildManifest({ name, description: hu.pwa.description }), null, 2) + '\n';
  const offline = buildOfflineHtml({ name, ...hu.pwa.offline });
  const template = readFileSync(SW_SOURCE, 'utf8');
  // The id changes with the offline page or the worker, so a release that changes either updates the cache.
  const hashed = createHash('sha256').update(offline).update(template).digest('hex').slice(0, 12);
  return {
    manifest,
    offline,
    serviceWorker: (buildId = hashed) => template.replaceAll('__BUILD_ID__', buildId),
  };
}

/** Emits the manifest, the offline page and the service worker, and fills the app name into index.html. */
export function pwaPlugin(): Plugin {
  return {
    name: 'projectman-pwa',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replaceAll(APP_NAME_PLACEHOLDER, hu.app.name),
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        const files = buildPwaFiles();
        const serve = (type: string, body: string) => {
          res.setHeader('content-type', type);
          res.setHeader('cache-control', 'no-cache');
          res.end(body);
        };
        if (path === `/${MANIFEST_FILE}`) return serve('application/manifest+json', files.manifest);
        if (path === '/offline.html') return serve('text/html; charset=utf-8', files.offline);
        if (path === '/sw.js') return serve('text/javascript; charset=utf-8', files.serviceWorker('dev'));
        next();
      });
    },
    generateBundle() {
      const files = buildPwaFiles();
      this.emitFile({ type: 'asset', fileName: MANIFEST_FILE, source: files.manifest });
      this.emitFile({ type: 'asset', fileName: 'offline.html', source: files.offline });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: files.serviceWorker() });
    },
  };
}
