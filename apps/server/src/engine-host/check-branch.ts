import { MergeError, type CheckBranchGit, type MergePushResult } from '../contracts';
import { classifyPush } from './git-output';
import { NETWORK_GIT_TIMEOUT_MS, outputTail, runGit } from './merge-git';
import { invalidInput, mergeArgs } from './merge-input';
import { requireCommit, upstreamOf, type Upstream } from './merge-repo';

/**
 * The check branches of the GitHub Actions merge check (PM-900): the merge commit is pushed to a branch
 * of the base's upstream remote, and the workflow runs on it. Every git call goes through `runGit`
 * (`merge-git.ts`): no hooks, no signing, no prompt, no shell. The push uses the machine's own git login
 * and is never forced; only branches named `pm-check/<time>/<id>` are written, deleted or listed.
 */

export interface CheckBranchGitOptions {
  /** A repository's path on this engine, from its own binding; null: not bound here. */
  repoPath: (projectKey: string, repo: string) => string | null;
  /** The time limit of one push, delete or listing (default 120 s). */
  networkTimeoutMs?: number;
}

/** The only prefix `list` accepts. */
const PREFIX = 'pm-check/';
const BRANCH = /^pm-check\/[0-9a-z]{1,12}\/[A-Za-z0-9_-]{1,64}$/;
/** The most branches `list` returns. */
const MAX_LISTED = 100;
const OWNER_AND_NAME = '([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)';
const GITHUB_URLS = [
  new RegExp(`^git@github\\.com:${OWNER_AND_NAME}(?:\\.git)?$`),
  new RegExp(`^ssh://git@github\\.com/${OWNER_AND_NAME}(?:\\.git)?$`),
  new RegExp(`^https://github\\.com/${OWNER_AND_NAME}(?:\\.git)?$`),
];
const PUSH_SAFETY = ['push', '--no-verify', '--no-recurse-submodules', '--no-follow-tags', '--no-signed'];

/** "owner/name" of a github.com remote URL (ssh or https); null for any other. */
export function githubRepoOfUrl(url: string): string | null {
  const trimmed = url.trim();
  for (const pattern of GITHUB_URLS) {
    const found = pattern.exec(trimmed);
    if (found) return `${found[1]}/${found[2]}`;
  }
  return null;
}

export function createCheckBranchGit(options: CheckBranchGitOptions): CheckBranchGit {
  const args = mergeArgs(options.repoPath);
  const networkTimeout = options.networkTimeoutMs ?? NETWORK_GIT_TIMEOUT_MS;

  const branchOf = (value: string): string => {
    if (!BRANCH.test(value)) invalidInput('Not a check branch name');
    return value;
  };

  /** The base's upstream remote; `no_remote` when it has none. */
  const remoteOf = async (repo: string, base: string): Promise<Upstream> => {
    const upstream = await upstreamOf(repo, base);
    if (!upstream) throw new MergeError('no_remote', `${base} has no upstream to push to`);
    return upstream;
  };

  const upstreamRepo: CheckBranchGit['upstreamRepo'] = async (ref, input) => {
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    const upstream = await upstreamOf(repo, base);
    if (!upstream) return null;
    // The push URL: that is where the branch goes.
    const url = await runGit(repo, ['remote', 'get-url', '--push', '--', upstream.remote]);
    return url.code === 0 ? githubRepoOfUrl(url.stdout) : null;
  };

  const push: CheckBranchGit['push'] = async (ref, input) => {
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    const commit = args.commit(input.commit, 'The commit');
    const branch = branchOf(input.branch);
    const upstream = await remoteOf(repo, base);
    await requireCommit(repo, commit, 'The commit');
    // No `+`, no `--force`: a name that exists already is refused unless it is a fast-forward.
    const pushed = await runGit(
      repo,
      [...PUSH_SAFETY, '--', upstream.remote, `${commit}:refs/heads/${branch}`],
      { timeoutMs: networkTimeout },
    );
    if (pushed.code === 0) return { ok: true } satisfies MergePushResult;
    const output = `${pushed.stderr}\n${pushed.stdout}`;
    return {
      ok: false,
      reason: classifyPush(output, pushed.timedOut),
      message: outputTail(pushed.timedOut ? `${output}\nthe push timed out` : output),
    };
  };

  const remove: CheckBranchGit['remove'] = async (ref, input) => {
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    const branch = branchOf(input.branch);
    const upstream = await remoteOf(repo, base);
    const deleted = await runGit(
      repo,
      [...PUSH_SAFETY, '--delete', '--', upstream.remote, `refs/heads/${branch}`],
      { timeoutMs: networkTimeout },
    );
    if (deleted.code === 0) return;
    const output = `${deleted.stderr}\n${deleted.stdout}`;
    if (/remote ref does not exist/i.test(output)) return;
    throw new MergeError(
      'git_failed',
      `deleting the check branch failed${deleted.timedOut ? ' (timed out)' : ''}: ${outputTail(output, 500)}`,
    );
  };

  const list: CheckBranchGit['list'] = async (ref, input) => {
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    if (input.prefix !== PREFIX) invalidInput('Not the check branch prefix');
    const upstream = await remoteOf(repo, base);
    const listed = await runGit(
      repo,
      ['ls-remote', '--heads', '--refs', '--', upstream.remote, `refs/heads/${PREFIX}*`],
      { timeoutMs: networkTimeout },
    );
    if (listed.code !== 0)
      throw new MergeError(
        'git_failed',
        `listing the check branches failed${listed.timedOut ? ' (timed out)' : ''}: ${outputTail(listed.stderr || listed.stdout, 500)}`,
      );
    const names: string[] = [];
    for (const line of listed.stdout.split('\n')) {
      const name = /^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/.exec(line)?.[1];
      if (name && BRANCH.test(name)) names.push(name);
      if (names.length >= MAX_LISTED) break;
    }
    return names;
  };

  return { upstreamRepo, push, remove, list };
}
