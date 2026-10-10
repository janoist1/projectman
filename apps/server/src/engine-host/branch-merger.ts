import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  BranchMerger,
  MergeAdvanceResult,
  MergeBaseState,
  MergeBuildResult,
  MergePushResult,
  MergeRepoRef,
} from '../contracts';
import { isWithin } from './within';
import { isBranchName, isCommitId, isMergeId, isMergeMessage } from './merge-input';
import { MergeError, NETWORK_GIT_TIMEOUT_MS, outputTail, runGit } from './merge-git';

/**
 * The local `BranchMerger` (PM-451, PM-448): the git work of merging a card's approved commit into the
 * default branch of a repository and sending it up. The repository is found from the engine's own
 * binding (`repoPath`), never from the call. Every git call goes through `runGit` (`merge-git.ts`): no
 * hooks, no signing, no prompt, no shell. The push uses the machine's own git login (the owner's) and
 * is never forced.
 */

export interface LocalBranchMergerOptions {
  /** The repository's path on this engine, from its own binding; null: the repository is not bound here. */
  repoPath: (projectKey: string, repo: string) => string | null;
  /** The engine's worktrees root; the checks live in `<worktreesRoot>/_merge/<mergeId>`. null: no check checkouts. */
  worktreesRoot: string | null;
  platform?: NodeJS.Platform;
  /** The budget for copying dependencies into a check checkout. */
  copyTimeoutMs?: number;
  /** The time limit of a fetch or a push (default 120 s). */
  networkTimeoutMs?: number;
}

export const MERGE_CHECK_DIR = '_merge';
export const MAX_CHANGED = 1000;
export const MAX_CONFLICTS = 50;
const MAX_NODE_MODULES_DEPTH = 2; // the root, `*/` and `*/*/`
const DEPENDENCY_COPY_TIMEOUT_MS = 300_000;
/** Caches under node_modules that may hold absolute paths of the place they were made in. */
const CACHE_DIRS = ['.vite', '.vite-temp', '.cache'];
const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const REPO_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

interface Upstream {
  /** The remote-tracking ref (`refs/remotes/origin/main`). */
  ref: string;
  remote: string;
  /** The branch on the remote (`refs/heads/main`). */
  remoteRef: string;
}

const invalid = (message: string): never => {
  throw new MergeError('invalid_input', message);
};

function paths(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0);
}

/** The paths of `git status --porcelain=v1 -z` (renames and copies give both names). */
export function statusPaths(output: string): string[] {
  const entries = output.split('\0');
  const found: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    found.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) {
      const original = entries[index + 1];
      if (original) found.push(original);
      index += 1;
    }
  }
  return found;
}

/** The paths of `touched` that `changed` also touches: the same path, or a file where the other has a directory. */
export function overlappingPaths(touched: readonly string[], changed: readonly string[]): string[] {
  const files = new Set(changed);
  const directories = new Set<string>();
  for (const file of changed) {
    for (let at = file.indexOf('/'); at !== -1; at = file.indexOf('/', at + 1))
      directories.add(file.slice(0, at));
  }
  const hit = new Set<string>();
  for (const candidate of touched) {
    let found = files.has(candidate) || directories.has(candidate);
    for (let at = candidate.indexOf('/'); !found && at !== -1; at = candidate.indexOf('/', at + 1))
      found = files.has(candidate.slice(0, at));
    if (found) hit.add(candidate);
  }
  return [...hit].sort();
}

/** The worktrees of a repository: path and the branch each has checked out (null: detached or bare). */
export function parseWorktrees(output: string): { path: string; branch: string | null; prunable: boolean }[] {
  const found: { path: string; branch: string | null; prunable: boolean }[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    let item: { path: string; branch: string | null; prunable: boolean } | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree '))
        item = { path: line.slice('worktree '.length), branch: null, prunable: false };
      else if (item && line.startsWith('branch ')) item.branch = line.slice('branch '.length);
      else if (item && line.startsWith('prunable')) item.prunable = true;
    }
    if (item) found.push(item);
  }
  return found;
}

/** How the output of a failed push reads: what the owner has to do about it. */
export function classifyPush(
  output: string,
  timedOut: boolean,
): 'non_fast_forward' | 'rejected' | 'unreachable' {
  if (timedOut) return 'unreachable';
  if (
    /permission denied|authentication failed|could not read (username|password)|terminal prompts disabled|remote rejected|declined|protected branch|not allowed|forbidden|\b40[13]\b|access denied|insufficient permission|denied to /i.test(
      output,
    )
  )
    return 'rejected';
  if (
    /non-fast-forward|fetch first|updates were rejected|tip of your current branch is behind|\[rejected\]/i.test(
      output,
    )
  )
    return 'non_fast_forward';
  if (
    /could not resolve host|unable to access|connection (refused|reset|timed out)|operation timed out|network is unreachable|no route to host|early eof|rpc failed|unexpected disconnect|could not read from remote|temporary failure in name resolution|name or service not known|broken pipe|the remote end hung up/i.test(
      output,
    )
  )
    return 'unreachable';
  return 'rejected';
}

export function createLocalBranchMerger(options: LocalBranchMergerOptions): BranchMerger {
  const platform = options.platform ?? process.platform;
  const networkTimeout = options.networkTimeoutMs ?? NETWORK_GIT_TIMEOUT_MS;

  const repoOf = (ref: MergeRepoRef): string => {
    if (!PROJECT_KEY.test(ref.projectKey) || !REPO_NAME.test(ref.repo))
      invalid('Not a project key or repo name');
    const repo = options.repoPath(ref.projectKey, ref.repo);
    if (!repo) return invalid(`${ref.projectKey}/${ref.repo} is not bound on this engine`);
    return repo;
  };
  const commitArg = (value: string, what: string): string => {
    if (!isCommitId(value)) invalid(`${what} is not a commit id`);
    return value.toLowerCase();
  };
  const baseArg = async (value: string): Promise<string> => {
    if (!(await isBranchName(value))) invalid('The base is not a branch name');
    return value;
  };

  const must = async (
    repo: string,
    args: readonly string[],
    what: string,
    opts?: Parameters<typeof runGit>[2],
  ) => {
    const result = await runGit(repo, args, opts);
    if (result.code !== 0)
      throw new MergeError(
        'git_failed',
        `${what} failed: ${outputTail(result.stderr || result.stdout, 500)}`,
      );
    return result.stdout;
  };
  /** The commit an object name points at, or null when there is none. */
  const resolveCommit = async (repo: string, name: string): Promise<string | null> => {
    const result = await runGit(repo, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
    return result.code === 0 ? result.stdout.trim() : null;
  };
  const requireCommit = async (repo: string, name: string, what: string): Promise<string> => {
    const commit = await resolveCommit(repo, name);
    if (!commit) throw new MergeError('unknown_object', `${what} is not known in this repository`);
    return commit;
  };
  const ancestor = async (repo: string, older: string, newer: string): Promise<boolean> => {
    const result = await runGit(repo, ['merge-base', '--is-ancestor', older, newer]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new MergeError('git_failed', `merge-base failed: ${outputTail(result.stderr, 500)}`);
  };
  const upstreamOf = async (repo: string, base: string): Promise<Upstream | null> => {
    const out = await must(
      repo,
      [
        'for-each-ref',
        '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)',
        `refs/heads/${base}`,
      ],
      'for-each-ref',
    );
    for (const line of out.split('\n')) {
      const [refname, ref, remote, remoteRef] = line.split('\0');
      if (refname !== `refs/heads/${base}` || !ref || !remote || remote === '.' || !remoteRef) continue;
      if (!REMOTE_NAME.test(remote))
        throw new MergeError('no_remote', 'The upstream remote has an unusable name');
      return { ref, remote, remoteRef };
    }
    return null;
  };
  const worktreeOf = async (repo: string, base: string): Promise<string | null> => {
    const out = await must(repo, ['worktree', 'list', '--porcelain'], 'worktree list', {
      env: { GIT_OPTIONAL_LOCKS: '0' },
    });
    return (
      parseWorktrees(out).find((item) => item.branch === `refs/heads/${base}` && !item.prunable)?.path ?? null
    );
  };
  const dirtyPaths = async (checkout: string): Promise<string[]> => {
    const out = await must(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'status', {
      env: { GIT_OPTIONAL_LOCKS: '0' },
    });
    return statusPaths(out);
  };

  const checkRoot = async (): Promise<string> => {
    if (!options.worktreesRoot) return invalid('This engine has no worktrees root');
    const root = path.join(await realpath(options.worktreesRoot), MERGE_CHECK_DIR);
    const known = await lstat(root).catch(() => null);
    if (known && (!known.isDirectory() || known.isSymbolicLink()))
      return invalid(`${root} is not a directory`);
    return root;
  };

  const prepare = async (
    ref: MergeRepoRef,
    input: { base: string; commit: string },
  ): Promise<MergeBaseState> => {
    const repo = repoOf(ref);
    const base = await baseArg(input.base);
    const commit = commitArg(input.commit, 'The commit');
    await requireCommit(repo, commit, 'The commit');
    const upstream = await upstreamOf(repo, base);
    if (upstream) {
      const fetched = await runGit(
        repo,
        [
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          '--no-write-fetch-head',
          '--',
          upstream.remote,
          `+${upstream.remoteRef}:${upstream.ref}`,
        ],
        { timeoutMs: networkTimeout },
      );
      if (fetched.code !== 0)
        throw new MergeError(
          'git_failed',
          `fetch failed${fetched.timedOut ? ' (timed out)' : ''}: ${outputTail(fetched.stderr || fetched.stdout, 500)}`,
        );
    }
    const local = await requireCommit(repo, `refs/heads/${base}`, 'The base');
    const containsLocal = await ancestor(repo, commit, local);
    let remote: MergeBaseState['remote'] = null;
    let relation: MergeBaseState['relation'] = 'same';
    let containsRemote: boolean | null = null;
    if (upstream) {
      const remoteCommit = await requireCommit(repo, upstream.ref, 'The upstream');
      remote = { name: upstream.remote, commit: remoteCommit };
      if (remoteCommit !== local) {
        if (await ancestor(repo, local, remoteCommit)) relation = 'local_behind';
        else if (await ancestor(repo, remoteCommit, local)) relation = 'local_ahead';
        else relation = 'diverged';
      }
      containsRemote = await ancestor(repo, commit, remoteCommit);
    }
    return {
      local,
      remote,
      relation,
      contains: { local: containsLocal, remote: containsRemote },
      checkout: await worktreeOf(repo, base),
    };
  };

  const isAncestor = async (
    ref: MergeRepoRef,
    input: { ancestor: string; commit: string },
  ): Promise<boolean | null> => {
    const repo = repoOf(ref);
    const older = commitArg(input.ancestor, 'The ancestor');
    const newer = commitArg(input.commit, 'The commit');
    if (!(await resolveCommit(repo, older)) || !(await resolveCommit(repo, newer))) return null;
    return ancestor(repo, older, newer);
  };

  const build = async (
    ref: MergeRepoRef,
    input: { onto: string; commit: string; message: string },
  ): Promise<MergeBuildResult> => {
    const repo = repoOf(ref);
    const onto = commitArg(input.onto, 'The base commit');
    const commit = commitArg(input.commit, 'The commit');
    if (!isMergeMessage(input.message) || input.message.trim().length === 0) invalid('Not a commit message');
    await requireCommit(repo, onto, 'The base commit');
    await requireCommit(repo, commit, 'The commit');
    // The identity first: a repository without one is told so before any work is done.
    const name = (await runGit(repo, ['config', '--get', 'user.name'])).stdout.trim();
    const email = (await runGit(repo, ['config', '--get', 'user.email'])).stdout.trim();
    if (!name || !email)
      throw new MergeError(
        'no_identity',
        'The repository has no committer identity: set user.name and user.email in its git configuration',
      );
    const merged = await runGit(repo, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      onto,
      commit,
    ]);
    if (merged.code === 1) {
      const [, ...rest] = merged.stdout.split('\0');
      const conflict = [
        ...new Set(rest.slice(0, rest.indexOf('') === -1 ? undefined : rest.indexOf(''))),
      ].sort();
      return { ok: false, conflict: conflict.slice(0, MAX_CONFLICTS) };
    }
    if (merged.code !== 0)
      throw new MergeError(
        'git_failed',
        `merge-tree failed: ${outputTail(merged.stderr || merged.stdout, 500)}`,
      );
    const tree = merged.stdout.split('\0')[0]!.trim();
    if (!isCommitId(tree)) throw new MergeError('git_failed', 'merge-tree gave no tree');
    const identity = {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    };
    const made = (
      await must(repo, ['commit-tree', tree, '-p', onto, '-p', commit, '-m', input.message], 'commit-tree', {
        env: identity,
      })
    ).trim();
    if (!isCommitId(made)) throw new MergeError('git_failed', 'commit-tree gave no commit');
    const diff = await must(
      repo,
      ['diff-tree', '-r', '--name-only', '-z', '--no-renames', '--no-commit-id', onto, made],
      'diff-tree',
    );
    return { ok: true, mergeCommit: made, changed: paths(diff).sort().slice(0, MAX_CHANGED) };
  };

  const checkoutConflicts = async (
    ref: MergeRepoRef,
    input: { base: string; changed: string[] },
  ): Promise<string[]> => {
    const repo = repoOf(ref);
    const base = await baseArg(input.base);
    if (input.changed.some((entry) => entry.includes('\0'))) invalid('Not a path');
    const checkout = await worktreeOf(repo, base);
    if (!checkout) return [];
    return overlappingPaths(await dirtyPaths(checkout), input.changed).slice(0, MAX_CONFLICTS);
  };

  /** The directories (relative, '' is the root) that hold a real `node_modules`, down to three levels. */
  const dependencyParents = async (root: string): Promise<string[]> => {
    const realDirectory = async (dir: string) => {
      const info = await lstat(dir).catch(() => null);
      return info !== null && info.isDirectory() && !info.isSymbolicLink();
    };
    const found: string[] = [];
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (await realDirectory(path.join(root, relative, 'node_modules'))) found.push(relative);
      if (depth >= MAX_NODE_MODULES_DEPTH) return;
      const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await walk(path.join(relative, entry.name), depth + 1);
      }
    };
    await walk('', 0);
    return found;
  };
  const copyTree = (source: string, dest: string, clone: boolean, timeoutMs: number): Promise<void> =>
    new Promise((resolve, reject) => {
      // `-P`: a link is copied as a link (the workspace links are relative and point into the new tree).
      const args = [...(clone ? ['-c'] : []), '-R', '-P', source, dest];
      execFile(
        'cp',
        args,
        { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeout: timeoutMs, windowsHide: true },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  const copyDependencies = async (from: string, target: string): Promise<void> => {
    const deadline = Date.now() + (options.copyTimeoutMs ?? DEPENDENCY_COPY_TIMEOUT_MS);
    for (const parent of await dependencyParents(from)) {
      const holder = path.join(target, parent);
      const holderInfo = await lstat(holder).catch(() => null);
      // The merged tree may not have that directory any more, or may track something of that name.
      if (!holderInfo || !holderInfo.isDirectory() || holderInfo.isSymbolicLink()) continue;
      const dest = path.join(holder, 'node_modules');
      if (await lstat(dest).catch(() => null)) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new MergeError('git_failed', 'copying the dependencies timed out');
      const source = path.join(from, parent, 'node_modules');
      if (platform === 'darwin') {
        try {
          await copyTree(source, dest, true, remaining);
        } catch {
          await rm(dest, { recursive: true, force: true });
          await copyTree(source, dest, false, Math.max(deadline - Date.now(), 1000));
        }
      } else await copyTree(source, dest, false, remaining);
      for (const cache of CACHE_DIRS) await rm(path.join(dest, cache), { recursive: true, force: true });
    }
  };

  const release = async (repo: string, target: string): Promise<void> => {
    const known = await lstat(target).catch(() => null);
    if (known?.isSymbolicLink() || (known && !known.isDirectory())) {
      await unlink(target);
    } else if (known) {
      await runGit(repo, ['worktree', 'remove', '--force', '--force', target]);
      await rm(target, { recursive: true, force: true });
    }
    await runGit(repo, ['worktree', 'prune']);
  };

  const checkoutForCheck = async (
    ref: MergeRepoRef,
    input: { mergeId: string; mergeCommit: string; depsFrom: string | null },
  ): Promise<{ path: string; gitDir: string }> => {
    const repo = repoOf(ref);
    if (!isMergeId(input.mergeId)) invalid('Not a merge id');
    const mergeCommit = commitArg(input.mergeCommit, 'The merge commit');
    if (input.depsFrom !== null && !path.isAbsolute(input.depsFrom))
      invalid('The dependencies path is not absolute');
    const root = await checkRoot();
    const target = path.join(root, input.mergeId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // A leftover of an earlier try with this id is made again from scratch.
    await release(repo, target);
    await must(repo, ['worktree', 'add', '--detach', target, mergeCommit], 'worktree add');
    try {
      if (input.depsFrom !== null) {
        const source = await realpath(input.depsFrom).catch(() => null);
        if (source === null) invalid('The dependencies path does not exist');
        else if (isWithin(await realpath(target), source) || isWithin(source, await realpath(target)))
          invalid('The dependencies path overlaps the check checkout');
        else await copyDependencies(source, await realpath(target));
      }
      const commonDir = (
        await must(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'rev-parse')
      ).trim();
      return { path: await realpath(target), gitDir: await realpath(commonDir) };
    } catch (error) {
      await release(repo, target).catch(() => {});
      throw error;
    }
  };

  const releaseCheck = async (ref: MergeRepoRef, input: { mergeId: string }): Promise<void> => {
    const repo = repoOf(ref);
    if (!isMergeId(input.mergeId)) invalid('Not a merge id');
    const root = await checkRoot();
    await release(repo, path.join(root, input.mergeId));
  };

  const push = async (
    ref: MergeRepoRef,
    input: { base: string; mergeCommit: string },
  ): Promise<MergePushResult> => {
    const repo = repoOf(ref);
    const base = await baseArg(input.base);
    const mergeCommit = commitArg(input.mergeCommit, 'The merge commit');
    const upstream = await upstreamOf(repo, base);
    if (!upstream) throw new MergeError('no_remote', `${base} has no upstream to push to`);
    await requireCommit(repo, mergeCommit, 'The merge commit');
    // No `+`, no `--force`: the remote refuses what is not a fast-forward.
    const pushed = await runGit(
      repo,
      [
        'push',
        '--no-verify',
        '--no-recurse-submodules',
        '--no-signed',
        '--',
        upstream.remote,
        `${mergeCommit}:refs/heads/${base}`,
      ],
      { timeoutMs: networkTimeout },
    );
    if (pushed.code === 0) return { ok: true };
    const output = `${pushed.stderr}\n${pushed.stdout}`;
    return {
      ok: false,
      reason: classifyPush(output, pushed.timedOut),
      message: outputTail(pushed.timedOut ? `${output}\nthe push timed out` : output),
    };
  };

  const advance = async (
    ref: MergeRepoRef,
    input: { base: string; from: string; to: string },
  ): Promise<MergeAdvanceResult> => {
    const repo = repoOf(ref);
    const base = await baseArg(input.base);
    const from = commitArg(input.from, 'The old commit');
    const to = commitArg(input.to, 'The new commit');
    await requireCommit(repo, from, 'The old commit');
    await requireCommit(repo, to, 'The new commit');
    if (!(await ancestor(repo, from, to))) invalid('The new commit is not a descendant of the old one');
    const moved = (current: string | null): MergeAdvanceResult => ({
      ok: false,
      reason: 'moved',
      message: `${base} is at ${current ?? 'nothing'}, not at ${from}`,
      paths: [],
    });
    const checkout = await worktreeOf(repo, base);
    if (!checkout) {
      const updated = await runGit(repo, [
        'update-ref',
        '-m',
        'projectman: merge',
        `refs/heads/${base}`,
        to,
        from,
      ]);
      if (updated.code === 0) return { ok: true };
      const current = await resolveCommit(repo, `refs/heads/${base}`);
      if (current !== from) return moved(current);
      throw new MergeError('git_failed', `update-ref failed: ${outputTail(updated.stderr, 500)}`);
    }
    const head = async () => (await resolveCommit(checkout, 'HEAD')) ?? null;
    const before = await head();
    if (before !== from) return moved(before);
    const merged = await runGit(checkout, [
      'merge',
      '--ff-only',
      '--quiet',
      '--no-autostash',
      '--no-verify-signatures',
      '--no-edit',
      to,
    ]);
    if (merged.code === 0) return { ok: true };
    const current = await head();
    if (current !== from) return moved(current);
    const changed = paths(
      await must(
        repo,
        ['diff-tree', '-r', '--name-only', '-z', '--no-renames', '--no-commit-id', from, to],
        'diff-tree',
      ),
    );
    const blocking = overlappingPaths(await dirtyPaths(checkout), changed).slice(0, MAX_CONFLICTS);
    if (blocking.length > 0)
      return {
        ok: false,
        reason: 'checkout_in_the_way',
        message: outputTail(merged.stderr || merged.stdout, 500),
        paths: blocking,
      };
    throw new MergeError(
      'git_failed',
      `merge --ff-only failed: ${outputTail(merged.stderr || merged.stdout, 500)}`,
    );
  };

  return { prepare, isAncestor, build, checkoutConflicts, checkoutForCheck, releaseCheck, push, advance };
}
