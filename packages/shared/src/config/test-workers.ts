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

/**
 * The places of the machine's heavy-run pool (PM-1278): one place is one heavy node process (a vitest main
 * process or worker, a type check, a build, a browser). The cores bound it, and so does the memory: 4 GiB
 * stay for the system, the engine and the members' sessions, and a place takes about 2 GiB. Between 2 and
 * 16: 8 GiB gives 2, 16 GiB gives 6 (with 6 cores), 32 GiB gives 14. Every participant on the machine
 * calls this with the same input and gets the same capacity.
 */
export function machinePlaces(host: { cpus: number; memoryBytes: number }): number {
  const byMemory = Math.floor((host.memoryBytes / 2 ** 30 - 4) / 2);
  return Math.max(2, Math.min(16, host.cpus, byMemory));
}

/**
 * The workers of one test run that holds `granted` places (PM-1278): the main process takes one place, the
 * workers the rest, never more than the per-run cap of `defaultTestWorkers`. The only place a worker count
 * is decided; the vitest configs take it from the places plugin.
 */
export function placeWorkers(granted: number, host: { cpus: number; memoryBytes: number }): number {
  return Math.max(1, Math.min(defaultTestWorkers(host), Math.floor(granted) - 1));
}

/** Merge checks leave two places for developers where possible, and never reserve unused workers (PM-1338). */
export function mergeTestPlaces(host: { cpus: number; memoryBytes: number }, maxWorkers = Infinity): number {
  const ceiling = Math.max(2, machinePlaces(host) - 2);
  return 1 + Math.min(placeWorkers(ceiling, host), Math.max(1, Math.floor(maxWorkers)));
}
