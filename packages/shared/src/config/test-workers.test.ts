import { describe, expect, it } from 'vitest';
import { defaultTestWorkers } from './test-workers';

const GIB = 2 ** 30;

describe('defaultTestWorkers', () => {
  it('uses one worker on a one-core machine', () => {
    expect(defaultTestWorkers({ cpus: 1, memoryBytes: 64 * GIB })).toBe(1);
  });

  it('uses half the cores', () => {
    expect(defaultTestWorkers({ cpus: 4, memoryBytes: 64 * GIB })).toBe(2);
    expect(defaultTestWorkers({ cpus: 5, memoryBytes: 64 * GIB })).toBe(2);
  });

  it('uses at most 4 workers', () => {
    expect(defaultTestWorkers({ cpus: 8, memoryBytes: 16 * GIB })).toBe(4);
    expect(defaultTestWorkers({ cpus: 32, memoryBytes: 256 * GIB })).toBe(4);
  });

  it('uses one worker per 4 GiB of memory, and at least one', () => {
    expect(defaultTestWorkers({ cpus: 8, memoryBytes: 4 * GIB })).toBe(1);
    expect(defaultTestWorkers({ cpus: 8, memoryBytes: 12 * GIB })).toBe(3);
    expect(defaultTestWorkers({ cpus: 8, memoryBytes: 2 * GIB })).toBe(1);
  });
});
