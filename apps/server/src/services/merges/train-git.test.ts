import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createLocalBranchMerger } from '../../engine-host';

it('checks the full first-parent diff and preserves every approved source in a real train commit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-train-git-'));
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    }).trim();
  const commit = (file: string) => {
    writeFileSync(path.join(repo, file), file);
    git('add', file);
    git('commit', '-q', '--no-verify', '-m', `Add ${file}`);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Train test');
    git('config', 'user.email', 'train@test.invalid');
    git('config', 'commit.gpgsign', 'false');
    const original = commit('base.txt');
    const sources: string[] = [];
    for (const file of ['early.txt', 'middle.txt', 'last.txt']) {
      git('checkout', '-q', '-b', `feature-${file}`, original);
      sources.push(commit(file));
    }
    git('checkout', '-q', 'main');
    const ref = { projectKey: 'PM', repo: 'projectman' };
    const merger = createLocalBranchMerger({
      repoPath: () => repo,
      worktreesRoot: path.join(root, 'worktrees'),
    });
    let tip = original;
    for (const source of sources) {
      const built = await merger.build(ref, { onto: tip, commit: source, message: 'Build train member' });
      if (!built.ok) throw new Error('Unexpected train conflict');
      tip = built.mergeCommit;
    }
    const closed = await merger.build(ref, { onto: original, commit: tip, message: 'Close train' });
    if (!closed.ok) throw new Error('Unexpected closing conflict');
    expect(git('rev-parse', `${closed.mergeCommit}^1`)).toBe(original);
    expect(git('diff', '--name-only', `${closed.mergeCommit}^1`, closed.mergeCommit).split('\n')).toEqual([
      'early.txt',
      'last.txt',
      'middle.txt',
    ]);
    for (const source of sources)
      expect(await merger.isAncestor(ref, { ancestor: source, commit: closed.mergeCommit })).toBe(true);
    expect(git('rev-parse', 'main')).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
