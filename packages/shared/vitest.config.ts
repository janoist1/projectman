import os from 'node:os';
import { defineConfig } from 'vitest/config';
import { defaultTestWorkers } from './src/config/test-workers';

export default defineConfig({
  test: {
    // Half the cores, at most 4 (PM-332): one run must not take the whole machine.
    maxWorkers: defaultTestWorkers({ cpus: os.availableParallelism(), memoryBytes: os.totalmem() }),
    minWorkers: 1,
  },
});
