/**
 * The most test files a targeted run (the hand-over check, `vitest related`) takes at once. A central file
 * reaches hundreds of tests; the rest of the change is left to the merge check (PM-1289, PM-1278).
 */
export const TARGETED_TEST_FILES_MAX = 60;

/**
 * How many vitest workers one test run uses on this machine (PM-332): half the cores, at most 4, and
 * one per 4 GiB of memory. A worker is about 150 MB, but the tests start git and child processes too,
 * and three full runs at once (every worker count = all cores) took the load to 80 and the swap to 6 GB.
 */
export function defaultTestWorkers(host: { cpus: number; memoryBytes: number }): number {
  return Math.max(1, Math.min(4, Math.floor(host.cpus / 2), Math.floor(host.memoryBytes / 2 ** 32)));
}
