import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { releaseTestFiles, RELEASE_TEST_MARKER, runReleaseTest } from '../../../scripts/live/release-test';
import { LiveWorld } from './helpers/live-world';

/** The release test (PM-493): which files take part, where they run, and what it exits with. */

// Built piece by piece, so that this file does not carry the marker itself.
const MARKER = ['process.env.PROJECTMAN_FULL_', "TEST_SANDBOX === '1'"].join('');

let root: string;
let world: LiveWorld | undefined;

function write(file: string, content: string): void {
  const full = path.join(root, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'release-test-')));
  write('package.json', JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  for (const workspace of ['apps/server', 'apps/web', 'packages/shared'])
    write(`${workspace}/package.json`, '{}');
  write('apps/server/test/a.test.ts', `const skip = ${MARKER};\n`);
  write('apps/server/src/b.test.ts', `// ${MARKER}\n`);
  write('apps/server/test/plain.test.ts', 'it("x", () => {});\n');
  write('apps/server/test/sets.test.ts', "env: { PROJECTMAN_FULL_TEST_SANDBOX: '1' }\n");
  write('apps/server/node_modules/dep/c.test.ts', MARKER);
  write('apps/server/dist/d.test.js', MARKER);
  write('apps/server/test/marker.txt', MARKER);
  write('packages/shared/e.test.tsx', MARKER);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  world?.cleanup();
  world = undefined;
});

describe('releaseTestFiles', () => {
  it('names the test files that carry the marker, by workspace', () => {
    expect(RELEASE_TEST_MARKER).toBe(MARKER);
    expect(releaseTestFiles(root)).toEqual([
      { workspace: path.join(root, 'apps/server'), files: ['src/b.test.ts', 'test/a.test.ts'] },
      { workspace: path.join(root, 'packages/shared'), files: ['e.test.tsx'] },
    ]);
  });

  it('does not take the line that only sets the variable, a file that is not a test, or node_modules and dist', () => {
    const all = releaseTestFiles(root).flatMap((group) => group.files);
    expect(all).not.toContain('test/sets.test.ts');
    expect(all).not.toContain('test/marker.txt');
    expect(all.join(' ')).not.toMatch(/node_modules|dist/);
  });

  it('reads this repository without taking the tests of the release test itself', () => {
    const found = releaseTestFiles(path.resolve(__dirname, '../../..'));
    expect(found.flatMap((group) => group.files)).not.toContain('test/live-release-test.test.ts');
  });
});

describe('runReleaseTest', () => {
  it('runs vitest in each workspace without the sandbox variables', async () => {
    world = new LiveWorld();
    expect(await runReleaseTest(world.deps(), root)).toBe(0);
    expect(world.calls).toHaveLength(2);
    expect(world.calls[0]).toMatchObject({
      command: path.join(root, 'node_modules', '.bin', 'vitest'),
      args: ['run', '--configLoader', 'runner', 'src/b.test.ts', 'test/a.test.ts'],
      cwd: path.join(root, 'apps/server'),
      unsetEnv: ['PROJECTMAN_FULL_TEST_SANDBOX', 'PROJECTMAN_SKIP_PTY_TESTS', 'PROJECTMAN_HOME'],
    });
    expect(world.calls[1]).toMatchObject({ cwd: path.join(root, 'packages/shared') });
    expect(world.outLines[0]).toBe('release-test: 3 files in 2 workspaces\n');
    expect(world.outLines.at(-1)).toBe('release-test: passed\n');
  });

  it('stops at the first workspace that fails and exits with its status', async () => {
    world = new LiveWorld();
    world.override((record) =>
      record.cwd.endsWith('apps/server') ? { status: 3, stdout: 'FAIL a', stderr: '' } : undefined,
    );
    expect(await runReleaseTest(world.deps(), root)).toBe(3);
    expect(world.calls).toHaveLength(1);
    expect(world.output).toContain('FAIL a');
    expect(world.outLines.at(-1)).toBe('release-test: failed (server)\n');
  });

  it('passes when no file carries the marker', async () => {
    world = new LiveWorld();
    rmSync(path.join(root, 'apps'), { recursive: true });
    rmSync(path.join(root, 'packages'), { recursive: true });
    expect(await runReleaseTest(world.deps(), root)).toBe(0);
    expect(world.calls).toEqual([]);
    expect(world.output).toContain('0 files in 0 workspaces');
  });
});
