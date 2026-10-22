import os from 'node:os';
import { defaultTestWorkers } from '@projectman/shared';
import { defineConfig } from 'vitest/config';
import { PARENT_GUARD_SETUP } from '../../scripts/lib/vitest-parent-guard.mjs';

export default defineConfig({
  test: {
    // A worker leaves when its parent is gone (PM-869).
    setupFiles: [PARENT_GUARD_SETUP],
    // Half the cores, at most 4 (PM-332): one run must not take the whole machine.
    maxWorkers: defaultTestWorkers({ cpus: os.availableParallelism(), memoryBytes: os.totalmem() }),
    minWorkers: 1,
  },
});
