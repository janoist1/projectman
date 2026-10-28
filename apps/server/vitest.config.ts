import os from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from '@lydell/node-pty';
import { defaultTestWorkers } from '@projectman/shared';
import { configDefaults, defineConfig } from 'vitest/config';
import { PARENT_GUARD_SETUP } from '../../scripts/lib/vitest-parent-guard.mjs';
import { PTY_TESTS, pooledTests } from './test/isolation';

/**
 * The tests that run real agent sessions (the fake CLIs in pseudo-terminals) need to open a PTY.
 * Claude Code's sandbox, in which AI members run their commands (PM-87), forbids that.
 *
 * They are left out only when the environment says so: the server sets `PROJECTMAN_SKIP_PTY_TESTS=1`
 * for the sandboxed sessions (`SANDBOX_PTY_ENV`, PM-194), and a person can set it too. Without it a
 * PTY that cannot be opened (a broken native module after a Node update, say) fails the run, so a
 * full run outside a sandbox never passes with the 11 files silently missing. The integrating
 * session runs the full suite before a merge. From PM-217 the server also runs the full suite itself
 * (`reviewTest`, `src/full-test`) when a card enters review, in its own sandbox that allows PTYs; it
 * does not set the variable. `PTY_TESTS` lives in `test/isolation.ts`, which keeps these files out
 * of the `pooled` project too.
 */
const SKIP_VARIABLE = 'PROJECTMAN_SKIP_PTY_TESTS';

function ptyError(): string | undefined {
  try {
    spawn('/bin/sh', ['-c', 'exit 0'], {}).kill();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const failure = ptyError();
const skip = failure !== undefined && process.env[SKIP_VARIABLE] === '1';
if (failure !== undefined && !skip) {
  throw new Error(
    `No pseudo-terminal can be opened (${failure}), and ${PTY_TESTS.join(', ')} need one. ` +
      `Fix @lydell/node-pty, or set ${SKIP_VARIABLE}=1 to leave those tests out (a sandbox; ` +
      'the full run before a merge must not).',
  );
}
if (skip) {
  console.warn(
    `${SKIP_VARIABLE}=1 and no pseudo-terminal can be opened here (${failure}): skipping ` +
      `${PTY_TESTS.join(', ')}. This is not a complete run: run the full suite outside the sandbox.`,
  );
}

const root = dirname(fileURLToPath(import.meta.url));
const rootExclude = [...configDefaults.exclude, ...(skip ? PTY_TESTS : [])];
// The files that share one module graph per worker (`test/isolation.ts`); everything else is isolated.
const pooled = pooledTests(root);
const workers = defaultTestWorkers({ cpus: os.availableParallelism(), memoryBytes: os.totalmem() });
// VITEST_MAX_FORKS used to cap every worker, and the `pooled` project's are threads: it caps those
// too, VITEST_MAX_THREADS (which vitest also applies itself) first.
const cap = (name: string) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
};
const threadsMax = cap('VITEST_MAX_THREADS') ?? cap('VITEST_MAX_FORKS') ?? workers;

export default defineConfig({
  test: {
    // Two projects (PM-865). `isolated` is the plain vitest behaviour: a fresh module graph per file.
    // `pooled` runs the files `pooledTests` picks without isolation: the modules, the process and
    // the globals are shared by the files of a worker, which saves loading the server for each.
    // The options below are the root's and both projects inherit them (`extends: true`).
    projects: [
      {
        extends: true,
        test: { name: 'isolated', exclude: [...rootExclude, ...pooled] },
      },
      {
        extends: true,
        test: {
          name: 'pooled',
          include: pooled,
          pool: 'threads',
          // The two projects use different pools, which vitest would run at the same time (twice
          // the workers); a later group waits for the earlier one.
          sequence: { groupOrder: 1 },
          setupFiles: ['test/setup/wait-for-timeout.ts', 'test/setup/unstub-after-file.ts'],
        },
      },
    ],
    // `vi.waitFor` waits 15 s instead of 1 s unless a test says otherwise (see the file).
    // The guard makes a forked worker leave when its parent is gone (PM-869). The `pooled` project's
    // workers are threads, which die with the process, and its own `setupFiles` need no guard.
    setupFiles: ['test/setup/wait-for-timeout.ts', PARENT_GUARD_SETUP],
    exclude: rootExclude,
    // Many tests start git or other child processes and write files; a test that takes under a
    // second alone (config-store "never reads a project while a save rewrites its files": 0.7 s)
    // took over 5 s when the whole repository's tests ran in parallel (PM-215). The GitHub
    // publisher tests are the same: each runs about 15 git commands in its setup and as many in
    // the test, 1-2.5 s alone.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // A worker is about 150 MB and the default is every core: three runs at once took the load to 80
    // (PM-332). VITEST_MAX_FORKS/THREADS, which the server's full test sets, still win over this.
    maxWorkers: workers,
    minWorkers: 1,
    // The pool, not the project, decides whether a worker is recycled after each file (a project's
    // own `isolate` only resets its modules), so the `threads` pool (the `pooled` project's) is set to
    // share its workers here, while the `forks` pool (the `isolated` project's) keeps its default: a
    // new process for each file. The threads' minimum is their maximum: with fewer, tinypool ends an
    // idle worker thread before it has finished a file when `isolate` is off, and the run dies with
    // "Terminating worker thread".
    poolOptions: {
      threads: { isolate: false, maxThreads: threadsMax, minThreads: threadsMax },
    },
  },
});
