import { spawnSync } from 'node:child_process';
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
    expect(log.mock.calls).toEqual([['merge-test scope: all (--all)'], ['merge-test scope: all (--all)']]);
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
    expect(spawn).toHaveBeenLastCalledWith('git', ['diff', '--name-only', '-z', 'HEAD^1', 'HEAD'], {
      encoding: 'utf8',
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid flags without running commands', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runMergeTest(['--unknown'])).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
  });
});
