import { vi } from 'vitest';

/**
 * `vi.waitFor` gives up after one second unless told otherwise. The tests wait for background work
 * (git processes, a database write, a child process), and when the whole suite runs in parallel on a
 * loaded machine one second is not enough, though nothing is wrong: the merge test failed for this
 * reason in many different files. A wait that is passed its own timeout keeps it; the rest wait as
 * long as a test may run, and a condition that holds returns at the first poll as before.
 */
const WAIT_FOR_TIMEOUT_MS = 15_000;

/**
 * The `pooled` project does not isolate the files of a worker, so this file runs again on the same
 * `vi` for each of them: wrap only once, or each file would add a layer.
 */
const WRAPPED = Symbol.for('projectman.waitFor.wrapped');
const current = vi.waitFor as typeof vi.waitFor & { [WRAPPED]?: true };

if (!current[WRAPPED]) {
  const waitFor = vi.waitFor.bind(vi);
  const wrapped = ((callback, options) =>
    waitFor(
      callback,
      typeof options === 'number' ? options : { timeout: WAIT_FOR_TIMEOUT_MS, ...options },
    )) as typeof vi.waitFor & { [WRAPPED]?: true };
  wrapped[WRAPPED] = true;
  vi.waitFor = wrapped;
}
