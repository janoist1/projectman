import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isRegeneratedPath, regeneratedWriteDirs } from '@projectman/shared';
import { isWithin } from '../kernel';
import { MergeError, type MergeRegeneratedResult } from '../contracts';
import { nulPaths } from './git-output';
import { isCommitId } from './merge-input';
import { must } from './merge-repo';

/**
 * Generated files that a conflicting merge makes again (PM-1050). `provisionalMerge` is the merge
 * result without the conflicting files; the generator runs in a check checkout of it, and may write only
 * the literal directories of the patterns; and `commitRegeneratedFiles` takes only the files that match the
 * patterns from there into the merge commit. What the sandboxed generator wrote reaches a pushed commit this
 * way, so nothing but plain, unlinked, small files under the patterns is taken, and never through the
 * checkout's own index or git filters. The indexes are files of their own in a temporary directory, like
 * `doc-files.ts`.
 *
 * The generator's process may outlive its run (a detached descendant), and a link can be swapped in for a
 * file or a directory at any time, so nothing is read in place: the writable directories are first moved
 * (`rename`) below a fresh directory of the checkout, where the sandbox's path rules no longer allow a
 * write, and only that copy is walked, read through descriptors opened without following a link, and
 * hashed. Git never discovers the checkout: the worktree's git directory is found from the repository.
 */

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** The entries of the moved directories that are looked at; a generator's directory holds far fewer. */
const MAX_WALKED = 2000;
/** The files the merge commit may change. */
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

/** A file of the moved directories: its repository path, mode, and the copy of its bytes in the scratch directory. */
interface MovedFile {
  path: string;
  mode: string;
  copy: string;
}

interface MovedTree {
  files: MovedFile[];
  /** Entries that are not plain, unlinked, small files (or vanished while they were read). */
  irregular: string[];
  /** Entries with a name no merge may take (`isRegeneratedPath`). */
  guarded: string[];
  /** More entries or bytes than a generator's directories hold. */
  overflow: boolean;
}

/**
 * Reads the plain file `source` through one descriptor opened without following a link, checks it there
 * (a regular file, one link, under the size limit) and writes the bytes read to `copy`. Its mode, or null
 * when it is none of that.
 */
async function copyPlainFile(source: string, copy: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) return null;
    const bytes = Buffer.alloc(info.size);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== info.size) return null;
    await writeFile(copy, bytes);
    return info.mode & 0o111 ? '100755' : '100644';
  } finally {
    await handle.close();
  }
}

/** Walks the moved directories `roots` (`dir`: where they were in the checkout, `moved`: where they are now). */
async function walkMoved(
  roots: readonly { dir: string; moved: string }[],
  scratch: string,
): Promise<MovedTree> {
  const tree: MovedTree = { files: [], irregular: [], guarded: [], overflow: false };
  await mkdir(path.join(scratch, 'blobs'));
  let entries = 0;
  let bytes = 0;
  const visit = async (abs: string, rel: string): Promise<void> => {
    entries += 1;
    if (entries > MAX_WALKED) tree.overflow = true;
    if (tree.overflow) return;
    const info = await lstat(abs).catch(() => null);
    if (info === null) {
      tree.irregular.push(rel);
    } else if (!isRegeneratedPath(rel)) {
      tree.guarded.push(rel);
    } else if (info.isDirectory()) {
      for (const name of await readdir(abs)) await visit(path.join(abs, name), `${rel}/${name}`);
    } else if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) {
      tree.irregular.push(rel);
    } else {
      bytes += info.size;
      if (bytes > MAX_TOTAL_BYTES) tree.overflow = true;
      else {
        const copy = path.join(scratch, 'blobs', String(tree.files.length));
        const mode = await copyPlainFile(abs, copy);
        if (mode === null) tree.irregular.push(rel);
        else tree.files.push({ path: rel, mode, copy });
      }
    }
  };
  for (const { dir, moved } of roots) {
    const info = await lstat(moved).catch(() => null);
    if (info?.isDirectory()) await visit(moved, dir);
    else tree.irregular.push(dir);
  }
  return tree;
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

/** The blobs of `dirs` in `commitId`: path to mode and object id. */
async function treeBlobs(
  repo: string,
  commitId: string,
  dirs: readonly string[],
): Promise<Map<string, { mode: string; id: string }>> {
  const listed = await must(repo, ['ls-tree', '-r', '-z', commitId, '--', ...dirs], 'ls-tree', {
    env: { GIT_LITERAL_PATHSPECS: '1' },
  });
  const blobs = new Map<string, { mode: string; id: string }>();
  for (const record of nulPaths(listed)) {
    const tab = record.indexOf('\t');
    const [mode, type, id] = record.slice(0, tab).split(' ');
    if (tab > 0 && type === 'blob' && mode && id) blobs.set(record.slice(tab + 1), { mode, id });
  }
  return blobs;
}

/**
 * The merge commit of the regenerated check checkout `checkout` (its HEAD: the provisional commit, parents
 * exactly `onto` and `commit`), made from the directories the run could write (`regeneratedWriteDirs` of
 * `patterns`). Takes the files of `paths` and every other changed, new or deleted file that matches
 * `patterns`; a change outside the patterns, a path the generator did not write again, a file that is not a
 * plain unlinked small one and a flood of changes are refused.
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
  const head = (
    await must(repo, ['rev-list', '--parents', '-n', '1', 'HEAD'], 'rev-list', {
      env: { GIT_DIR: gitDir },
    })
  )
    .trim()
    .split(' ');
  if (head.length !== 3 || head[1] !== input.onto || head[2] !== input.commit)
    throw new MergeError('git_failed', 'The check checkout is not the provisional merge commit');
  const headId = head[0] ?? '';
  if (!isCommitId(headId)) throw new MergeError('git_failed', 'The check checkout has no commit');
  const dirs = regeneratedWriteDirs(input.patterns);
  if (dirs === null || dirs.length === 0) throw new MergeError('git_failed', 'Not a set of patterns');

  const stash = await mkdtemp(path.join(realCheckout, '.pm-regenerated-'));
  try {
    // The writable directories leave their place first; a link in place of one moves as the link it is.
    const roots: { dir: string; moved: string }[] = [];
    const displaced: string[] = [];
    for (const [index, dir] of dirs.entries()) {
      const source = path.join(realCheckout, dir);
      if ((await lstat(source).catch(() => null)) === null) continue;
      if ((await realpath(path.dirname(source)).catch(() => null)) !== path.dirname(source)) {
        displaced.push(dir);
        continue;
      }
      const moved = path.join(stash, String(index));
      await rename(source, moved);
      roots.push({ dir, moved });
    }
    return await withScratchIndex(async (env, scratch) => {
      const walked = await walkMoved(roots, scratch);
      const notRegular = [...walked.irregular, ...displaced];
      if (walked.overflow) return { ok: false, reason: 'too_many', paths: [] };
      if (walked.guarded.length > 0)
        return { ok: false, reason: 'outside', paths: walked.guarded.slice(0, MAX_REPORTED) };
      if (notRegular.length > 0)
        return { ok: false, reason: 'not_regular', paths: notRegular.slice(0, MAX_REPORTED) };

      const ids = walked.files.length
        ? (
            await must(
              repo,
              ['hash-object', '-w', '-t', 'blob', '--no-filters', '--stdin-paths'],
              'hash-object',
              { input: `${walked.files.map((file) => file.copy).join('\n')}\n` },
            )
          )
            .trim()
            .split('\n')
        : [];
      if (ids.length !== walked.files.length || !ids.every(isCommitId))
        throw new MergeError('git_failed', 'hash-object gave no objects');
      const found = new Map(walked.files.map((file, index) => [file.path, { ...file, id: ids[index]! }]));
      const before = await treeBlobs(repo, headId, dirs);
      const changed = [...found.values()].filter((file) => {
        const was = before.get(file.path);
        return was?.id !== file.id || was.mode !== file.mode;
      });
      const removed = [...before.keys()].filter((entry) => !found.has(entry));
      const missing = input.paths.filter((entry) => !found.has(entry));
      const touched = [...new Set([...changed.map((file) => file.path), ...removed])].sort();
      if (touched.length > MAX_FILES) return { ok: false, reason: 'too_many', paths: [] };
      const matched = await matchedPaths(repo, env, touched, input.patterns);
      const outside = touched.filter((entry) => !matched.has(entry));
      if (outside.length > 0) return { ok: false, reason: 'outside', paths: outside.slice(0, MAX_REPORTED) };
      if (missing.length > 0) return { ok: false, reason: 'missing', paths: missing.slice(0, MAX_REPORTED) };

      await must(repo, ['read-tree', headId], 'read-tree', { env });
      if (removed.length > 0)
        await must(repo, ['update-index', '--force-remove', '-z', '--stdin'], 'update-index', {
          env,
          input: removed.map((entry) => `${entry}\0`).join(''),
        });
      if (changed.length > 0)
        await must(repo, ['update-index', '--add', '--replace', '-z', '--index-info'], 'update-index', {
          env,
          input: changed.map((file) => `${file.mode} ${file.id}\t${file.path}\0`).join(''),
        });
      const made = await writeCommit(repo, env, input);
      const diff = await must(
        repo,
        ['diff-tree', '-r', '--name-only', '-z', '--no-renames', '--no-commit-id', input.onto, made],
        'diff-tree',
      );
      return { ok: true, mergeCommit: made, changed: nulPaths(diff).sort().slice(0, MAX_CHANGED) };
    });
  } finally {
    await rm(stash, { recursive: true, force: true }).catch(() => {});
  }
}
