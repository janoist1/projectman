import { defineConfig } from 'vite';

/**
 * Serves the test page (`dev/index.html`) with the widget from source. It runs on its own origin, not
 * the projectman server's: the widget API refuses a request that carries no `Origin`, and the page's
 * origin must be one of the project's surfaces (Settings → Feedback).
 */
export default defineConfig({
  cacheDir: process.env.PROJECTMAN_VITE_CACHE_DIR,
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  server: { host: '127.0.0.1', port: 5174, strictPort: true, open: false },
});
