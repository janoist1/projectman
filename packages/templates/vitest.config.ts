import { defineConfig } from 'vitest/config';
import { machinePlaces } from '../../scripts/heavy/vitest-places.mjs';
import { PARENT_GUARD_SETUP } from '../../scripts/lib/vitest-parent-guard.mjs';

export default defineConfig({
  // The run takes its places, and so its workers, from the machine's pool (PM-1278).
  plugins: [machinePlaces()],
  test: {
    // A worker leaves when its parent is gone (PM-869).
    setupFiles: [PARENT_GUARD_SETUP],
  },
});
