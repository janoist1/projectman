import os from 'node:os';
import { defaultTestWorkers } from '@projectman/shared';
import { defineConfig } from 'vitest/config';
import { PARENT_GUARD_SETUP } from '../../scripts/lib/vitest-parent-guard.mjs';

/**
 * Test config, separate from vite.config.ts: vitest 3 runs on vite 7, while the app build
 * uses vite 8 with @vitejs/plugin-react 6 (vite 8 only). esbuild handles JSX here.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    // The second one makes a worker leave when its parent is gone (PM-869).
    setupFiles: ['src/test/setup.ts', PARENT_GUARD_SETUP],
    restoreMocks: true,
    // Role queries (getByRole, findByRole) compute the accessible tree of a jsdom page, and a
    // settings page holds hundreds of controls: those tests take 1-1.5 s alone and several times
    // that when the whole repository's tests (or other sessions) run in parallel. 5 s was not enough.
    testTimeout: 20_000,
    // Half the cores, at most 4 (PM-332): one run must not take the whole machine.
    maxWorkers: defaultTestWorkers({ cpus: os.availableParallelism(), memoryBytes: os.totalmem() }),
    minWorkers: 1,
  },
});
