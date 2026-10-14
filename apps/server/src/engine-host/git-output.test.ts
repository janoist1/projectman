import { describe, expect, it } from 'vitest';
import { classifyPush, overlappingPaths, parseWorktrees, statusPaths } from './git-output';

describe('helpers', () => {
  it('reads paths from the porcelain status, renames giving both names', () => {
    expect(statusPaths(' M a.txt\0?? dir/b.txt\0R  new.txt\0old.txt\0')).toEqual([
      'a.txt',
      'dir/b.txt',
      'new.txt',
      'old.txt',
    ]);
  });

  it('finds overlaps by path and by file-versus-directory', () => {
    expect(overlappingPaths(['a', 'b/c', 'd/e/f', 'x'], ['a/1', 'b', 'd/e'])).toEqual(['a', 'b/c', 'd/e/f']);
    expect(overlappingPaths(['same'], ['same'])).toEqual(['same']);
    expect(overlappingPaths(['other'], ['same'])).toEqual([]);
  });

  it('parses the worktree list', () => {
    const out =
      'worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/w\nHEAD def\ndetached\n\nworktree /gone\nHEAD 1\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n';
    expect(parseWorktrees(out)).toEqual([
      { path: '/r', branch: 'refs/heads/main', prunable: false },
      { path: '/r/w', branch: null, prunable: false },
      { path: '/gone', branch: 'refs/heads/x', prunable: true },
    ]);
  });

  it('classifies a failed push', () => {
    expect(classifyPush('! [rejected] main -> main (fetch first)', false)).toBe('non_fast_forward');
    expect(
      classifyPush('remote: error: GH006: Protected branch update failed\n! [remote rejected]', false),
    ).toBe('rejected');
    expect(classifyPush('fatal: Authentication failed for x', false)).toBe('rejected');
    expect(classifyPush('fatal: unable to access x: Could not resolve host: h', false)).toBe('unreachable');
    expect(classifyPush('', true)).toBe('unreachable');
    expect(classifyPush('something unknown', false)).toBe('rejected');
  });
});
