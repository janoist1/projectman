import { describe, expect, it } from 'vitest';
import { defaultTestWorkers, machinePlaces, mergeTestPlaces, placeWorkers } from './test-workers';

const GIB = 2 ** 30;

describe('mergeTestPlaces', () => {
  it.each([
    [8, 8, 2],
    [8, 12, 2],
    [8, 16, 4],
    [16, 32, 5],
  ])('reserves usable workers below the two-place ceiling on %i cores and %i GiB', (cpus, gib, places) => {
    expect(mergeTestPlaces({ cpus, memoryBytes: gib * GIB })).toBe(places);
  });

  it('does not reserve workers above the configured limit', () => {
    expect(mergeTestPlaces({ cpus: 16, memoryBytes: 32 * GIB }, 2)).toBe(3);
  });
});

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

describe('machinePlaces', () => {
  it.each([
    [8, 8, 2],
    [16, 16, 6],
    [8, 32, 8],
    [32, 32, 14],
  ])('gives %i cores and %i GiB %i places', (cpus, gib, places) => {
    expect(machinePlaces({ cpus, memoryBytes: gib * GIB })).toBe(places);
  });

  it('keeps between 2 and 16 places', () => {
    expect(machinePlaces({ cpus: 1, memoryBytes: 2 * GIB })).toBe(2);
    expect(machinePlaces({ cpus: 64, memoryBytes: 512 * GIB })).toBe(16);
  });
});

describe('placeWorkers', () => {
  const host = { cpus: 8, memoryBytes: 16 * GIB };

  it('leaves one place to the main process', () => {
    expect(placeWorkers(3, host)).toBe(2);
  });

  it('never goes over the per-run cap, and never under one worker', () => {
    expect(placeWorkers(16, host)).toBe(4);
    expect(placeWorkers(1, host)).toBe(1);
  });
});
