import {
  MergeError,
  type BranchMerger,
  type MergeAdvanceResult,
  type MergeBaseState,
  type MergeBuildResult,
  type MergePushResult,
  type MergeRepoRef,
} from '../contracts';
import { createDocFiles } from './doc-files';
import { classifyPush, nulPaths, overlappingPaths } from './git-output';
import { createMergeChecks } from './merge-check';
import { NETWORK_GIT_TIMEOUT_MS, outputTail, runGit } from './merge-git';
import { invalidInput, isCommitId, isMergeMessage, mergeArgs } from './merge-input';
import { createPathReads } from './path-reads';
import { createReleaseTags } from './release-tags';
import {
  dirtyPaths,
  fetchUpstream,
  identityOf,
  isAncestorCommit,
  must,
  requireCommit,
  resolveCommit,
  upstreamOf,
  worktreeOf,
} from './merge-repo';

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
  /** Test only: a smaller `listPaths` cap (default MAX_LISTED_PATHS). */
  maxListedPaths?: number;
  /** Test only: a smaller per item `changedPaths` cap (default MAX_CHANGED_PATHS). */
  maxChangedPaths?: number;
}

const MAX_CHANGED = 1000;
const MAX_CONFLICTS = 50;

export function createLocalBranchMerger(options: LocalBranchMergerOptions): BranchMerger {
  const platform = options.platform ?? process.platform;
  const networkTimeout = options.networkTimeoutMs ?? NETWORK_GIT_TIMEOUT_MS;
  const args = mergeArgs(options.repoPath);

  const prepare = async (
    ref: MergeRepoRef,
    input: { base: string; commit: string },
  ): Promise<MergeBaseState> => {
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    const commit = args.commit(input.commit, 'The commit');
    await requireCommit(repo, commit, 'The commit');
    const upstream = await upstreamOf(repo, base);
    if (upstream) await fetchUpstream(repo, upstream, networkTimeout);
    const local = await requireCommit(repo, `refs/heads/${base}`, 'The base');
    const containsLocal = await isAncestorCommit(repo, commit, local);
    let remote: MergeBaseState['remote'] = null;
    let relation: MergeBaseState['relation'] = 'same';
    let containsRemote: boolean | null = null;
    if (upstream) {
      const remoteCommit = await requireCommit(repo, upstream.ref, 'The upstream');
      remote = { name: upstream.remote, commit: remoteCommit };
      if (remoteCommit !== local) {
        if (await isAncestorCommit(repo, local, remoteCommit)) relation = 'local_behind';
        else if (await isAncestorCommit(repo, remoteCommit, local)) relation = 'local_ahead';
        else relation = 'diverged';
      }
      containsRemote = await isAncestorCommit(repo, commit, remoteCommit);
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
    const repo = args.repo(ref);
    const older = args.commit(input.ancestor, 'The ancestor');
    const newer = args.commit(input.commit, 'The commit');
    if (!(await resolveCommit(repo, older)) || !(await resolveCommit(repo, newer))) return null;
    return isAncestorCommit(repo, older, newer);
  };

  const build = async (
    ref: MergeRepoRef,
    input: { onto: string; commit: string; message: string },
  ): Promise<MergeBuildResult> => {
    const repo = args.repo(ref);
    const onto = args.commit(input.onto, 'The base commit');
    const commit = args.commit(input.commit, 'The commit');
    if (!isMergeMessage(input.message) || input.message.trim().length === 0)
      invalidInput('Not a commit message');
    await requireCommit(repo, onto, 'The base commit');
    await requireCommit(repo, commit, 'The commit');
    // The identity first: a repository without one is told so before any work is done.
    const identity = await identityOf(repo);
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
    return { ok: true, mergeCommit: made, changed: nulPaths(diff).sort().slice(0, MAX_CHANGED) };
  };

  const checkoutConflicts = async (
    ref: MergeRepoRef,
    input: { base: string; changed: string[] },
  ): Promise<string[]> => {
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    if (input.changed.some((entry) => entry.includes('\0'))) invalidInput('Not a path');
    const checkout = await worktreeOf(repo, base);
    if (!checkout) return [];
    return overlappingPaths(await dirtyPaths(checkout), input.changed).slice(0, MAX_CONFLICTS);
  };

  const push = async (
    ref: MergeRepoRef,
    input: { base: string; mergeCommit: string },
  ): Promise<MergePushResult> => {
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    const mergeCommit = args.commit(input.mergeCommit, 'The merge commit');
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
        '--no-follow-tags',
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
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    const from = args.commit(input.from, 'The old commit');
    const to = args.commit(input.to, 'The new commit');
    await requireCommit(repo, from, 'The old commit');
    await requireCommit(repo, to, 'The new commit');
    if (!(await isAncestorCommit(repo, from, to)))
      invalidInput('The new commit is not a descendant of the old one');
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
    const changed = nulPaths(
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

  return {
    prepare,
    isAncestor,
    build,
    checkoutConflicts,
    push,
    advance,
    ...createMergeChecks({
      args,
      worktreesRoot: options.worktreesRoot,
      platform,
      ...(options.copyTimeoutMs !== undefined ? { copyTimeoutMs: options.copyTimeoutMs } : {}),
    }),
    ...createDocFiles({ args, networkTimeoutMs: networkTimeout }),
    ...createReleaseTags({ args, networkTimeoutMs: networkTimeout }),
    ...createPathReads({
      args,
      ...(options.maxListedPaths !== undefined ? { maxListedPaths: options.maxListedPaths } : {}),
      ...(options.maxChangedPaths !== undefined ? { maxChangedPaths: options.maxChangedPaths } : {}),
    }),
  };
}
