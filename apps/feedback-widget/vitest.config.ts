import os from 'node:os';
import { defaultTestWorkers } from '@projectman/shared';
import { defineConfig } from 'vitest/config';

/**
 * Test config, separate from vite.config.ts: vitest 3 runs on vite 7 while the build uses vite 8
 * (as in apps/web). esbuild handles JSX here.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    maxWorkers: defaultTestWorkers({ cpus: os.availableParallelism(), memoryBytes: os.totalmem() }),
    minWorkers: 1,
  },
});
