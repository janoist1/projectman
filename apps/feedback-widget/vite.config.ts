import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/** The script is loaded on customers' pages, so its size is a budget, not a hope (PM-510). */
const MAX_GZIP_BYTES = 100 * 1024;
const OUTPUT = 'widget.js';

const sizeBudget = (): Plugin => {
  let outDir = 'dist';
  return {
    name: 'feedback-widget-size-budget',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const size = gzipSync(readFileSync(resolve(outDir, OUTPUT))).length;
      const kilobytes = (size / 1024).toFixed(1);
      if (size > MAX_GZIP_BYTES) {
        throw new Error(`${OUTPUT} is ${kilobytes} kB gzip; the budget is ${MAX_GZIP_BYTES / 1024} kB`);
      }
      console.log(`${OUTPUT}: ${kilobytes} kB gzip (budget ${MAX_GZIP_BYTES / 1024} kB)`);
    },
  };
};

/** One self-contained IIFE: a single `<script>` tag embeds the widget, its CSS inlined. */
export default defineConfig({
  plugins: [sizeBudget()],
  cacheDir: process.env.PROJECTMAN_VITE_CACHE_DIR,
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
    lib: {
      entry: 'src/main.ts',
      name: 'ProjectmanFeedbackWidget',
      formats: ['iife'],
      fileName: () => OUTPUT,
    },
  },
});
