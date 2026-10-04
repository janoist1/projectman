import os from 'node:os';
import { defaultTestWorkers } from '@projectman/shared';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Half the cores, at most 4 (PM-332): one run must not take the whole machine.
    maxWorkers: defaultTestWorkers({ cpus: os.availableParallelism(), memoryBytes: os.totalmem() }),
    minWorkers: 1,
  },
});
