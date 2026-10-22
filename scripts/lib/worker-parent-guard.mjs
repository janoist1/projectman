/**
 * Makes a forked test worker leave when the process that started it is gone (PM-869).
 *
 * `scripts/lib/child-guard.mjs` (PM-863) stops what `npm run heavy` started. A member's own
 * `npx vitest run` or `npx vitest related` does not go through it, and when that run is interrupted
 * (the session ends, the command is cancelled, a SIGKILL) the forked workers outlive it, each one
 * holding its memory. A worker is told nothing, but the IPC channel to its parent closes, and the
 * parent's pid stops being its parent (it becomes 1 or a subreaper): either one ends the worker.
 * This covers every vitest run in the repository, whoever starts it.
 *
 * Only a forked child has the channel (`process.send`). Worker threads die with their process, and
 * a plain `node` run is left alone.
 */
const INSTALLED = Symbol.for('projectman.workerParentGuard');
const DEFAULT_INTERVAL_MS = 2_000;

/**
 * Installs the guard in this process, once. Returns true when it was installed now.
 * `exit` and `intervalMs` are for the tests.
 */
export function guardWorkerParent({
  target = process,
  // Not `process.exit`: vitest replaces it in a worker with a function that throws, before the
  // setup files run. The parent has gone, so nothing is left to report to or to clean up for.
  exit = () => process.kill(process.pid, 'SIGKILL'),
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  if (typeof target.send !== 'function' || target[INSTALLED]) return false;
  target[INSTALLED] = true;
  const parent = target.ppid;
  target.on('disconnect', () => exit());
  setInterval(() => {
    if (target.ppid !== parent) exit();
  }, intervalMs).unref();
  return true;
}
