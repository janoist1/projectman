import os from 'node:os';
import { spawn } from '@lydell/node-pty';
import { defaultTestWorkers } from '@projectman/shared';
import { configDefaults, defineConfig } from 'vitest/config';

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
 * does not set the variable.
 */
const PTY_TESTS = ['**/*.integration.test.ts', 'test/golden-path-*.test.ts'];
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

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...(skip ? PTY_TESTS : [])],
    // Many tests start git or other child processes and write files; a test that takes under a
    // second alone (config-store "never reads a project while a save rewrites its files": 0.7 s)
    // took over 5 s when the whole repository's tests ran in parallel (PM-215). The GitHub
    // publisher tests are the same: each runs about 15 git commands in its setup and as many in
    // the test, 1-2.5 s alone.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // A worker is about 150 MB and the default is every core: three runs at once took the load to 80
    // (PM-332). VITEST_MAX_FORKS/THREADS, which the server's full test sets, still win over this.
    maxWorkers: defaultTestWorkers({ cpus: os.availableParallelism(), memoryBytes: os.totalmem() }),
    minWorkers: 1,
  },
});
