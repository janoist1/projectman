import { defineConfig } from 'vitest/config';
import { machinePlaces } from '../../scripts/heavy/vitest-places.mjs';
import { PARENT_GUARD_SETUP } from '../../scripts/lib/vitest-parent-guard.mjs';

/**
 * Test config, separate from vite.config.ts: vitest 3 runs on vite 7 while the build uses vite 8
 * (as in apps/web). esbuild handles JSX here.
 */
export default defineConfig({
  // The run takes its places, and so its workers, from the machine's pool (PM-1278).
  plugins: [machinePlaces()],
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    // A worker leaves when its parent is gone (PM-869).
    setupFiles: [PARENT_GUARD_SETUP],
    restoreMocks: true,
  },
});
