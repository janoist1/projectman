import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BranchMerger, MergeRepoRef } from '../contracts';
import { newId } from '../kernel';
import { createLocalBranchMerger } from './branch-merger';
import { DEPENDENCIES_NOT_INSTALLED, MERGE_CHECK_DIR } from './merge-check';
import { createGitSeed } from '../../test/helpers/git-seed';

const REF = { projectKey: 'PM', repo: 'projectman' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commit(repo: string, message: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--no-verify', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

let root: string;
let counter = 0;
let seed: ReturnType<typeof createGitSeed>;
let anonymousSeed: ReturnType<typeof createGitSeed>;

interface Fixture {
  repo: string;
  remote: string;
  worktreesRoot: string;
  merger: BranchMerger;
}

/** A repository on `main` with a bare remote as its upstream; `withRemote: false` leaves it local only. */
function fixture(
  options: {
    withRemote?: boolean;
    identity?: boolean;
    onCheckoutAdvanced?: (ref: MergeRepoRef, checkout: string) => void;
  } = {},
): Fixture {
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  const repo = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  const worktreesRoot = path.join(dir, 'worktrees');
  mkdirSync(worktreesRoot, { recursive: true });
  (options.identity === false ? anonymousSeed : seed).copyTo(
    repo,
    options.withRemote === false ? undefined : remote,
  );
  const merger = createLocalBranchMerger({
    repoPath: (projectKey, name) => (projectKey === 'PM' && name === 'projectman' ? repo : null),
    worktreesRoot,
    ...(options.onCheckoutAdvanced ? { onCheckoutAdvanced: options.onCheckoutAdvanced } : {}),
  });
  return { repo, remote, worktreesRoot, merger };
}

/** A feature commit on a side branch that touches `file`; the checkout returns to main. */
function feature(repo: string, file: string, content: string, name = 'feature'): string {
  git(repo, 'checkout', '-q', '-b', name);
  write(repo, file, content);
  const id = commit(repo, `feature ${file}`);
  git(repo, 'checkout', '-q', 'main');
  return id;
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-merger-')));
  // No global git configuration of the machine: the tests set what they need.
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
  vi.stubEnv('HOME', root);
  vi.stubEnv('GIT_AUTHOR_NAME', undefined);
  vi.stubEnv('GIT_AUTHOR_EMAIL', undefined);
  vi.stubEnv('GIT_COMMITTER_NAME', undefined);
  vi.stubEnv('GIT_COMMITTER_EMAIL', undefined);
  vi.stubEnv('EMAIL', undefined);
  const files = { 'a.txt': 'one\n', 'b.txt': 'bee\n' };
  seed = createGitSeed(path.join(root, 'seed'), files, {
    name: 'Merge Owner',
    email: 'owner@example.test',
  });
  anonymousSeed = createGitSeed(path.join(root, 'anonymous-seed'), files, false);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('prepare', () => {
  it('reports a local-only repository without a remote', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    const head = git(repo, 'rev-parse', 'HEAD');
    const state = await merger.prepare(REF, { base: 'main', commit: head });
    expect(state).toEqual({
      local: head,
      remote: null,
      relation: 'same',
      contains: { local: true, remote: null },
      checkout: realpathSync(repo),
    });
  });

  it('says a commit not yet in the base is not contained, and finds the checkout of the base', async () => {
    const { merger, repo, remote } = fixture();
    const id = feature(repo, 'f.txt', 'x\n');
    const state = await merger.prepare(REF, { base: 'main', commit: id });
    expect(state.relation).toBe('same');
    expect(state.contains).toEqual({ local: false, remote: false });
    expect(state.remote).toEqual({ name: 'origin', commit: git(remote, 'rev-parse', 'main') });
    expect(state.checkout).toBe(realpathSync(repo));
  });

  it('is already contained when the commit is an ancestor of the base', async () => {
    const { merger, repo } = fixture();
    const first = git(repo, 'rev-parse', 'HEAD');
    write(repo, 'c.txt', 'c\n');
    commit(repo, 'second');
    const state = await merger.prepare(REF, { base: 'main', commit: first });
    expect(state.contains.local).toBe(true);
    expect(state.contains.remote).toBe(true);
    expect(state.relation).toBe('local_ahead');
  });

  it('fetches the remote and sees that the local branch is behind or has diverged', async () => {
    const { merger, repo, remote } = fixture();
    const other = path.join(root, `clone-${counter}`);
    execFileSync('git', ['clone', '-q', remote, other]);
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'other@example.test');
    write(other, 'r.txt', 'remote\n');
    const remoteHead = commit(other, 'remote work');
    git(other, 'push', '-q', 'origin', 'main');
    const id = feature(repo, 'f.txt', 'x\n');
    const behind = await merger.prepare(REF, { base: 'main', commit: id });
    expect(behind.relation).toBe('local_behind');
    expect(behind.remote?.commit).toBe(remoteHead);
    write(repo, 'l.txt', 'local\n');
    commit(repo, 'local work');
    const diverged = await merger.prepare(REF, { base: 'main', commit: id });
    expect(diverged.relation).toBe('diverged');
  });

  it('refuses an unknown commit, a bad base and an unbound repository', async () => {
    const { merger } = fixture();
    await expect(merger.prepare(REF, { base: 'main', commit: 'a'.repeat(40) })).rejects.toMatchObject({
      code: 'unknown_object',
    });
    await expect(
      merger.prepare(REF, { base: '--upload-pack=x', commit: 'a'.repeat(40) }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(merger.prepare(REF, { base: 'HEAD', commit: 'a'.repeat(40) })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      merger.prepare({ projectKey: 'XX', repo: 'nope' }, { base: 'main', commit: 'a'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('isAncestor', () => {
  it('answers yes, no and null for an unknown commit', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    const first = git(repo, 'rev-parse', 'HEAD');
    const id = feature(repo, 'f.txt', 'x\n');
    expect(await merger.isAncestor(REF, { ancestor: first, commit: id })).toBe(true);
    expect(await merger.isAncestor(REF, { ancestor: id, commit: first })).toBe(false);
    expect(await merger.isAncestor(REF, { ancestor: 'b'.repeat(40), commit: id })).toBeNull();
  });
});

describe('build', () => {
  it('merges cleanly into a merge commit with two parents and lists the changed paths', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    const onto = git(repo, 'rev-parse', 'HEAD');
    const id = feature(repo, 'f.txt', 'x\n');
    write(repo, 'b.txt', 'changed on main\n');
    const main = commit(repo, 'main moves');
    const result = await merger.build(REF, { onto: main, commit: id, message: 'Merge PM-1: add f' });
    if (!result.ok) throw new Error('expected a clean merge');
    expect(result.changed).toEqual(['f.txt']);
    expect(git(repo, 'rev-parse', `${result.mergeCommit}^1`)).toBe(main);
    expect(git(repo, 'rev-parse', `${result.mergeCommit}^2`)).toBe(id);
    expect(git(repo, 'log', '-1', '--format=%s%n%an <%ae>', result.mergeCommit)).toBe(
      'Merge PM-1: add f\nMerge Owner <owner@example.test>',
    );
    expect(git(repo, 'rev-parse', 'main')).toBe(main); // the branch itself is not moved
    expect(onto).not.toBe(main);
  });

  it('reports the conflicting paths, sorted, and leaves the repository untouched', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    const id = feature(repo, 'a.txt', 'feature\n');
    write(repo, 'a.txt', 'main\n');
    const main = commit(repo, 'main edit');
    const before = git(repo, 'status', '--porcelain');
    const result = await merger.build(REF, { onto: main, commit: id, message: 'Merge' });
    expect(result).toEqual({ ok: false, conflict: ['a.txt'] });
    expect(git(repo, 'status', '--porcelain')).toBe(before);
    expect(git(repo, 'rev-parse', 'main')).toBe(main);
  });

  it('refuses when the repository has no committer identity', async () => {
    const { merger, repo } = fixture({ withRemote: false, identity: false });
    const head = git(repo, 'rev-parse', 'HEAD');
    await expect(merger.build(REF, { onto: head, commit: head, message: 'Merge' })).rejects.toMatchObject({
      code: 'no_identity',
    });
  });

  it('refuses a bad message and bad ids', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    const head = git(repo, 'rev-parse', 'HEAD');
    await expect(merger.build(REF, { onto: head, commit: head, message: '  ' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(merger.build(REF, { onto: head, commit: head, message: 'a\0b' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(merger.build(REF, { onto: 'main', commit: head, message: 'x' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('checkoutConflicts', () => {
  it('lists the dirty paths of the base checkout that the merge would change', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    write(repo, 'a.txt', 'dirty\n');
    write(repo, 'new/untracked.txt', 'u\n');
    write(repo, 'unrelated.txt', 'u\n');
    expect(
      await merger.checkoutConflicts(REF, { base: 'main', changed: ['a.txt', 'new', 'zzz.txt'] }),
    ).toEqual(['a.txt', 'new/untracked.txt']);
  });

  it('is empty when the base is checked out nowhere', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    git(repo, 'checkout', '-q', '-b', 'elsewhere');
    expect(await merger.checkoutConflicts(REF, { base: 'main', changed: ['a.txt'] })).toEqual([]);
  });
});

describe('checkoutForCheck and releaseCheck', () => {
  function install(checkout: string, marker: string, fresh = true): void {
    write(checkout, 'node_modules/.package-lock.json', '{}');
    write(checkout, 'node_modules/source.txt', marker);
    const time = new Date('2026-01-01T00:00:00Z');
    utimesSync(path.join(checkout, 'package-lock.json'), time, time);
    const installed = new Date(time.getTime() + (fresh ? 1000 : -1000));
    utimesSync(path.join(checkout, 'node_modules/.package-lock.json'), installed, installed);
  }

  it.each(['preferred', 'repository', 'worktree', 'stale preferred'])(
    'selects an installed checkout matching the merge lockfile: %s',
    async (scenario) => {
      const { repo, merger, worktreesRoot } = fixture({ withRemote: false });
      write(repo, '.gitignore', 'node_modules/\n');
      write(repo, 'package-lock.json', 'old lock');
      const old = commit(repo, 'add old lock');
      const preferred = path.join(worktreesRoot, 'card');
      git(repo, 'worktree', 'add', '--detach', preferred, old);
      // The card is older than the dependency change on main.
      write(preferred, 'card.txt', 'card change');
      const card = commit(preferred, 'change card');
      write(repo, 'package-lock.json', 'merged lock');
      const main = commit(repo, 'change dependencies');
      const built = await merger.build(REF, { onto: main, commit: card, message: 'merge card' });
      if (!built.ok) throw new Error('unexpected conflict');
      let depsFrom: string | null = preferred;
      let expected: string;
      if (scenario === 'preferred') {
        write(preferred, 'package-lock.json', 'merged lock');
        install(preferred, 'preferred');
        install(repo, 'repository');
        expected = 'preferred';
      } else if (scenario === 'repository') {
        depsFrom = null;
        install(repo, 'repository');
        expected = 'repository';
      } else {
        install(preferred, 'preferred');
        if (scenario === 'stale preferred') {
          write(preferred, 'package-lock.json', 'merged lock');
          install(preferred, 'preferred', false);
        }
        const other = path.join(worktreesRoot, 'other');
        git(repo, 'worktree', 'add', '--detach', other, main);
        install(other, 'other');
        expected = 'other';
      }
      const mergeId = 'mrg_lock0001';
      const made = await merger.checkoutForCheck(REF, { mergeId, mergeCommit: built.mergeCommit, depsFrom });
      expect(readFileSync(path.join(made.path, 'package-lock.json'), 'utf8')).toBe('merged lock');
      expect(readFileSync(path.join(made.path, 'node_modules/source.txt'), 'utf8')).toBe(expected);
      await merger.releaseCheck(REF, { mergeId });
    },
  );

  it.each(['missing', 'stale', 'outside', 'merge', 'symlink outside', 'prunable'])(
    'refuses without an eligible dependency source and releases the checkout: %s',
    async (scenario) => {
      const { repo, merger, worktreesRoot } = fixture({ withRemote: false });
      write(repo, '.gitignore', 'node_modules/\n');
      write(repo, 'package-lock.json', 'merged lock');
      const head = commit(repo, 'add lock');
      if (scenario === 'stale') install(repo, 'stale', false);
      else if (scenario !== 'missing') {
        const outside = path.join(root, `outside-source-${counter}`);
        const other =
          scenario === 'merge'
            ? path.join(worktreesRoot, MERGE_CHECK_DIR, 'other')
            : scenario === 'prunable'
              ? path.join(worktreesRoot, 'prunable')
              : outside;
        git(repo, 'worktree', 'add', '--detach', other, head);
        install(other, scenario);
        if (scenario === 'symlink outside') symlinkSync(other, path.join(worktreesRoot, 'linked'));
        if (scenario === 'prunable') rmSync(other, { recursive: true, force: true });
      }
      const mergeId = 'mrg_nolocksource';
      await expect(
        merger.checkoutForCheck(REF, { mergeId, mergeCommit: head, depsFrom: null }),
      ).rejects.toMatchObject({ code: 'git_failed', message: DEPENDENCIES_NOT_INSTALLED });
      expect(existsSync(path.join(worktreesRoot, MERGE_CHECK_DIR, mergeId))).toBe(false);
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(mergeId);
    },
  );

  describe('allowDependencyInstall (PM-681)', () => {
    async function lockedHead(scenario: 'stale preferred' | 'symlink lock' | 'no lock') {
      const made = fixture({ withRemote: false });
      const { repo } = made;
      write(repo, '.gitignore', 'node_modules/\n');
      let head: string;
      if (scenario === 'no lock') {
        head = commit(repo, 'ignore modules');
      } else if (scenario === 'symlink lock') {
        write(repo, 'real-lock.json', 'merged lock');
        symlinkSync('real-lock.json', path.join(repo, 'package-lock.json'));
        head = commit(repo, 'link the lock');
      } else {
        write(repo, 'package-lock.json', 'merged lock');
        head = commit(repo, 'add lock');
      }
      const deps = path.join(root, `stale-deps-${counter}`);
      write(deps, 'package-lock.json', 'old lock');
      install(deps, 'stale');
      return { ...made, head, deps };
    }

    it('asks for an installation instead of copying old packages when no checkout matches the lockfile', async () => {
      const { merger, head, deps, worktreesRoot } = await lockedHead('stale preferred');
      const made = await merger.checkoutForCheck(REF, {
        mergeId: 'mrg_install001',
        mergeCommit: head,
        depsFrom: deps,
        allowDependencyInstall: true,
      });
      expect(made.dependencyInstallRequired).toBe(true);
      expect(existsSync(path.join(made.path, 'node_modules'))).toBe(false);
      expect(readFileSync(path.join(made.path, 'package-lock.json'), 'utf8')).toBe('merged lock');
      await merger.releaseCheck(REF, { mergeId: 'mrg_install001' });
      expect(existsSync(path.join(worktreesRoot, MERGE_CHECK_DIR, 'mrg_install001'))).toBe(false);
    });

    it.each([undefined, false])(
      "keeps today's refusal when the switch is %s",
      async (allowDependencyInstall) => {
        const { merger, head, deps, worktreesRoot } = await lockedHead('stale preferred');
        await expect(
          merger.checkoutForCheck(REF, {
            mergeId: 'mrg_install002',
            mergeCommit: head,
            depsFrom: deps,
            ...(allowDependencyInstall === undefined ? {} : { allowDependencyInstall }),
          }),
        ).rejects.toMatchObject({ code: 'git_failed', message: DEPENDENCIES_NOT_INSTALLED });
        expect(existsSync(path.join(worktreesRoot, MERGE_CHECK_DIR, 'mrg_install002'))).toBe(false);
      },
    );

    it('copies a matching source without asking for an installation', async () => {
      const { repo, merger, head } = await lockedHead('stale preferred');
      write(repo, 'package-lock.json', 'merged lock');
      install(repo, 'repository');
      const made = await merger.checkoutForCheck(REF, {
        mergeId: 'mrg_install003',
        mergeCommit: head,
        depsFrom: null,
        allowDependencyInstall: true,
      });
      expect(made.dependencyInstallRequired).toBeUndefined();
      expect(readFileSync(path.join(made.path, 'node_modules/source.txt'), 'utf8')).toBe('repository');
      await merger.releaseCheck(REF, { mergeId: 'mrg_install003' });
    });

    it('copies the preferred source of a checkout with no lockfile, and never installs for a symlinked lockfile', async () => {
      for (const scenario of ['no lock', 'symlink lock'] as const) {
        const { merger, head, deps } = await lockedHead(scenario);
        const mergeId = `mrg_install${scenario === 'no lock' ? 'a' : 'b'}01`;
        const made = await merger.checkoutForCheck(REF, {
          mergeId,
          mergeCommit: head,
          depsFrom: deps,
          allowDependencyInstall: true,
        });
        expect(made.dependencyInstallRequired).toBeUndefined();
        expect(readFileSync(path.join(made.path, 'node_modules/source.txt'), 'utf8')).toBe('stale');
        await merger.releaseCheck(REF, { mergeId });
      }
    });

    it('still blocks a dependency path that overlaps the checkout or does not exist', async () => {
      const { merger, head, worktreesRoot } = await lockedHead('stale preferred');
      await expect(
        merger.checkoutForCheck(REF, {
          mergeId: 'mrg_install004',
          mergeCommit: head,
          depsFrom: path.join(root, 'no-such-deps'),
          allowDependencyInstall: true,
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      expect(existsSync(path.join(worktreesRoot, MERGE_CHECK_DIR, 'mrg_install004'))).toBe(false);
    });
  });

  it('makes a detached checkout under _merge, copies dependencies with relative links kept, and releases it', async () => {
    const { merger, repo, worktreesRoot } = fixture({ withRemote: false });
    const head = git(repo, 'rev-parse', 'HEAD');
    const deps = path.join(root, `deps-${counter}`);
    mkdirSync(path.join(deps, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(deps, 'node_modules', 'pkg', 'index.js'), 'ok');
    mkdirSync(path.join(deps, 'node_modules', '.vite'), { recursive: true });
    writeFileSync(path.join(deps, 'node_modules', '.vite', 'cache'), 'x');
    symlinkSync('pkg', path.join(deps, 'node_modules', 'alias'));
    const made = await merger.checkoutForCheck(REF, {
      mergeId: 'mrg_first0001',
      mergeCommit: head,
      depsFrom: deps,
    });
    const expected = path.join(realpathSync(worktreesRoot), MERGE_CHECK_DIR, 'mrg_first0001');
    expect(made.path).toBe(expected);
    expect(made.gitDir).toBe(realpathSync(path.join(repo, '.git')));
    expect(readFileSync(path.join(expected, 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(path.join(expected, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('ok');
    expect(lstatSync(path.join(expected, 'node_modules', 'alias')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(expected, 'node_modules', '.vite'))).toBe(false);
    expect(git(expected, 'rev-parse', 'HEAD')).toBe(head);
    await merger.releaseCheck(REF, { mergeId: 'mrg_first0001' });
    expect(existsSync(expected)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('mrg_first0001');
    await merger.releaseCheck(REF, { mergeId: 'mrg_first0001' }); // releasing again is fine
  });

  it('accepts the id the domain makes for a merge (newId), not only a hand-written one (PM-551)', async () => {
    const { merger, repo, worktreesRoot } = fixture({ withRemote: false });
    const head = git(repo, 'rev-parse', 'HEAD');
    const mergeId = newId('merge');
    const made = await merger.checkoutForCheck(REF, { mergeId, mergeCommit: head, depsFrom: null });
    expect(made.path).toBe(path.join(realpathSync(worktreesRoot), MERGE_CHECK_DIR, mergeId));
    await merger.releaseCheck(REF, { mergeId });
    expect(existsSync(made.path)).toBe(false);
  });

  it('reports a dependency copy timeout as git_failed and releases the checkout', async () => {
    const { repo, worktreesRoot } = fixture({ withRemote: false });
    const deps = path.join(root, `deps-timeout-${counter}`);
    write(deps, 'node_modules/pkg/index.js', 'package');
    const merger = createLocalBranchMerger({ repoPath: () => repo, worktreesRoot, copyTimeoutMs: 0 });
    const mergeId = 'mrg_timeout0001';
    await expect(
      merger.checkoutForCheck(REF, { mergeId, mergeCommit: git(repo, 'rev-parse', 'HEAD'), depsFrom: deps }),
    ).rejects.toMatchObject({ code: 'git_failed', message: 'copying the dependencies timed out' });
    expect(existsSync(path.join(worktreesRoot, MERGE_CHECK_DIR, mergeId))).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(mergeId);
  });

  it('does not copy dependencies through a link the merged tree tracks, out of the checkout', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    const outside = path.join(root, `outside-${counter}`);
    mkdirSync(path.join(outside, 'app'), { recursive: true });
    symlinkSync(outside, path.join(repo, 'packages'));
    mkdirSync(path.join(repo, 'web'), { recursive: true });
    symlinkSync(path.join(outside, 'app'), path.join(repo, 'web', 'node_modules'));
    const tracked = commit(repo, 'track links');
    const deps = path.join(root, `deps-link-${counter}`);
    mkdirSync(path.join(deps, 'packages', 'app', 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(path.join(deps, 'web', 'node_modules', 'pkg'), { recursive: true });
    const made = await merger.checkoutForCheck(REF, {
      mergeId: 'mrg_escape001',
      mergeCommit: tracked,
      depsFrom: deps,
    });
    expect(readdirSync(path.join(outside, 'app'))).toEqual([]);
    expect(lstatSync(path.join(made.path, 'web', 'node_modules')).isSymbolicLink()).toBe(true);
    await merger.releaseCheck(REF, { mergeId: 'mrg_escape001' });
  });

  it('remakes a leftover of an earlier try with the same id', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    const head = git(repo, 'rev-parse', 'HEAD');
    const first = await merger.checkoutForCheck(REF, {
      mergeId: 'mrg_again001',
      mergeCommit: head,
      depsFrom: null,
    });
    write(first.path, 'leftover.txt', 'x\n');
    const second = await merger.checkoutForCheck(REF, {
      mergeId: 'mrg_again001',
      mergeCommit: head,
      depsFrom: null,
    });
    expect(second.path).toBe(first.path);
    expect(existsSync(path.join(second.path, 'leftover.txt'))).toBe(false);
    await merger.releaseCheck(REF, { mergeId: 'mrg_again001' });
  });

  it('refuses a bad merge id, a relative or missing dependencies path and one inside the checkout', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    const head = git(repo, 'rev-parse', 'HEAD');
    await expect(
      merger.checkoutForCheck(REF, { mergeId: '../x', mergeCommit: head, depsFrom: null }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      merger.checkoutForCheck(REF, { mergeId: 'mrg_badpath01', mergeCommit: head, depsFrom: 'relative' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      merger.checkoutForCheck(REF, {
        mergeId: 'mrg_badpath01',
        mergeCommit: head,
        depsFrom: path.join(root, 'missing-deps'),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // The failed try leaves no checkout behind.
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('mrg_badpath01');
  });

  it('refuses without a worktrees root', async () => {
    const { repo } = fixture({ withRemote: false });
    const merger = createLocalBranchMerger({ repoPath: () => repo, worktreesRoot: null });
    await expect(
      merger.checkoutForCheck(REF, {
        mergeId: 'mrg_noroot001',
        mergeCommit: git(repo, 'rev-parse', 'HEAD'),
        depsFrom: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('push', () => {
  it('sends a fast-forward and the remote branch moves', async () => {
    const { merger, repo, remote } = fixture();
    const id = feature(repo, 'f.txt', 'x\n');
    const built = await merger.build(REF, {
      onto: git(repo, 'rev-parse', 'main'),
      commit: id,
      message: 'Merge',
    });
    if (!built.ok) throw new Error('expected a clean merge');
    expect(await merger.push(REF, { base: 'main', mergeCommit: built.mergeCommit })).toEqual({ ok: true });
    expect(git(remote, 'rev-parse', 'main')).toBe(built.mergeCommit);
  });

  it('sends no tags even when the repository follows them', async () => {
    const { merger, repo, remote } = fixture();
    git(repo, 'config', 'push.followTags', 'true');
    const id = feature(repo, 'f.txt', 'x\n');
    git(repo, 'tag', '-a', '-m', 'release', 'v1', id);
    const built = await merger.build(REF, {
      onto: git(repo, 'rev-parse', 'main'),
      commit: id,
      message: 'Merge',
    });
    if (!built.ok) throw new Error('expected a clean merge');
    expect(await merger.push(REF, { base: 'main', mergeCommit: built.mergeCommit })).toEqual({ ok: true });
    expect(git(remote, 'tag', '--list')).toBe('');
  });

  it('refuses a base that tracks a remote branch of another name, in prepare and in push', async () => {
    const { merger, repo, remote } = fixture();
    git(repo, 'push', '-q', 'origin', 'main:other');
    git(repo, 'branch', '-q', '--set-upstream-to=origin/other', 'main');
    const head = git(repo, 'rev-parse', 'HEAD');
    await expect(merger.prepare(REF, { base: 'main', commit: head })).rejects.toMatchObject({
      code: 'no_remote',
    });
    await expect(merger.push(REF, { base: 'main', mergeCommit: head })).rejects.toMatchObject({
      code: 'no_remote',
    });
    expect(git(remote, 'rev-parse', 'main')).toBe(head);
  });

  it('is refused as non_fast_forward when the remote moved on, and never forces', async () => {
    const { merger, repo, remote } = fixture();
    const other = path.join(root, `clone-push-${counter}`);
    execFileSync('git', ['clone', '-q', remote, other]);
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'other@example.test');
    write(other, 'r.txt', 'remote\n');
    const remoteHead = commit(other, 'remote work');
    git(other, 'push', '-q', 'origin', 'main');
    const id = feature(repo, 'f.txt', 'x\n');
    const built = await merger.build(REF, {
      onto: git(repo, 'rev-parse', 'main'),
      commit: id,
      message: 'Merge',
    });
    if (!built.ok) throw new Error('expected a clean merge');
    const result = await merger.push(REF, { base: 'main', mergeCommit: built.mergeCommit });
    expect(result).toMatchObject({ ok: false, reason: 'non_fast_forward' });
    expect(git(remote, 'rev-parse', 'main')).toBe(remoteHead);
  });

  it('reports a pre-receive hook of the remote that rejects the push as rejected', async () => {
    const { merger, repo, remote } = fixture();
    const hook = path.join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "protected branch: no pushes here" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const id = feature(repo, 'f.txt', 'x\n');
    const before = git(remote, 'rev-parse', 'main');
    const result = await merger.push(REF, { base: 'main', mergeCommit: id });
    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
    if (!result.ok) expect(result.message).toContain('protected branch');
    expect(git(remote, 'rev-parse', 'main')).toBe(before);
  });

  it('reports an unreachable remote', async () => {
    const { merger, repo } = fixture();
    git(repo, 'remote', 'set-url', 'origin', path.join(root, 'no-such-remote.git'));
    const id = feature(repo, 'f.txt', 'x\n');
    const result = await merger.push(REF, { base: 'main', mergeCommit: id });
    expect(result.ok).toBe(false);
  });

  it('does not run the local pre-push or pre-commit hooks of the repository', async () => {
    const { merger, repo, remote } = fixture();
    const marker = path.join(root, `hook-ran-${counter}`);
    for (const name of ['pre-push', 'pre-commit', 'commit-msg', 'post-merge', 'pre-merge-commit']) {
      const hook = path.join(repo, '.git', 'hooks', name);
      writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      chmodSync(hook, 0o755);
    }
    const id = feature(repo, 'f.txt', 'x\n'); // the helper commits with --no-verify
    const from = git(repo, 'rev-parse', 'main');
    const built = await merger.build(REF, { onto: from, commit: id, message: 'Merge' });
    if (!built.ok) throw new Error('expected a clean merge');
    expect(await merger.push(REF, { base: 'main', mergeCommit: built.mergeCommit })).toEqual({ ok: true });
    expect(await merger.advance(REF, { base: 'main', from, to: built.mergeCommit })).toEqual({ ok: true });
    expect(existsSync(marker)).toBe(false);
    expect(git(remote, 'rev-parse', 'main')).toBe(built.mergeCommit);
  });

  it('refuses a branch with no upstream', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    await expect(
      merger.push(REF, { base: 'main', mergeCommit: git(repo, 'rev-parse', 'HEAD') }),
    ).rejects.toMatchObject({ code: 'no_remote' });
  });
});

describe('release tags', () => {
  it('pushes an annotated tag on the commit and lists it with the commit it points at', async () => {
    const { merger, repo, remote } = fixture();
    const head = git(repo, 'rev-parse', 'HEAD');

    expect(await merger.pushTag(REF, { base: 'main', tag: 'v2026.1.2', commit: head })).toEqual({ ok: true });

    expect(git(remote, 'cat-file', '-t', 'v2026.1.2')).toBe('tag');
    expect(await merger.remoteTags(REF, { base: 'main' })).toEqual([{ name: 'v2026.1.2', commit: head }]);
  });

  it('refuses a tag the remote has, never moving it', async () => {
    const { merger, repo, remote } = fixture();
    const first = git(repo, 'rev-parse', 'HEAD');
    await merger.pushTag(REF, { base: 'main', tag: 'v1', commit: first });
    const second = feature(repo, 'f.txt', 'x\n');

    const result = await merger.pushTag(REF, { base: 'main', tag: 'v1', commit: second });

    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
    expect(git(remote, 'rev-parse', 'v1^{commit}')).toBe(first);
    expect(git(repo, 'tag', '--list', 'v1')).toBe('');
  });

  it('refuses a tag name that is no release tag and a commit the repository does not have', async () => {
    const { merger, repo } = fixture();
    const head = git(repo, 'rev-parse', 'HEAD');

    await expect(merger.pushTag(REF, { base: 'main', tag: '-d', commit: head })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      merger.pushTag(REF, { base: 'main', tag: 'v1', commit: 'a'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'unknown_object' });
  });

  it('refuses a branch with no upstream, for the listing and for the push', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    const head = git(repo, 'rev-parse', 'HEAD');

    await expect(merger.remoteTags(REF, { base: 'main' })).rejects.toMatchObject({ code: 'no_remote' });
    await expect(merger.pushTag(REF, { base: 'main', tag: 'v1', commit: head })).rejects.toMatchObject({
      code: 'no_remote',
    });
  });
});

describe('advance', () => {
  async function merged(f: Fixture) {
    const id = feature(f.repo, 'f.txt', 'x\n');
    const from = git(f.repo, 'rev-parse', 'main');
    const built = await f.merger.build(REF, { onto: from, commit: id, message: 'Merge' });
    if (!built.ok) throw new Error('expected a clean merge');
    return { from, to: built.mergeCommit };
  }

  it('fast-forwards a branch that is checked out, updating the files', async () => {
    const f = fixture({ withRemote: false });
    const { from, to } = await merged(f);
    expect(await f.merger.advance(REF, { base: 'main', from, to })).toEqual({ ok: true });
    expect(git(f.repo, 'rev-parse', 'main')).toBe(to);
    expect(readFileSync(path.join(f.repo, 'f.txt'), 'utf8')).toBe('x\n');
  });

  it('moves the ref of a branch that is checked out nowhere', async () => {
    const f = fixture({ withRemote: false });
    const { from, to } = await merged(f);
    git(f.repo, 'checkout', '-q', '-b', 'elsewhere');
    expect(await f.merger.advance(REF, { base: 'main', from, to })).toEqual({ ok: true });
    expect(git(f.repo, 'rev-parse', 'main')).toBe(to);
  });

  it('tells the owner of the checkout about a moved checkout', async () => {
    const seen: string[] = [];
    const f = fixture({ withRemote: false, onCheckoutAdvanced: (_ref, checkout) => seen.push(checkout) });
    const { from, to } = await merged(f);
    await f.merger.advance(REF, { base: 'main', from, to });
    expect(seen).toEqual([realpathSync(f.repo)]);
  });

  it('does not tell the owner of the checkout about a refused advance', async () => {
    const seen: string[] = [];
    const f = fixture({ withRemote: false, onCheckoutAdvanced: (_ref, checkout) => seen.push(checkout) });
    const { from, to } = await merged(f);
    write(f.repo, 'f.txt', 'untracked and in the way\n');
    await f.merger.advance(REF, { base: 'main', from, to });
    expect(seen).toEqual([]);
  });

  it('does not tell the owner of the checkout about a ref move', async () => {
    const seen: string[] = [];
    const f = fixture({ withRemote: false, onCheckoutAdvanced: (_ref, checkout) => seen.push(checkout) });
    const { from, to } = await merged(f);
    git(f.repo, 'checkout', '-q', '-b', 'elsewhere');
    await f.merger.advance(REF, { base: 'main', from, to });
    expect(seen).toEqual([]);
  });

  it('reports moved when the branch is no longer at `from`', async () => {
    const f = fixture({ withRemote: false });
    const { from, to } = await merged(f);
    write(f.repo, 'later.txt', 'l\n');
    const later = commit(f.repo, 'moved on');
    const result = await f.merger.advance(REF, { base: 'main', from, to });
    expect(result).toMatchObject({ ok: false, reason: 'moved', paths: [] });
    expect(git(f.repo, 'rev-parse', 'main')).toBe(later);
    git(f.repo, 'checkout', '-q', '-b', 'elsewhere');
    expect(await f.merger.advance(REF, { base: 'main', from, to })).toMatchObject({
      ok: false,
      reason: 'moved',
    });
    expect(git(f.repo, 'rev-parse', 'main')).toBe(later);
  });

  it('reports checkout_in_the_way with the paths when a dirty file would be overwritten', async () => {
    const f = fixture({ withRemote: false });
    const { from, to } = await merged(f);
    write(f.repo, 'f.txt', 'untracked and in the way\n');
    const result = await f.merger.advance(REF, { base: 'main', from, to });
    expect(result).toMatchObject({ ok: false, reason: 'checkout_in_the_way', paths: ['f.txt'] });
    expect(git(f.repo, 'rev-parse', 'main')).toBe(from);
    expect(readFileSync(path.join(f.repo, 'f.txt'), 'utf8')).toBe('untracked and in the way\n');
  });

  it('keeps unrelated dirty files and refuses a `to` that does not descend from `from`', async () => {
    const f = fixture({ withRemote: false });
    const { from, to } = await merged(f);
    write(f.repo, 'a.txt', 'my edit\n');
    expect(await f.merger.advance(REF, { base: 'main', from, to })).toEqual({ ok: true });
    expect(readFileSync(path.join(f.repo, 'a.txt'), 'utf8')).toBe('my edit\n');
    await expect(f.merger.advance(REF, { base: 'main', from: to, to: from })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('listPaths', () => {
  it('lists the tracked files of the local base head, sorted, without the untracked ones', async () => {
    const f = fixture({ withRemote: false });
    write(f.repo, 'z/deep/last.ts', 'z\n');
    write(f.repo, 'dir/first.ts', 'f\n');
    const head = commit(f.repo, 'more files');
    write(f.repo, 'untracked.txt', 'u\n');
    expect(await f.merger.listPaths(REF, { base: 'main' })).toEqual({
      commit: head,
      paths: ['a.txt', 'b.txt', 'dir/first.ts', 'z/deep/last.ts'],
      truncated: false,
    });
  });

  it('cuts the list at the cap and says so', async () => {
    const f = fixture({ withRemote: false });
    const merger = createLocalBranchMerger({
      repoPath: () => f.repo,
      worktreesRoot: null,
      maxListedPaths: 1,
    });
    expect(await merger.listPaths(REF, { base: 'main' })).toMatchObject({
      paths: ['a.txt'],
      truncated: true,
    });
    const exact = createLocalBranchMerger({ repoPath: () => f.repo, worktreesRoot: null, maxListedPaths: 2 });
    expect(await exact.listPaths(REF, { base: 'main' })).toMatchObject({ truncated: false });
  });

  it('rejects an unknown base and a bad one', async () => {
    const f = fixture({ withRemote: false });
    await expect(f.merger.listPaths(REF, { base: 'nope' })).rejects.toMatchObject({
      code: 'unknown_object',
    });
    await expect(f.merger.listPaths(REF, { base: '--x' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('changedPaths', () => {
  it('diffs a branch against its merge base, leaving out what the base did meanwhile', async () => {
    const f = fixture({ withRemote: false });
    const head = feature(f.repo, 'dir/new.ts', 'n\n', 'PM-1-card');
    write(f.repo, 'later.txt', 'l\n');
    commit(f.repo, 'base moved on');
    expect(
      await f.merger.changedPaths(REF, {
        base: 'main',
        items: [{ id: 'PM-1', at: { branch: 'PM-1-card' } }],
      }),
    ).toEqual([{ id: 'PM-1', ok: true, commit: head, paths: ['dir/new.ts'], truncated: false }]);
  });

  it('diffs a commit against its merge base, in input order, sorted', async () => {
    const f = fixture({ withRemote: false });
    git(f.repo, 'checkout', '-q', '-b', 'side');
    write(f.repo, 'b.txt', 'changed\n');
    write(f.repo, 'a/z.ts', 'z\n');
    const first = commit(f.repo, 'side');
    git(f.repo, 'checkout', '-q', 'main');
    const other = feature(f.repo, 'other.ts', 'o\n', 'other');
    expect(
      await f.merger.changedPaths(REF, {
        base: 'main',
        items: [
          { id: 'two', at: { commit: other } },
          { id: 'one', at: { commit: first.toUpperCase() } },
        ],
      }),
    ).toEqual([
      { id: 'two', ok: true, commit: other, paths: ['other.ts'], truncated: false },
      { id: 'one', ok: true, commit: first, paths: ['a/z.ts', 'b.txt'], truncated: false },
    ]);
  });

  it('diffs a merge commit against its first parent, after build and advance', async () => {
    const f = fixture({ withRemote: false });
    const head = feature(f.repo, 'f.txt', 'x\n', 'card');
    const from = git(f.repo, 'rev-parse', 'main');
    const built = await f.merger.build(REF, { onto: from, commit: head, message: 'Merge' });
    if (!built.ok) throw new Error('expected a clean merge');
    expect(await f.merger.advance(REF, { base: 'main', from, to: built.mergeCommit })).toEqual({ ok: true });
    expect(
      await f.merger.changedPaths(REF, {
        base: 'main',
        items: [{ id: 'PM-1', at: { merge: built.mergeCommit } }],
      }),
    ).toEqual([{ id: 'PM-1', ok: true, commit: built.mergeCommit, paths: ['f.txt'], truncated: false }]);
    // A branch already merged into the base has nothing left to show.
    expect(
      await f.merger.changedPaths(REF, { base: 'main', items: [{ id: 'PM-1', at: { branch: 'card' } }] }),
    ).toEqual([{ id: 'PM-1', ok: true, commit: head, paths: [], truncated: false }]);
  });

  it('shows a rename as a delete and an add', async () => {
    const f = fixture({ withRemote: false });
    git(f.repo, 'checkout', '-q', '-b', 'mover');
    git(f.repo, 'mv', 'a.txt', 'moved.txt');
    const head = commit(f.repo, 'rename');
    git(f.repo, 'checkout', '-q', 'main');
    expect(
      await f.merger.changedPaths(REF, { base: 'main', items: [{ id: 'PM-1', at: { branch: 'mover' } }] }),
    ).toEqual([{ id: 'PM-1', ok: true, commit: head, paths: ['a.txt', 'moved.txt'], truncated: false }]);
  });

  it('cuts one item at the cap and says so', async () => {
    const f = fixture({ withRemote: false });
    git(f.repo, 'checkout', '-q', '-b', 'many');
    write(f.repo, 'one.ts', '1\n');
    write(f.repo, 'two.ts', '2\n');
    write(f.repo, 'three.ts', '3\n');
    commit(f.repo, 'three files');
    git(f.repo, 'checkout', '-q', 'main');
    const merger = createLocalBranchMerger({
      repoPath: () => f.repo,
      worktreesRoot: null,
      maxChangedPaths: 2,
    });
    expect(
      await merger.changedPaths(REF, { base: 'main', items: [{ id: 'PM-1', at: { branch: 'many' } }] }),
    ).toMatchObject([{ ok: true, paths: ['one.ts', 'three.ts'], truncated: true }]);
  });

  it('answers unknown for an unknown branch or commit, a branch without a merge base and a merge without a parent', async () => {
    const f = fixture({ withRemote: false });
    git(f.repo, 'checkout', '-q', '--orphan', 'unrelated');
    git(f.repo, 'rm', '-rfq', '.');
    write(f.repo, 'x.txt', 'x\n');
    commit(f.repo, 'root');
    git(f.repo, 'checkout', '-q', 'main');
    const root = git(f.repo, 'rev-list', '--max-parents=0', 'main');
    const result = await f.merger.changedPaths(REF, {
      base: 'main',
      items: [
        { id: 'a', at: { branch: 'nope' } },
        { id: 'b', at: { commit: '1'.repeat(40) } },
        { id: 'c', at: { branch: 'unrelated' } },
        { id: 'd', at: { merge: root } },
        { id: 'e', at: { merge: '2'.repeat(40) } },
      ],
    });
    expect(result).toEqual(['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, ok: false, reason: 'unknown' })));
  });

  it('rejects more than 25 items, a bad base, a bad branch name and a bad commit id', async () => {
    const f = fixture({ withRemote: false });
    const item = (n: number) => ({ id: `PM-${n}`, at: { commit: '1'.repeat(40) } });
    const items = Array.from({ length: 26 }, (_, n) => item(n));
    await expect(f.merger.changedPaths(REF, { base: 'main', items })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      f.merger.changedPaths(REF, { base: 'main', items: items.slice(0, 25) }),
    ).resolves.toHaveLength(25);
    await expect(f.merger.changedPaths(REF, { base: 'nope', items: [item(1)] })).rejects.toMatchObject({
      code: 'unknown_object',
    });
    await expect(f.merger.changedPaths(REF, { base: '--x', items: [item(1)] })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    for (const at of [{ branch: '--x' }, { commit: 'main' }, { merge: 'HEAD^1' }])
      await expect(
        f.merger.changedPaths(REF, { base: 'main', items: [{ id: 'PM-1', at }] }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      f.merger.changedPaths(REF, { base: 'main', items: [{ id: '', at: { commit: '1'.repeat(40) } }] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('readFile', () => {
  it('reads a file at a commit, and null for a file that is not there', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    write(repo, 'docs/log.md', 'Döntés ✓\n');
    const head = commit(repo, 'docs');
    expect(await merger.readFile(REF, { at: { commit: head }, path: 'docs/log.md' })).toEqual({
      commit: head,
      text: 'Döntés ✓\n',
    });
    expect(await merger.readFile(REF, { at: { commit: head }, path: 'docs/none.md' })).toEqual({
      commit: head,
      text: null,
    });
    expect(await merger.readFile(REF, { at: { commit: head }, path: 'docs/log.md/deeper' })).toMatchObject({
      text: null,
    });
  });

  it('reads the head of the base after fetching its upstream, else the local branch', async () => {
    const { merger, repo, remote } = fixture();
    const old = git(repo, 'rev-parse', 'HEAD');
    const other = path.join(root, `clone-${counter}`);
    execFileSync('git', ['clone', '-q', remote, other]);
    git(other, 'config', 'user.name', 'Other');
    git(other, 'config', 'user.email', 'other@example.test');
    write(other, 'a.txt', 'remote one\n');
    const remoteHead = commit(other, 'remote work');
    git(other, 'push', '-q', 'origin', 'main');
    expect(await merger.readFile(REF, { at: { base: 'main' }, path: 'a.txt' })).toEqual({
      commit: remoteHead,
      text: 'remote one\n',
    });
    expect(git(repo, 'rev-parse', 'main')).toBe(old); // the local branch is not moved
    const local = fixture({ withRemote: false });
    expect(await local.merger.readFile(REF, { at: { base: 'main' }, path: 'a.txt' })).toMatchObject({
      text: 'one\n',
    });
  });

  it('refuses a bad path, a file over 1 MiB, a binary file, a directory and an unknown commit', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    write(repo, 'big.txt', 'x'.repeat(1024 * 1024 + 1));
    write(repo, 'edge.txt', 'x'.repeat(1024 * 1024));
    writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    write(repo, 'nul.txt', 'a\0b');
    write(repo, 'dir/inner.txt', 'in\n');
    symlinkSync('a.txt', path.join(repo, 'link'));
    const head = commit(repo, 'files');
    const at = { commit: head };
    for (const bad of ['/abs', '../x', 'a/../b', '.git/config', 'a\\b', '', 'a//b', './a'])
      await expect(merger.readFile(REF, { at, path: bad })).rejects.toMatchObject({ code: 'invalid_input' });
    for (const file of ['big.txt', 'bin.dat', 'nul.txt', 'dir', 'link'])
      await expect(merger.readFile(REF, { at, path: file })).rejects.toMatchObject({
        code: 'invalid_input',
      });
    expect((await merger.readFile(REF, { at, path: 'edge.txt' })).text).toHaveLength(1024 * 1024);
    await expect(
      merger.readFile(REF, { at: { commit: 'a'.repeat(40) }, path: 'a.txt' }),
    ).rejects.toMatchObject({ code: 'unknown_object' });
    await expect(merger.readFile(REF, { at: { commit: 'main' }, path: 'a.txt' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(merger.readFile(REF, { at: { base: '-x' }, path: 'a.txt' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('commitFiles', () => {
  it('sets an existing and a new file in a commit whose parent is onto, touching no ref, index or working tree', async () => {
    const { merger, repo } = fixture();
    write(repo, 'docs/log.md', 'old\n');
    chmodSync(path.join(repo, 'docs/log.md'), 0o755);
    const onto = commit(repo, 'docs');
    write(repo, 'a.txt', 'dirty edit\n'); // unstaged work stays
    write(repo, 'staged.txt', 'staged\n');
    git(repo, 'add', 'staged.txt');
    const before = {
      refs: git(repo, 'for-each-ref'),
      status: git(repo, 'status', '--porcelain'),
      index: git(repo, 'ls-files', '--stage'),
      head: git(repo, 'rev-parse', 'HEAD'),
      tree: readFileSync(path.join(repo, 'a.txt'), 'utf8'),
    };
    const result = await merger.commitFiles(REF, {
      onto,
      files: [
        { path: 'docs/log.md', text: 'new\n' },
        { path: 'docs/roadmap.md', text: 'plan\n' },
      ],
      message: 'Update the project documents',
    });
    expect(result.changed).toEqual(['docs/log.md', 'docs/roadmap.md']);
    expect(git(repo, 'rev-parse', `${result.commit}^`)).toBe(onto);
    expect(git(repo, 'show', `${result.commit}:docs/log.md`)).toBe('new');
    expect(git(repo, 'show', `${result.commit}:docs/roadmap.md`)).toBe('plan');
    expect(git(repo, 'show', `${result.commit}:a.txt`)).toBe('one'); // the rest of the tree is onto's
    expect(git(repo, 'ls-tree', result.commit, 'docs/log.md')).toMatch(/^100755 /); // the mode is kept
    expect(git(repo, 'ls-tree', result.commit, 'docs/roadmap.md')).toMatch(/^100644 /);
    expect(git(repo, 'log', '-1', '--format=%s%n%an <%ae>', result.commit)).toBe(
      'Update the project documents\nMerge Owner <owner@example.test>',
    );
    expect({
      refs: git(repo, 'for-each-ref'),
      status: git(repo, 'status', '--porcelain'),
      index: git(repo, 'ls-files', '--stage'),
      head: git(repo, 'rev-parse', 'HEAD'),
      tree: readFileSync(path.join(repo, 'a.txt'), 'utf8'),
    }).toEqual(before);
    expect(existsSync(path.join(repo, 'docs/roadmap.md'))).toBe(false);
  });

  it('lists nothing as changed for a file whose text is already there', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    write(repo, 'existing.md', 'one\n');
    const onto = commit(repo, 'Add document');
    const result = await merger.commitFiles(REF, {
      onto,
      files: [
        { path: 'existing.md', text: 'one\n' },
        { path: 'new.md', text: '' },
      ],
      message: 'Same',
    });
    expect(result.changed).toEqual(['new.md']);
    const same = await merger.commitFiles(REF, {
      onto,
      files: [{ path: 'existing.md', text: 'one\n' }],
      message: 'S',
    });
    expect(same.changed).toEqual([]);
  });

  it('refuses without an identity, a bad file set, a bad message, a bad commit and a path over a directory', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    const onto = git(repo, 'rev-parse', 'HEAD');
    const ok = { path: 'a.md', text: 'x' };
    const refused = (input: Parameters<BranchMerger['commitFiles']>[1], code = 'invalid_input') =>
      expect(merger.commitFiles(REF, input)).rejects.toMatchObject({ code });
    await refused({ onto, files: [], message: 'm' });
    await refused({
      onto,
      files: [ok, { path: 'b.md', text: 'y' }, { path: 'c.md', text: 'z' }],
      message: 'm',
    });
    await refused({ onto, files: [ok, ok], message: 'm' });
    await refused({ onto, files: [{ path: '../x', text: 'y' }], message: 'm' });
    await refused({ onto, files: [{ path: '.git/hooks/x', text: 'y' }], message: 'm' });
    await refused({ onto, files: [{ path: 'a.md', text: 'a\0b' }], message: 'm' });
    await refused({ onto, files: [{ path: 'a.md', text: 'x'.repeat(1024 * 1024 + 1) }], message: 'm' });
    await refused({ onto, files: [ok], message: ' ' });
    await refused({ onto: 'main', files: [ok], message: 'm' });
    await refused({ onto: 'a'.repeat(40), files: [ok], message: 'm' }, 'unknown_object');
    const bare = fixture({ withRemote: false, identity: false });
    await expect(
      bare.merger.commitFiles(REF, { onto: git(bare.repo, 'rev-parse', 'HEAD'), files: [ok], message: 'm' }),
    ).rejects.toMatchObject({ code: 'no_identity' });
    write(repo, 'dir.md/x.txt', 'x\n');
    const withDir = commit(repo, 'dir');
    await refused({ onto: withDir, files: [{ path: 'dir.md', text: 'file' }], message: 'm' });
    await refused({ onto: withDir, files: [{ path: 'a.txt/inner.md', text: 'x' }], message: 'm' }); // a.txt is a file
  });
});

describe('regenerated conflicts (PM-1050)', () => {
  const PATTERNS = ['gen/*.txt'];

  /** `main` and a side branch both change `gen/snap.txt` (and `extra`, when given): a conflict. */
  function conflicting(extra?: string) {
    const { repo, merger, worktreesRoot } = fixture({ withRemote: false });
    write(repo, 'gen/snap.txt', 'base\n');
    write(repo, 'gen/keep.txt', 'keep\n');
    if (extra) write(repo, extra, 'base\n');
    commit(repo, 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
    write(repo, 'gen/snap.txt', 'feature\n');
    if (extra) write(repo, extra, 'feature\n');
    write(repo, 'f.txt', 'f\n');
    const commitId = commit(repo, 'feature change');
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'gen/snap.txt', 'main\n');
    if (extra) write(repo, extra, 'main\n');
    const onto = commit(repo, 'main change');
    return { repo, merger, worktreesRoot, onto, commitId };
  }

  async function provisional(mergeId: string, extra?: string) {
    const made = conflicting(extra);
    const result = await made.merger.build(REF, {
      onto: made.onto,
      commit: made.commitId,
      message: 'Merge PM-1: feature',
      regenerate: PATTERNS,
    });
    return { ...made, mergeId, result };
  }

  it('makes a merge commit without the conflicting generated files, parents onto and the commit', async () => {
    const { repo, onto, commitId, result } = await provisional('mrg_regen001');
    if (result.ok || !result.provisional) throw new Error('expected a provisional merge');
    expect(result.conflict).toEqual(['gen/snap.txt']);
    expect(git(repo, 'rev-list', '--parents', '-n1', result.provisional)).toBe(
      `${result.provisional} ${onto} ${commitId}`,
    );
    expect(git(repo, 'ls-tree', '-r', '--name-only', result.provisional)).not.toContain('gen/snap.txt');
    expect(git(repo, 'show', `${result.provisional}:f.txt`)).toBe('f');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('makes no provisional merge when a conflict is outside the patterns or no patterns are given', async () => {
    const mixed = await provisional('mrg_regen002', 'other.txt');
    if (mixed.result.ok) throw new Error('expected a conflict');
    expect(mixed.result.conflict).toEqual(['gen/snap.txt', 'other.txt']);
    expect(mixed.result.provisional).toBeUndefined();
    const plain = conflicting();
    const result = await plain.merger.build(REF, {
      onto: plain.onto,
      commit: plain.commitId,
      message: 'Merge',
    });
    expect(result).toEqual({ ok: false, conflict: ['gen/snap.txt'] });
  });

  it('refuses a bad pattern', async () => {
    const made = conflicting();
    await expect(
      made.merger.build(REF, {
        onto: made.onto,
        commit: made.commitId,
        message: 'Merge',
        regenerate: ['*/x'],
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  describe('commitRegenerated', () => {
    async function checkout(mergeId: string) {
      const made = await provisional(mergeId);
      if (made.result.ok || !made.result.provisional) throw new Error('expected a provisional merge');
      const check = await made.merger.checkoutForCheck(REF, {
        mergeId,
        mergeCommit: made.result.provisional,
        depsFrom: null,
      });
      return { ...made, provisional: made.result.provisional, dir: check.path };
    }
    const input = (made: { onto: string; commitId: string }, paths = ['gen/snap.txt']) => ({
      onto: made.onto,
      commit: made.commitId,
      message: 'Merge PM-1: feature\n\nregenerated',
      paths,
      patterns: PATTERNS,
    });

    it('commits the written files on top of the provisional merge, parents onto and the commit', async () => {
      const made = await checkout('mrg_regen010');
      write(made.dir, 'gen/snap.txt', 'regenerated\n');
      const result = await made.merger.commitRegenerated(REF, { mergeId: made.mergeId, ...input(made) });
      if (!result.ok) throw new Error(`refused: ${result.reason}`);
      expect(result.changed).toContain('gen/snap.txt');
      expect(git(made.repo, 'show', `${result.mergeCommit}:gen/snap.txt`)).toBe('regenerated');
      expect(git(made.repo, 'show', `${result.mergeCommit}:f.txt`)).toBe('f');
      expect(git(made.repo, 'rev-list', '--parents', '-n1', result.mergeCommit)).toBe(
        `${result.mergeCommit} ${made.onto} ${made.commitId}`,
      );
      await made.merger.releaseCheck(REF, { mergeId: made.mergeId });
    });

    it('takes a file the command removed and leaves what it did not touch', async () => {
      const made = await checkout('mrg_regen017');
      write(made.dir, 'gen/snap.txt', 'regenerated\n');
      rmSync(path.join(made.dir, 'gen/keep.txt'));
      write(made.dir, 'src/untouched.ts', 'outside the writable directory\n');
      const result = await made.merger.commitRegenerated(REF, { mergeId: made.mergeId, ...input(made) });
      if (!result.ok) throw new Error(`refused: ${result.reason}`);
      expect(git(made.repo, 'ls-tree', '-r', '--name-only', result.mergeCommit)).not.toContain(
        'gen/keep.txt',
      );
      expect(git(made.repo, 'ls-tree', '-r', '--name-only', result.mergeCommit)).not.toContain(
        'src/untouched.ts',
      );
      await made.merger.releaseCheck(REF, { mergeId: made.mergeId });
    });

    it('refuses a new or changed file in the writable directory that matches no pattern', async () => {
      const made = await checkout('mrg_regen011');
      write(made.dir, 'gen/snap.txt', 'regenerated\n');
      write(made.dir, 'gen/evil.js', 'x\n');
      expect(await made.merger.commitRegenerated(REF, { mergeId: made.mergeId, ...input(made) })).toEqual({
        ok: false,
        reason: 'outside',
        paths: ['gen/evil.js'],
      });
      await made.merger.releaseCheck(REF, { mergeId: made.mergeId });
    });

    it('refuses a flood of files', async () => {
      const made = await checkout('mrg_regen018');
      write(made.dir, 'gen/snap.txt', 'regenerated\n');
      for (let i = 0; i < 201; i += 1) write(made.dir, `gen/many-${i}.txt`, `${i}\n`);
      expect(await made.merger.commitRegenerated(REF, { mergeId: made.mergeId, ...input(made) })).toEqual({
        ok: false,
        reason: 'too_many',
        paths: [],
      });
      await made.merger.releaseCheck(REF, { mergeId: made.mergeId });
    });

    it('refuses a conflicting file the command did not write', async () => {
      const made = await checkout('mrg_regen012');
      expect(await made.merger.commitRegenerated(REF, { mergeId: made.mergeId, ...input(made) })).toEqual({
        ok: false,
        reason: 'missing',
        paths: ['gen/snap.txt'],
      });
      await made.merger.releaseCheck(REF, { mergeId: made.mergeId });
    });

    it.each(['symlink', 'hard link'] as const)('refuses a %s in place of a regular file', async (kind) => {
      const made = await checkout(`mrg_regen01${kind === 'symlink' ? '3' : '4'}`);
      const target = path.join(made.dir, 'gen/snap.txt');
      mkdirSync(path.dirname(target), { recursive: true });
      if (kind === 'symlink') symlinkSync(path.join(made.dir, 'f.txt'), target);
      else linkSync(path.join(made.dir, 'f.txt'), target);
      expect(
        await made.merger.commitRegenerated(REF, { mergeId: made.mergeId, ...input(made) }),
      ).toMatchObject({
        ok: false,
        reason: 'not_regular',
      });
      await made.merger.releaseCheck(REF, { mergeId: made.mergeId });
    });

    it('refuses files below a directory that is a link', async () => {
      const made = await checkout('mrg_regen015');
      write(made.dir, 'elsewhere/snap.txt', 'regenerated\n');
      rmSync(path.join(made.dir, 'gen'), { recursive: true });
      symlinkSync(path.join(made.dir, 'elsewhere'), path.join(made.dir, 'gen'));
      expect(
        await made.merger.commitRegenerated(REF, { mergeId: made.mergeId, ...input(made) }),
      ).toMatchObject({ ok: false });
      await made.merger.releaseCheck(REF, { mergeId: made.mergeId });
    });

    it('refuses a git name below a pattern, whatever the pattern says', async () => {
      const made = await checkout('mrg_regen016');
      write(made.dir, 'gen/snap.txt', 'regenerated\n');
      write(made.dir, 'gen/.gitattributes', '* filter=x\n');
      expect(await made.merger.commitRegenerated(REF, { mergeId: made.mergeId, ...input(made) })).toEqual({
        ok: false,
        reason: 'outside',
        paths: ['gen/.gitattributes'],
      });
      await made.merger.releaseCheck(REF, { mergeId: made.mergeId });
    });
  });
});
