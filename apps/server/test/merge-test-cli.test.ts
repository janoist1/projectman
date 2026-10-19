import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMergeTest } from '../../../scripts/merge-test/run';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);
const ended = (stdout = '', status = 0) => ({ stdout, stderr: '', status, signal: null, pid: 1, output: [] });

beforeEach(() => {
  // The members' sandboxes carry the PTY skip; the merge runs without it (PM-754).
  vi.stubEnv('PROJECTMAN_SKIP_PTY_TESTS', '');
});
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('merge test runner', () => {
  const output = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
  it('stops at the first failed step and ends with the scope', () => {
    const log = output();
    spawn.mockReturnValueOnce(ended('', 7));
    expect(runMergeTest(['--all'])).toBe(7);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([
      ['merge-test scope: all (--all); modules: all; tests: all; fallback: --all'],
      ['merge-test scope: all (--all); modules: all; tests: all; fallback: --all'],
    ]);
  });
  it('runs everything when HEAD is not a merge', () => {
    output();
    spawn.mockReturnValueOnce(ended('head parent\n')).mockReturnValue(ended());
    expect(runMergeTest([])).toBe(0);
    expect(spawn.mock.calls.slice(1).map((call) => call.slice(0, 2))).toEqual([
      ['npm', ['run', 'typecheck']],
      ['npm', ['test']],
    ]);
  });
  it('uses the first-parent diff and does no checks for docs only', () => {
    output();
    spawn
      .mockReturnValueOnce(ended('head first second\n'))
      .mockReturnValueOnce(ended('docs/a.md\0README.md\0'));
    expect(runMergeTest([])).toBe(0);
    expect(spawn).toHaveBeenLastCalledWith(
      'git',
      ['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD'],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid flags without running commands', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runMergeTest(['--unknown'])).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
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
    spawn.mockImplementation((command, args) => {
      if (command === 'npm') return ended();
      if (args?.[0] === 'rev-list') return ended('head first second');
      if (args?.[0] === 'diff') return ended(changed.join('\0') + '\0');
      if (args?.[0] === 'ls-tree') return ended(listing);
      if (args?.[0] === 'cat-file') return { ...ended(), stdout: batch, stderr: Buffer.alloc(0) };
      throw new Error('unexpected command');
    });
  }
  it('reads both trees as blobs and runs modules followed by the web workspace', () => {
    const log = output();
    mockTrees(['apps/server/src/logging/index.ts', 'apps/web/src/a.ts']);
    expect(runMergeTest([])).toBe(0);
    expect(spawn.mock.calls.filter(([command]) => command === 'npm').map(([, args]) => args)).toEqual([
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
      spawn.mock.calls.filter(([, args]) => args?.[0] === 'ls-tree').map(([, args]) => args?.[3]),
    ).toEqual(['HEAD^1', 'HEAD']);
    expect(log.mock.calls[0]?.[0]).toContain('tests: 2');
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
  });
  it('keeps full workspace fallback with its reason for helper changes', () => {
    const log = output();
    mockTrees(['apps/server/test/helpers/a.ts']);
    expect(runMergeTest([])).toBe(0);
    expect(spawn.mock.calls.filter(([command]) => command === 'npm').map(([, args]) => args)).toEqual([
      ['run', 'typecheck', '-w', 'apps/server'],
      ['test', '-w', 'apps/server'],
    ]);
    expect(log.mock.calls[0]?.[0]).toContain('fallback: test, helper or fixture changed');
  });
  it('runs only the filtered cloud checks for a cloud-only first-parent diff', () => {
    const log = output();
    mockTrees(['scripts/cloud/a.ts', 'deploy/aws/b.tf', 'docs/CLOUD.md']);
    expect(runMergeTest([])).toBe(0);
    expect(spawn.mock.calls.filter(([command]) => command === 'npm').map(([, args]) => args)).toEqual([
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
        resolve('apps/server/test/control-relay.integration.test.ts'),
        resolve('apps/server/test/control-socket.integration.test.ts'),
      ],
    ]);
    expect(spawn.mock.calls.some(([, args]) => args?.[0] === 'ls-tree')).toBe(false);
    expect(log.mock.calls).toHaveLength(2);
    expect(log.mock.calls[0]?.[0]).toContain('merge-test scope: cloud');
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
  });
  it('stops the cloud branch on its first failed check with its exit code', () => {
    const log = output();
    mockTrees(['scripts/cloud/a.ts']);
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation((...args) => (args[0] === 'npm' ? ended('', 5) : original(...args)));
    expect(runMergeTest([])).toBe(5);
    expect(spawn.mock.calls.filter(([command]) => command === 'npm')).toHaveLength(1);
    expect(log.mock.calls[0]).toEqual(log.mock.calls.at(-1));
  });
  it('keeps the full run for a cloud diff that also changes shared code', () => {
    const log = output();
    mockTrees(['scripts/cloud/a.ts', 'packages/shared/src/a.ts']);
    expect(runMergeTest([])).toBe(0);
    expect(spawn.mock.calls.filter(([command]) => command === 'npm').map(([, args]) => args)).toEqual([
      ['run', 'typecheck'],
      ['test'],
    ]);
    expect(log.mock.calls[0]?.[0]).toContain('merge-test scope: all');
  });
  it('stops the module branch on its first failed check', () => {
    output();
    mockTrees(['apps/server/src/logging/index.ts']);
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation((...args) => (args[0] === 'npm' ? ended('', 9) : original(...args)));
    expect(runMergeTest([])).toBe(9);
    expect(spawn.mock.calls.filter(([command]) => command === 'npm')).toHaveLength(1);
  });
  describe('with the members’ PTY skip set (PM-754)', () => {
    const npmCalls = () => spawn.mock.calls.filter(([command]) => command === 'npm');
    const refused = () => {
      vi.stubEnv('PROJECTMAN_SKIP_PTY_TESTS', '1');
      return vi.spyOn(console, 'error').mockImplementation(() => undefined);
    };
    it.each([
      ['all', ['apps/server/src/logging/index.ts', 'packages/shared/src/a.ts']],
      ['cloud', ['scripts/cloud/a.ts']],
      ['modules', ['apps/server/src/logging/index.ts']],
      ['server workspace fallback', ['apps/server/test/helpers/a.ts']],
    ])('exits 2 before any check for the %s scope', (_name, changed) => {
      output();
      mockTrees(changed);
      const error = refused();
      expect(runMergeTest([])).toBe(2);
      expect(error).toHaveBeenCalledWith(
        'merge-test: server checks require PTY and Unix socket integration tests',
      );
      expect(npmCalls()).toHaveLength(0);
    });
    it('exits 2 for --all too', () => {
      output();
      const error = refused();
      expect(runMergeTest(['--all'])).toBe(2);
      expect(error).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
    });
    it('keeps the web-only and the none scopes unchanged', () => {
      output();
      refused();
      mockTrees(['apps/web/src/a.ts']);
      expect(runMergeTest([])).toBe(0);
      expect(npmCalls().map(([, args]) => args)).toEqual([
        ['run', 'typecheck', '-w', 'apps/web'],
        ['test', '-w', 'apps/web'],
      ]);
      spawn.mockReset();
      mockTrees(['docs/a.md']);
      expect(runMergeTest([])).toBe(0);
      expect(npmCalls()).toHaveLength(0);
    });
  });
  it('fails closed for malformed batch output', () => {
    output();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockTrees(['apps/server/src/logging/index.ts']);
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation((...args) =>
      args[1]?.[0] === 'cat-file'
        ? { ...ended(), stdout: Buffer.from('missing\n'), stderr: Buffer.alloc(0) }
        : original(...args),
    );
    expect(runMergeTest([])).toBe(2);
    expect(spawn.mock.calls.some(([command]) => command === 'npm')).toBe(false);
  });
});
