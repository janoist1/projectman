import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMergeTest } from '../../../scripts/merge-test/run';
import type { StepRun } from '../../../scripts/merge-test/steps';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);
const ended = (stdout = '', status = 0) => ({ stdout, stderr: '', status, signal: null, pid: 1, output: [] });
const done = (output = '', code = 0): StepRun => ({ code, signaled: false, output });
const npm = vi.fn<(args: string[]) => Promise<StepRun>>();
const run = (argv: string[], exists: (file: string) => boolean = () => true) =>
  runMergeTest(argv, { npm, exists });
const npmCalls = () => npm.mock.calls.map(([args]) => args);
const gitCalls = () => spawn.mock.calls.map(([, args]) => args);

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('merge test runner', () => {
  const output = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
  /** HEAD with these parents, whose first-parent diff is `changed`. */
  function mockHead(parents: string, changed: string[] = []) {
    spawn.mockImplementation((_command, args) => {
      if (args?.[0] === 'rev-list') return ended(`head ${parents}`);
      if (args?.[0] === 'diff') return ended(changed.map((file) => `${file}\0`).join(''));
      throw new Error('unexpected command');
    });
    npm.mockResolvedValue(done());
  }
  it('stops at the first failed step and ends with the scope', async () => {
    const log = output();
    mockHead('first second');
    npm.mockResolvedValueOnce(done('', 7));
    expect(await run(['--all'])).toBe(7);
    expect(npm).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([
      ['merge-test scope: all (--all); modules: all; tests: all; fallback: --all'],
      ['merge-test scope: all (--all); modules: all; tests: all; fallback: --all'],
    ]);
  });
  it('runs everything by workspace when HEAD is not a merge', async () => {
    output();
    mockHead('parent');
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([
      ...['packages/shared', 'packages/templates', 'apps/feedback-widget', 'apps/server', 'apps/web'].map(
        (ws) => ['run', 'typecheck', '-w', ws, '--if-present'],
      ),
      ...['packages/shared', 'packages/templates', 'apps/feedback-widget', 'apps/server', 'apps/web'].map(
        (ws) => ['test', '-w', ws, '--if-present'],
      ),
    ]);
  });
  it('lists exactly the workspaces of the repository', async () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const found = ['packages', 'apps'].flatMap((dir) =>
      readdirSync(resolve(root, dir))
        .filter((name) => existsSync(resolve(root, dir, name, 'package.json')))
        .map((name) => `${dir}/${name}`),
    );
    output();
    mockHead('parent');
    await run([]);
    const tested = npmCalls()
      .filter((args) => args[0] === 'test')
      .map((args) => args[2]);
    expect(tested.sort()).toEqual(found.sort());
  });
  it('uses the first-parent diff and does no checks for docs only', async () => {
    output();
    mockHead('first second', ['docs/a.md', 'README.md']);
    expect(await run([])).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    expect(npm).not.toHaveBeenCalled();
  });
  it('rejects invalid flags without running commands', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(['--unknown'])).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(npm).not.toHaveBeenCalled();
  });
  const sourceTree = [
    ['apps/server/src/logging/index.ts', 'export const value = 1;'],
    ['apps/server/src/logging/index.test.ts', "import './index';"],
    ['apps/server/test/golden-path-example.test.ts', ''],
  ];
  function mockTrees(changed: string[], tree = sourceTree) {
    const listing = tree.map(([path], i) => `100644 blob oid${i}\t${path}\0`).join('');
    const batch = Buffer.concat(
      tree.flatMap(([, source], i) => [
        Buffer.from(`oid${i} blob ${Buffer.byteLength(source!)}\n`),
        Buffer.from(source!),
        Buffer.from('\n'),
      ]),
    );
    spawn.mockImplementation((_command, args) => {
      if (args?.[0] === 'rev-list') return ended('head first second');
      if (args?.[0] === 'diff') return ended(changed.join('\0') + '\0');
      if (args?.[0] === 'ls-tree') return ended(listing);
      if (args?.[0] === 'cat-file') return { ...ended(), stdout: batch, stderr: Buffer.alloc(0) };
      throw new Error('unexpected command');
    });
    npm.mockResolvedValue(done());
  }
  it('reads both trees as blobs and runs modules followed by the web workspace', async () => {
    const log = output();
    mockTrees(['apps/server/src/logging/index.ts', 'apps/web/src/a.ts']);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([
      ['run', 'typecheck', '-w', 'apps/server'],
      [
        'test',
        '-w',
        'apps/server',
        '--',
        resolve('apps/server/src/logging/index.test.ts'),
        resolve('apps/server/test/golden-path-example.test.ts'),
      ],
      ['run', 'typecheck', '-w', 'apps/web'],
      ['test', '-w', 'apps/web'],
    ]);
    expect(
      gitCalls()
        .filter((args) => args?.[0] === 'ls-tree')
        .map((args) => args?.[3]),
    ).toEqual(['HEAD^1', 'HEAD']);
    expect(log.mock.calls[0]?.[0]).toContain('tests: 2');
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
  });
  it('keeps full workspace fallback with its reason for helper changes', async () => {
    const log = output();
    mockTrees(['apps/server/test/helpers/a.ts']);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([
      ['run', 'typecheck', '-w', 'apps/server'],
      ['test', '-w', 'apps/server'],
    ]);
    expect(log.mock.calls[0]?.[0]).toContain('fallback: test, helper or fixture changed');
  });
  it('runs only the filtered cloud checks for a cloud-only first-parent diff', async () => {
    const log = output();
    mockTrees(['scripts/cloud/a.ts', 'deploy/aws/b.tf', 'docs/CLOUD.md']);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toEqual([
      ['run', 'typecheck', '-w', 'apps/server'],
      [
        'test',
        '-w',
        'apps/server',
        '--',
        resolve('apps/server/test/cloud-'),
        resolve('apps/server/test/deploy-'),
        resolve('apps/server/test/release-'),
        resolve('apps/server/test/architecture'),
        resolve('apps/server/test/merge-test-'),
      ],
    ]);
    expect(gitCalls().some((args) => args?.[0] === 'ls-tree')).toBe(false);
    expect(log.mock.calls).toHaveLength(2);
    expect(log.mock.calls[0]?.[0]).toContain('merge-test scope: cloud');
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
  });
  it('stops the cloud branch on its first failed check with its exit code', async () => {
    const log = output();
    mockTrees(['scripts/cloud/a.ts']);
    npm.mockResolvedValue(done('', 5));
    expect(await run([])).toBe(5);
    expect(npm).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
  });
  it('keeps the full run for a cloud diff that also changes shared code', async () => {
    const log = output();
    mockTrees(['scripts/cloud/a.ts', 'packages/shared/src/a.ts']);
    expect(await run([])).toBe(0);
    expect(npmCalls()).toHaveLength(10);
    expect(npmCalls()[0]).toEqual(['run', 'typecheck', '-w', 'packages/shared', '--if-present']);
    expect(log.mock.calls[0]?.[0]).toContain('merge-test scope: all');
  });
  it('stops the module branch on its first failed check', async () => {
    output();
    mockTrees(['apps/server/src/logging/index.ts']);
    npm.mockResolvedValue(done('', 9));
    expect(await run([])).toBe(9);
    expect(npm).toHaveBeenCalledTimes(1);
  });
  it('fails closed for malformed batch output', async () => {
    output();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockTrees(['apps/server/src/logging/index.ts']);
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation((...args) =>
      args[1]?.[0] === 'cat-file'
        ? { ...ended(), stdout: Buffer.from('missing\n'), stderr: Buffer.alloc(0) }
        : original(...args),
    );
    expect(await run([])).toBe(2);
    expect(npm).not.toHaveBeenCalled();
  });
  it('returns 127 when npm cannot start', async () => {
    output();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockHead('first second');
    npm.mockRejectedValue(new Error('spawn npm ENOENT'));
    expect(await run(['--all'])).toBe(127);
  });
});

describe('the rerun of failed test files', () => {
  const output = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const serverFail = ' FAIL  test/a.test.ts > suite > test\n';
  /** A merge of `parents` that changed `changed`; the server test step fails with `serverFail`. */
  function mockMerge(changed: string[], rerun: StepRun = done()) {
    spawn.mockImplementation((_command, args) => {
      if (args?.[0] === 'rev-list') return ended('head first second');
      if (args?.[0] === 'diff') return ended(changed.map((file) => `${file}\0`).join(''));
      throw new Error('unexpected command');
    });
    npm.mockImplementation(async (args) => {
      if (args.join(' ') === 'test -w apps/server --if-present') return done(serverFail, 1);
      if (args.includes('--')) return rerun;
      return done();
    });
  }
  it('passes a flaky file and prints its marker before the closing scope line', async () => {
    const log = output();
    mockMerge(['packages/shared/src/a.ts']);
    expect(await run(['--all'])).toBe(0);
    const lines = log.mock.calls.map(([line]) => line);
    expect(lines.at(-2)).toBe('merge-test flaky: apps/server/test/a.test.ts');
    expect(lines.at(-1)).toContain('merge-test scope:');
    expect(npmCalls().filter((args) => args.includes('--'))).toEqual([
      ['test', '-w', 'apps/server', '--', resolve('apps/server/test/a.test.ts')],
    ]);
    // The web test step still ran after the rerun.
    expect(npmCalls().at(-1)).toEqual(['test', '-w', 'apps/web', '--if-present']);
  });
  it('fails with a marker when the file fails again', async () => {
    const log = output();
    mockMerge(['packages/shared/src/a.ts'], done(serverFail, 1));
    expect(await run(['--all'])).toBe(1);
    expect(log.mock.calls.map(([line]) => line)).toContain('merge-test failed: apps/server/test/a.test.ts');
    expect(npmCalls().at(-1)).toEqual([
      'test',
      '-w',
      'apps/server',
      '--',
      resolve('apps/server/test/a.test.ts'),
    ]);
  });
  it('does not rerun a test file the merge changed', async () => {
    const log = output();
    mockMerge(['apps/server/test/a.test.ts']);
    expect(await run(['--all'])).toBe(1);
    expect(npmCalls().some((args) => args.includes('--'))).toBe(false);
    expect(log.mock.calls.map(([line]) => line)).toContain('merge-test failed: apps/server/test/a.test.ts');
  });
  it('does not rerun when HEAD has no parent to compare with', async () => {
    output();
    spawn.mockImplementation((_command, args) => {
      if (args?.[0] === 'rev-list') return ended('head');
      throw new Error('unexpected command');
    });
    npm.mockImplementation(async (args) =>
      args.join(' ') === 'test -w apps/server --if-present' ? done(serverFail, 1) : done(),
    );
    expect(await run([])).toBe(1);
    expect(npmCalls().some((args) => args.includes('--'))).toBe(false);
  });
});

describe('the --files mode', () => {
  const output = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const fail = ' FAIL  test/a.test.ts > suite > test\n';
  function mockHead(parents: string, changed: string[] = []) {
    spawn.mockImplementation((_command, args) => {
      if (args?.[0] === 'rev-list') return ended(`head ${parents}`);
      if (args?.[0] === 'diff') return ended(changed.map((file) => `${file}\0`).join(''));
      throw new Error('unexpected command');
    });
    npm.mockResolvedValue(done());
  }
  it('runs the given files grouped by workspace, with no type check', async () => {
    const log = output();
    mockHead('first second');
    expect(
      await run([
        '--files',
        'apps/web/src/a.test.tsx',
        'apps/server/test/b.test.ts',
        'apps/server/test/c.test.ts',
      ]),
    ).toBe(0);
    expect(npmCalls()).toEqual([
      [
        'test',
        '-w',
        'apps/server',
        '--',
        resolve('apps/server/test/b.test.ts'),
        resolve('apps/server/test/c.test.ts'),
      ],
      ['test', '-w', 'apps/web', '--', resolve('apps/web/src/a.test.tsx')],
    ]);
    expect(log.mock.calls[0]?.[0]).toContain('merge-test scope: files (3)');
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
  });
  it('skips an absent file with a line and runs the others', async () => {
    const log = output();
    mockHead('first second');
    expect(
      await run(['--files', 'apps/server/test/new.test.ts', 'apps/server/test/old.test.ts'], (file) =>
        file.endsWith('old.test.ts'),
      ),
    ).toBe(0);
    expect(log.mock.calls.map(([line]) => line)).toContain(
      'merge-test skipped (absent): apps/server/test/new.test.ts',
    );
    expect(npmCalls()).toEqual([
      ['test', '-w', 'apps/server', '--', resolve('apps/server/test/old.test.ts')],
    ]);
  });
  it('ends with 0 and calls no npm when every file is absent', async () => {
    const log = output();
    mockHead('first second');
    expect(await run(['--files', 'apps/server/test/new.test.ts'], () => false)).toBe(0);
    expect(npm).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([line]) => line)).toContain(
      'merge-test skipped (absent): apps/server/test/new.test.ts',
    );
  });
  it('reruns a failed file once and marks it flaky', async () => {
    const log = output();
    mockHead('first second', ['packages/shared/src/x.ts']);
    npm.mockResolvedValueOnce(done(fail, 1)).mockResolvedValue(done());
    expect(await run(['--files', 'apps/server/test/a.test.ts'])).toBe(0);
    expect(log.mock.calls.map(([line]) => line)).toContain('merge-test flaky: apps/server/test/a.test.ts');
    expect(npm).toHaveBeenCalledTimes(2);
  });
  it('does not rerun a file the two-parent HEAD changed', async () => {
    const log = output();
    mockHead('first second', ['apps/server/test/a.test.ts']);
    npm.mockResolvedValue(done(fail, 1));
    expect(await run(['--files', 'apps/server/test/a.test.ts'])).toBe(1);
    expect(npm).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([line]) => line)).toContain('merge-test failed: apps/server/test/a.test.ts');
  });
  it('has no merge condition when HEAD is not a merge', async () => {
    output();
    mockHead('parent', ['apps/server/test/a.test.ts']);
    npm.mockResolvedValueOnce(done(fail, 1)).mockResolvedValue(done());
    expect(await run(['--files', 'apps/server/test/a.test.ts'])).toBe(0);
    expect(npm).toHaveBeenCalledTimes(2);
    expect(gitCalls().some((args) => args?.[0] === 'diff')).toBe(false);
  });
  it.each([
    ['--files'],
    ['--all', '--files', 'apps/server/test/a.test.ts'],
    ['--files', 'apps/server/test/a.test.ts', '--all'],
    ['--files', 'scripts/a.test.ts'],
    ['--files', 'apps/serverless/a.test.ts'],
    ['--files', '/etc/passwd'],
    ['--files', 'apps/server/../web/a.test.ts'],
    ['--files', '.git/config'],
  ])('refuses %j with a usage error', async (...argv) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(argv)).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
    expect(npm).not.toHaveBeenCalled();
  });
});
