import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CheckBranchGit } from '../contracts';
import { createGitSeed } from '../../test/helpers/git-seed';
import { createCheckBranchGit, githubRepoOfUrl } from './check-branch';

/** Real git against a temp bare remote: the branch operations are the boundary here. */

const REF = { projectKey: 'PM', repo: 'projectman' };
const BRANCH = 'pm-check/abc123/run-1';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

let root: string;
let counter = 0;
let seed: ReturnType<typeof createGitSeed>;

interface Fixture {
  repo: string;
  remote: string;
  branches: CheckBranchGit;
  /** A commit that is not an ancestor of the seed commit's branch. */
  feature: string;
}

function fixture(options: { withRemote?: boolean } = {}): Fixture {
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  const repo = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  seed.copyTo(repo, options.withRemote === false ? undefined : remote);
  git(repo, 'checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(repo, 'f.txt'), 'feature\n');
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'feature');
  const feature = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  mkdirSync(dir, { recursive: true });
  const branches = createCheckBranchGit({
    repoPath: (projectKey, name) => (projectKey === 'PM' && name === 'projectman' ? repo : null),
  });
  return { repo, remote, branches, feature };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-check-branch-')));
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
  vi.stubEnv('HOME', root);
  seed = createGitSeed(path.join(root, 'seed'), { 'a.txt': 'one\n' });
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('githubRepoOfUrl', () => {
  it.each([
    ['git@github.com:acme/widgets.git', 'acme/widgets'],
    ['git@github.com:acme/widgets', 'acme/widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/wid.gets.git', 'acme/wid.gets'],
    ['https://github.com/acme/widgets', 'acme/widgets'],
  ])('reads %s', (url, expected) => {
    expect(githubRepoOfUrl(url)).toBe(expected);
  });

  it.each([
    'https://gitlab.com/acme/widgets.git',
    'https://github.com.evil.test/acme/widgets.git',
    'https://user:token@github.com/acme/widgets.git',
    'https://github.com/acme/widgets/extra',
    '/srv/git/widgets.git',
  ])('gives null for %s', (url) => {
    expect(githubRepoOfUrl(url)).toBeNull();
  });
});

describe('upstreamRepo', () => {
  it('reads the repository from the push URL of the base upstream', async () => {
    const { repo, branches } = fixture();
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git');
    git(repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:acme/pushed.git');
    await expect(branches.upstreamRepo(REF, { base: 'main' })).resolves.toBe('acme/pushed');
  });

  it('gives null for a local remote and for a base without an upstream', async () => {
    const withRemote = fixture();
    await expect(withRemote.branches.upstreamRepo(REF, { base: 'main' })).resolves.toBeNull();
    const local = fixture({ withRemote: false });
    await expect(local.branches.upstreamRepo(REF, { base: 'main' })).resolves.toBeNull();
  });
});

describe('push, list and remove', () => {
  it('pushes a commit to a new branch, lists it, and deletes it', async () => {
    const { remote, branches, feature } = fixture();
    await expect(branches.push(REF, { base: 'main', commit: feature, branch: BRANCH })).resolves.toEqual({
      ok: true,
    });
    expect(git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(feature);
    await expect(branches.list(REF, { base: 'main', prefix: 'pm-check/' })).resolves.toEqual([BRANCH]);

    await branches.remove(REF, { base: 'main', branch: BRANCH });
    expect(git(remote, 'branch', '--list', 'pm-check/*')).toBe('');
    await expect(branches.list(REF, { base: 'main', prefix: 'pm-check/' })).resolves.toEqual([]);
  });

  it('does not touch the base branch of the remote', async () => {
    const { remote, branches, feature } = fixture();
    const before = git(remote, 'rev-parse', 'main');
    await branches.push(REF, { base: 'main', commit: feature, branch: BRANCH });
    expect(git(remote, 'rev-parse', 'main')).toBe(before);
  });

  it('refuses to move an existing branch backwards instead of forcing it', async () => {
    const { remote, branches, feature } = fixture();
    await branches.push(REF, { base: 'main', commit: feature, branch: BRANCH });
    const seedCommit = git(remote, 'rev-parse', 'main');
    const result = await branches.push(REF, { base: 'main', commit: seedCommit, branch: BRANCH });
    expect(result).toMatchObject({ ok: false, reason: 'non_fast_forward' });
    expect(git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(feature);
  });

  it('treats deleting a branch that is not there as done', async () => {
    const { branches } = fixture();
    await expect(branches.remove(REF, { base: 'main', branch: BRANCH })).resolves.toBeUndefined();
  });

  it('lists only well-formed check branches', async () => {
    const { remote, branches, feature } = fixture();
    await branches.push(REF, { base: 'main', commit: feature, branch: BRANCH });
    git(remote, 'update-ref', 'refs/heads/pm-check/odd', feature);
    git(remote, 'update-ref', 'refs/heads/pm-check/abc/has.dot', feature);
    await expect(branches.list(REF, { base: 'main', prefix: 'pm-check/' })).resolves.toEqual([BRANCH]);
  });

  it('is refused for a base without an upstream', async () => {
    const { branches, feature } = fixture({ withRemote: false });
    await expect(branches.push(REF, { base: 'main', commit: feature, branch: BRANCH })).rejects.toMatchObject(
      { code: 'no_remote' },
    );
  });

  it.each([
    ['a branch outside the prefix', 'main'],
    ['a branch with an option-like name', '--delete'],
    ['a branch with a path escape', 'pm-check/../main'],
    ['a branch with a bad stamp', 'pm-check/UPPER/run-1'],
  ])('refuses %s', async (_name, branch) => {
    const { remote, branches, feature } = fixture();
    await expect(branches.push(REF, { base: 'main', commit: feature, branch })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(branches.remove(REF, { base: 'main', branch })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
  });

  it('lists only under the check prefix', async () => {
    const { branches } = fixture();
    await expect(branches.list(REF, { base: 'main', prefix: '' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});
