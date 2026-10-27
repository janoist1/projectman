import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isWithin } from '../kernel';
import { MergeError, type MergeRegeneratedResult } from '../contracts';
import { nulPaths, statusPaths } from './git-output';
import { isCommitId } from './merge-input';
import { must } from './merge-repo';

/**
 * Generated files that a conflicting merge makes again (PM-1050). `provisionalMerge` is the merge
 * result without the conflicting files; the generator runs in a check checkout of it; and
 * `commitRegeneratedFiles` takes only the files that match the patterns from that checkout into the
 * merge commit. What the sandboxed generator wrote reaches a pushed commit this way, so nothing but
 * plain, unlinked, small files under the patterns is taken, and never through the checkout's own index
 * or git filters. The indexes are files of their own in a temporary directory, like `doc-files.ts`.
 *
 * The generator's process may outlive its run (a detached descendant), so nothing in the checkout is
 * trusted twice: a file is read through one descriptor opened without following a link and checked on that
 * descriptor, the same path is checked again after the read, and only the bytes read are hashed. Git never
 * discovers the checkout by itself (its `.git` file is the generator's to leave alone but not to trust):
 * only `status` looks at the work tree, with the verified git directory named explicitly.
 */

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 200;
const MAX_CHANGED = 1000;
const MAX_REPORTED = 50;
const EMPTY_BLOB_MODE = '100644';

/** Pathspec of a pattern, in git's glob syntax; the environment's literal and glob switches do not change it. */
const globPathspec = (pattern: string): string => `:(glob)${pattern}`;
const PATHSPEC_ENV = { GIT_LITERAL_PATHSPECS: '0', GIT_NOGLOB_PATHSPECS: '0', GIT_GLOB_PATHSPECS: '0' };

async function withScratchIndex<T>(
  run: (env: Record<string, string>, scratch: string) => Promise<T>,
): Promise<T> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'projectman-index-'));
  try {
    return await run({ ...PATHSPEC_ENV, GIT_INDEX_FILE: path.join(scratch, 'index') }, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const hashed = async (cwd: string, args: readonly string[]): Promise<string> => {
  const id = (await must(cwd, args, 'hash-object')).trim();
  if (!isCommitId(id)) throw new MergeError('git_failed', 'hash-object gave no object');
  return id;
};

/**
 * The entries that match one of the patterns. Each is set to an empty file in the index of `env` first, so
 * a path the index lacks (deleted on one side, or not committed yet) is matched like one it has.
 */
async function matchedPaths(
  cwd: string,
  env: Record<string, string>,
  entries: readonly string[],
  patterns: readonly string[],
): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  const empty = await hashed(cwd, ['hash-object', '-w', '-t', 'blob', '--no-filters', '--', '/dev/null']);
  await must(cwd, ['update-index', '--add', '--replace', '-z', '--index-info'], 'update-index', {
    env,
    input: entries.map((entry) => `${EMPTY_BLOB_MODE} ${empty}\t${entry}\0`).join(''),
  });
  const listed = await must(cwd, ['ls-files', '-z', '--', ...patterns.map(globPathspec)], 'ls-files', {
    env,
  });
  return new Set(nulPaths(listed).filter((entry) => entries.includes(entry)));
}

/**
 * The commit of `tree` (the merge-tree result of a conflict) without the paths in `conflicts`, with the
 * parents `onto` and `commit`; undefined when a conflicting path matches none of `patterns`.
 */
export async function provisionalMerge(
  repo: string,
  input: {
    tree: string;
    conflicts: readonly string[];
    patterns: readonly string[];
    onto: string;
    commit: string;
    message: string;
    identity: Record<string, string>;
  },
): Promise<string | undefined> {
  return withScratchIndex(async (env) => {
    await must(repo, ['read-tree', input.tree], 'read-tree', { env });
    const matched = await matchedPaths(repo, env, input.conflicts, input.patterns);
    if (!input.conflicts.every((entry) => matched.has(entry))) return undefined;
    await must(repo, ['update-index', '--force-remove', '-z', '--stdin'], 'update-index', {
      env,
      input: input.conflicts.map((entry) => `${entry}\0`).join(''),
    });
    return writeCommit(repo, env, input);
  });
}

async function writeCommit(
  cwd: string,
  env: Record<string, string>,
  input: { onto: string; commit: string; message: string; identity: Record<string, string> },
): Promise<string> {
  const tree = (await must(cwd, ['write-tree'], 'write-tree', { env })).trim();
  if (!isCommitId(tree)) throw new MergeError('git_failed', 'write-tree gave no tree');
  const made = (
    await must(
      cwd,
      ['commit-tree', tree, '-p', input.onto, '-p', input.commit, '-m', input.message],
      'commit-tree',
      { env: input.identity },
    )
  ).trim();
  if (!isCommitId(made)) throw new MergeError('git_failed', 'commit-tree gave no commit');
  return made;
}

/**
 * The merge commit of the regenerated check checkout `checkout` (its HEAD: the provisional commit, parents
 * exactly `onto` and `commit`). Takes the files of `paths` and every other changed or new file that matches
 * `patterns`; a change outside the patterns, a path the generator did not write again and a file that is
 * not a plain unlinked small one are refused.
 */
export async function commitRegeneratedFiles(
  repo: string,
  checkout: string,
  input: {
    onto: string;
    commit: string;
    message: string;
    paths: readonly string[];
    patterns: readonly string[];
    identity: Record<string, string>;
  },
): Promise<MergeRegeneratedResult> {
  const known = await lstat(checkout).catch(() => null);
  if (!known?.isDirectory()) throw new MergeError('git_failed', 'The check checkout does not exist');
  const realCheckout = await realpath(checkout);
  const gitDir = await worktreeGitDir(repo, realCheckout);
  const discovery = { GIT_DIR: gitDir, GIT_WORK_TREE: realCheckout, GIT_OPTIONAL_LOCKS: '0' };
  const head = (
    await must(repo, ['rev-list', '--parents', '-n', '1', 'HEAD'], 'rev-list', { env: discovery })
  )
    .trim()
    .split(' ');
  if (head.length !== 3 || head[1] !== input.onto || head[2] !== input.commit)
    throw new MergeError('git_failed', 'The check checkout is not the provisional merge commit');
  const headId = head[0] ?? '';
  if (!isCommitId(headId)) throw new MergeError('git_failed', 'The check checkout has no commit');

  // The only git command that looks at the work tree; the rest runs in the repository, on what is read here.
  const status = await must(
    realCheckout,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    'status',
    { env: discovery },
  );
  const files = [...new Set([...statusPaths(status), ...input.paths])].sort();
  return withScratchIndex(async (env, scratch) => {
    const matched = await matchedPaths(repo, env, files, input.patterns);
    const outside = files.filter((entry) => !matched.has(entry) || !isTakenPath(entry));
    if (outside.length > 0) return { ok: false, reason: 'outside', paths: outside.slice(0, MAX_REPORTED) };

    const wanted = new Set(input.paths);
    const missing: string[] = [];
    const irregular: string[] = [];
    const removed: string[] = [];
    const taken: { path: string; mode: string; bytes: Buffer }[] = [];
    for (const entry of files) {
      const read = await readPlainFile(realCheckout, entry);
      if (read === 'missing') {
        // A file the generator deleted leaves the merge; a conflicting file it did not write is missing.
        if (wanted.has(entry)) missing.push(entry);
        else removed.push(entry);
      } else if (read === 'irregular' || taken.length >= MAX_FILES) irregular.push(entry);
      else taken.push({ path: entry, ...read });
    }
    if (missing.length > 0) return { ok: false, reason: 'missing', paths: missing.slice(0, MAX_REPORTED) };
    if (irregular.length > 0)
      return { ok: false, reason: 'not_regular', paths: irregular.slice(0, MAX_REPORTED) };

    await must(repo, ['read-tree', headId], 'read-tree', { env });
    if (removed.length > 0)
      await must(repo, ['update-index', '--force-remove', '-z', '--stdin'], 'update-index', {
        env,
        input: removed.map((entry) => `${entry}\0`).join(''),
      });
    let entries = '';
    const bytesFile = path.join(scratch, 'blob');
    for (const file of taken) {
      // The bytes that were read, through no filter: what the sandboxed run wrote is what is committed.
      await writeFile(bytesFile, file.bytes);
      const blob = await hashed(repo, ['hash-object', '-w', '-t', 'blob', '--no-filters', '--', bytesFile]);
      entries += `${file.mode} ${blob}\t${file.path}\0`;
    }
    if (entries.length > 0)
      await must(repo, ['update-index', '--add', '--replace', '-z', '--index-info'], 'update-index', {
        env,
        input: entries,
      });
    const made = await writeCommit(repo, env, input);
    const diff = await must(
      repo,
      ['diff-tree', '-r', '--name-only', '-z', '--no-renames', '--no-commit-id', input.onto, made],
      'diff-tree',
    );
    return { ok: true, mergeCommit: made, changed: nulPaths(diff).sort().slice(0, MAX_CHANGED) };
  });
}

/**
 * A path the merge commit may take from the checkout: git's own names (`.git*`: its hooks, attributes and
 * modules) and the hook directory of husky never come out of a generator, whatever the patterns say.
 */
function isTakenPath(entry: string): boolean {
  return entry.split('/').every((segment) => {
    const lower = segment.toLowerCase();
    return !lower.startsWith('.git') && lower !== '.husky';
  });
}

/**
 * The git directory of the worktree at `realCheckout`, found from the repository's side (the worktree's own
 * `.git` file is not read): the entry of `<common dir>/worktrees` whose `gitdir` file points into it.
 */
async function worktreeGitDir(repo: string, realCheckout: string): Promise<string> {
  const commonDir = await realpath(
    (await must(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'rev-parse')).trim(),
  );
  const root = path.join(commonDir, 'worktrees');
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = await realpath(path.join(root, name)).catch(() => null);
    if (dir === null || !isWithin(root, dir)) continue;
    const pointer = await readFile(path.join(dir, 'gitdir'), 'utf8').catch(() => null);
    if (pointer === null || path.basename(pointer.trim()) !== '.git') continue;
    if ((await realpath(path.dirname(pointer.trim())).catch(() => null)) === realCheckout) return dir;
  }
  throw new MergeError('git_failed', 'The check checkout is not a worktree of the repository');
}

/**
 * The bytes and mode of the plain, unlinked, small file `entry` of the checkout, or why it is not one:
 * `missing` (nothing there) or `irregular`. One descriptor opened without following a link is checked and
 * read; afterwards the path must still lead to that same file through real directories, so a link or a
 * directory swapped in and back while the file was read does not pass.
 */
async function readPlainFile(
  realCheckout: string,
  entry: string,
): Promise<'missing' | 'irregular' | { mode: string; bytes: Buffer }> {
  const full = path.join(realCheckout, entry);
  let handle;
  try {
    handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'irregular';
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) return 'irregular';
    const bytes = Buffer.alloc(info.size);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const again = await lstat(full).catch(() => null);
    const real = await realpath(full).catch(() => null);
    if (
      length !== info.size ||
      again === null ||
      !again.isFile() ||
      again.dev !== info.dev ||
      again.ino !== info.ino ||
      again.nlink !== 1 ||
      real !== full
    )
      return 'irregular';
    return { mode: info.mode & 0o111 ? '100755' : '100644', bytes };
  } finally {
    await handle.close();
  }
}
