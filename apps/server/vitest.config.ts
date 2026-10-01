import { spawn } from '@lydell/node-pty';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The tests that run real agent sessions (the fake CLIs in pseudo-terminals) need to open a PTY.
 * Claude Code's sandbox, in which AI developers run their commands (PM-87), forbids that: there
 * they are left out with a notice, and the integrating session runs the full suite before a merge.
 */
const PTY_TESTS = ['**/*.integration.test.ts', 'test/golden-path-*.test.ts'];

function canOpenPty(): boolean {
  try {
    spawn('/bin/sh', ['-c', 'exit 0'], {}).kill();
    return true;
  } catch {
    return false;
  }
}

const ptyAvailable = canOpenPty();
if (!ptyAvailable) {
  console.warn(
    `No pseudo-terminal can be opened here (a sandbox?): skipping ${PTY_TESTS.join(', ')}. ` +
      'Run the full suite outside the sandbox.',
  );
}

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ...(ptyAvailable ? [] : PTY_TESTS)] },
});
