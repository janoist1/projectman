import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMergeTest } from '../../../scripts/merge-test/run';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(spawnSync);
const ended = (stdout = '', status = 0) => ({ stdout, stderr: '', status, signal: null, pid: 1, output: [] });

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
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
  it('stops the module branch on its first failed check', () => {
    output();
    mockTrees(['apps/server/src/logging/index.ts']);
    const original = spawn.getMockImplementation()!;
    spawn.mockImplementation((...args) => (args[0] === 'npm' ? ended('', 9) : original(...args)));
    expect(runMergeTest([])).toBe(9);
    expect(spawn.mock.calls.filter(([command]) => command === 'npm')).toHaveLength(1);
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
