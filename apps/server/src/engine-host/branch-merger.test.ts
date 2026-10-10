import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BranchMerger } from '../contracts';
import {
  classifyPush,
  createLocalBranchMerger,
  MERGE_CHECK_DIR,
  overlappingPaths,
  parseWorktrees,
  statusPaths,
} from './branch-merger';
import { scrubCredentials } from './merge-git';
import { isBranchName, isCommitId, isMergeId, isMergeMessage } from './merge-input';

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

describe('input checks', () => {
  it('accepts commit ids, merge ids and messages only in their shape', () => {
    expect(isCommitId('a'.repeat(40))).toBe(true);
    expect(isCommitId('A'.repeat(64))).toBe(true);
    expect(isCommitId('main')).toBe(false);
    expect(isCommitId('a'.repeat(39))).toBe(false);
    expect(isMergeId('mrg_abcdefgh1')).toBe(true);
    expect(isMergeId('mrg_short')).toBe(false);
    expect(isMergeId('../x')).toBe(false);
    expect(isMergeId('')).toBe(false);
    expect(isMergeMessage('Merge PM-1')).toBe(true);
    expect(isMergeMessage('a\0b')).toBe(false);
    expect(isMergeMessage('x'.repeat(2001))).toBe(false);
  });

  it('accepts branch names git accepts and refuses expansions and options', async () => {
    for (const ok of ['main', 'release/1.0', 'feature-x']) expect(await isBranchName(ok)).toBe(true);
    for (const bad of [
      '',
      'HEAD',
      '@',
      '-x',
      '--upload-pack=x',
      '@{-1}',
      'a..b',
      'a b',
      'a\nb',
      'x.lock',
      'a:b',
      'a~1',
    ])
      expect(await isBranchName(bad), bad).toBe(false);
  });
});

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

  it('scrubs credentials from git output', () => {
    expect(scrubCredentials('fatal: unable to access https://user:secret@example.test/r.git/')).toBe(
      'fatal: unable to access https://***@example.test/r.git/',
    );
    expect(scrubCredentials('token ghp_abcDEF123 and Bearer abc.def')).toBe('token *** and Bearer ***');
  });
});
