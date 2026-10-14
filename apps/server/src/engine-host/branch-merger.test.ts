import { execFileSync } from 'node:child_process';
import {
  existsSync,
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
import type { BranchMerger } from '../contracts';
import { newId } from '../domain/util';
import { createLocalBranchMerger } from './branch-merger';
import { DEPENDENCIES_NOT_INSTALLED, MERGE_CHECK_DIR } from './merge-check';

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

interface Fixture {
  repo: string;
  remote: string;
  worktreesRoot: string;
  merger: BranchMerger;
}

/** A repository on `main` with a bare remote as its upstream; `withRemote: false` leaves it local only. */
function fixture(options: { withRemote?: boolean; identity?: boolean } = {}): Fixture {
  counter += 1;
  const dir = path.join(root, `case-${counter}`);
  const repo = path.join(dir, 'repo');
  const remote = path.join(dir, 'remote.git');
  const worktreesRoot = path.join(dir, 'worktrees');
  mkdirSync(repo, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  if (options.identity !== false) {
    git(repo, 'config', 'user.name', 'Merge Owner');
    git(repo, 'config', 'user.email', 'owner@example.test');
  }
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, 'a.txt', 'one\n');
  write(repo, 'b.txt', 'bee\n');
  if (options.identity === false) {
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Seed',
      '-c',
      'user.email=seed@example.test',
      'add',
      '-A',
    ]);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Seed',
      '-c',
      'user.email=seed@example.test',
      'commit',
      '-q',
      '-m',
      'seed',
    ]);
  } else commit(repo, 'seed');
  if (options.withRemote !== false) {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
  }
  const merger = createLocalBranchMerger({
    repoPath: (projectKey, name) => (projectKey === 'PM' && name === 'projectman' ? repo : null),
    worktreesRoot,
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
    const onto = git(repo, 'rev-parse', 'HEAD');
    const result = await merger.commitFiles(REF, {
      onto,
      files: [
        { path: 'a.txt', text: 'one\n' },
        { path: 'new.md', text: '' },
      ],
      message: 'Same',
    });
    expect(result.changed).toEqual(['new.md']);
    const same = await merger.commitFiles(REF, {
      onto,
      files: [{ path: 'a.txt', text: 'one\n' }],
      message: 'S',
    });
    expect(same.changed).toEqual([]);
  });

  it('refuses without an identity, a bad file set, a bad message, a bad commit and a path over a directory', async () => {
    const { merger, repo } = fixture({ withRemote: false });
    const onto = git(repo, 'rev-parse', 'HEAD');
    const ok = { path: 'a.txt', text: 'x' };
    const refused = (input: Parameters<BranchMerger['commitFiles']>[1], code = 'invalid_input') =>
      expect(merger.commitFiles(REF, input)).rejects.toMatchObject({ code });
    await refused({ onto, files: [], message: 'm' });
    await refused({
      onto,
      files: [ok, { path: 'b.txt', text: 'y' }, { path: 'c.txt', text: 'z' }],
      message: 'm',
    });
    await refused({ onto, files: [ok, ok], message: 'm' });
    await refused({ onto, files: [{ path: '../x', text: 'y' }], message: 'm' });
    await refused({ onto, files: [{ path: '.git/hooks/x', text: 'y' }], message: 'm' });
    await refused({ onto, files: [{ path: 'a.txt', text: 'a\0b' }], message: 'm' });
    await refused({ onto, files: [{ path: 'a.txt', text: 'x'.repeat(1024 * 1024 + 1) }], message: 'm' });
    await refused({ onto, files: [ok], message: ' ' });
    await refused({ onto: 'main', files: [ok], message: 'm' });
    await refused({ onto: 'a'.repeat(40), files: [ok], message: 'm' }, 'unknown_object');
    const bare = fixture({ withRemote: false, identity: false });
    await expect(
      bare.merger.commitFiles(REF, { onto: git(bare.repo, 'rev-parse', 'HEAD'), files: [ok], message: 'm' }),
    ).rejects.toMatchObject({ code: 'no_identity' });
    write(repo, 'dir/x.txt', 'x\n');
    const withDir = commit(repo, 'dir');
    await refused({ onto: withDir, files: [{ path: 'dir', text: 'file' }], message: 'm' });
    await refused({ onto: withDir, files: [{ path: 'a.txt/inner', text: 'x' }], message: 'm' }); // a.txt is a file
  });
});
