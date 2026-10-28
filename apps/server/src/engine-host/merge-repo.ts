import { MergeError } from '../contracts';
import { nulPaths, parseWorktrees, statusPaths, type WorktreeEntry } from './git-output';
import { outputTail, runGit, type GitRunOptions } from './merge-git';

/** Git queries on one repository of the merger (PM-451), all through `runGit` (`merge-git.ts`). */

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export interface Upstream {
  /** The remote-tracking ref (`refs/remotes/origin/main`). */
  ref: string;
  remote: string;
  /** The branch on the remote (`refs/heads/main`). */
  remoteRef: string;
}

export async function must(
  repo: string,
  args: readonly string[],
  what: string,
  opts?: GitRunOptions,
): Promise<string> {
  const result = await runGit(repo, args, opts);
  if (result.code !== 0)
    throw new MergeError('git_failed', `${what} failed: ${outputTail(result.stderr || result.stdout, 500)}`);
  return result.stdout;
}

/** The commit an object name points at, or null when there is none. */
export async function resolveCommit(repo: string, name: string): Promise<string | null> {
  const result = await runGit(repo, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function requireCommit(repo: string, name: string, what: string): Promise<string> {
  const commit = await resolveCommit(repo, name);
  if (!commit) throw new MergeError('unknown_object', `${what} is not known in this repository`);
  return commit;
}

export async function isAncestorCommit(repo: string, older: string, newer: string): Promise<boolean> {
  const result = await runGit(repo, ['merge-base', '--is-ancestor', older, newer]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new MergeError('git_failed', `merge-base failed: ${outputTail(result.stderr, 500)}`);
}

export async function upstreamOf(repo: string, base: string): Promise<Upstream | null> {
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
    // The fetch reads the upstream's branch and the push writes `refs/heads/<base>`: they must be one.
    if (remoteRef !== `refs/heads/${base}`)
      throw new MergeError('no_remote', `${base} tracks a remote branch of another name (${remoteRef})`);
    return { ref, remote, remoteRef };
  }
  return null;
}

const fetches = new Map<string, Promise<void>>();

/** Every fetch of one registered repository shares a queue, including document reads and merges. */
export async function fetchUpstream(repo: string, upstream: Upstream, timeoutMs: number): Promise<void> {
  const previous = fetches.get(repo) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => fetchOne(repo, upstream, timeoutMs));
  fetches.set(repo, next);
  try {
    await next;
  } finally {
    if (fetches.get(repo) === next) fetches.delete(repo);
  }
}

async function fetchOne(repo: string, upstream: Upstream, timeoutMs: number): Promise<void> {
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
    { timeoutMs },
  );
  if (fetched.code !== 0)
    throw new MergeError(
      'git_failed',
      `fetch failed${fetched.timedOut ? ' (timed out)' : ''}: ${outputTail(fetched.stderr || fetched.stdout, 500)}`,
    );
}

/** The machine's git identity as the environment of a commit; `no_identity` when the repository has none. */
export async function identityOf(repo: string): Promise<Record<string, string>> {
  const name = (await runGit(repo, ['config', '--get', 'user.name'])).stdout.trim();
  const email = (await runGit(repo, ['config', '--get', 'user.email'])).stdout.trim();
  if (!name || !email)
    throw new MergeError(
      'no_identity',
      'The repository has no committer identity: set user.name and user.email in its git configuration',
    );
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/** The worktrees of a repository, as `git worktree list` reports them. */
export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  return parseWorktrees(
    await must(repo, ['worktree', 'list', '--porcelain'], 'worktree list', {
      env: { GIT_OPTIONAL_LOCKS: '0' },
    }),
  );
}

export async function worktreeOf(repo: string, base: string): Promise<string | null> {
  const worktrees = await listWorktrees(repo);
  return worktrees.find((item) => item.branch === `refs/heads/${base}` && !item.prunable)?.path ?? null;
}

export async function dirtyPaths(checkout: string): Promise<string[]> {
  const out = await must(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'status', {
    env: { GIT_OPTIONAL_LOCKS: '0' },
  });
  return statusPaths(out);
}

/** The tree entry of `file` at `commit`; null when there is none. */
export async function treeEntry(
  repo: string,
  commit: string,
  file: string,
): Promise<{ mode: string; type: string; object: string } | null> {
  const out = await must(repo, ['ls-tree', '-z', '--full-tree', commit, '--', file], 'ls-tree');
  for (const entry of nulPaths(out)) {
    const tab = entry.indexOf('\t');
    if (tab === -1 || entry.slice(tab + 1) !== file) continue;
    const [mode, type, object] = entry.slice(0, tab).split(' ');
    if (mode && type && object) return { mode, type, object };
  }
  return null;
}
