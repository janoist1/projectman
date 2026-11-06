import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MergeError, type BranchMerger, type MergeRepoRef } from '../contracts';
import { nulPaths } from './git-output';
import { outputTail, runGitBytes } from './merge-git';
import {
  DOC_FILE_MAX_BYTES,
  invalidInput,
  isCommitFileSet,
  isCommitId,
  isMergeMessage,
  isRepoFilePath,
  type MergeArgs,
} from './merge-input';
import { fetchUpstream, identityOf, must, requireCommit, treeEntry, upstreamOf } from './merge-repo';

/** Reading a document file of a repository and committing it again (PM-494), without touching its checkout. */

interface DocFileOptions {
  args: MergeArgs;
  /** The time limit of a fetch (the engine's network git timeout). */
  networkTimeoutMs: number;
}

export function createDocFiles(options: DocFileOptions): Pick<BranchMerger, 'readFile' | 'commitFiles'> {
  const { args, networkTimeoutMs } = options;

  const readFile = async (
    ref: MergeRepoRef,
    input: { at: { commit: string } | { base: string }; path: string },
  ): Promise<{ commit: string; text: string | null }> => {
    const repo = args.repo(ref);
    if (!isRepoFilePath(input.path)) invalidInput('Not a path inside the repository');
    let commit: string;
    if ('commit' in input.at) {
      commit = await requireCommit(repo, args.commit(input.at.commit, 'The commit'), 'The commit');
    } else {
      const base = await args.base(input.at.base);
      const upstream = await upstreamOf(repo, base);
      if (upstream) {
        await fetchUpstream(repo, upstream, networkTimeoutMs);
        commit = await requireCommit(repo, upstream.ref, 'The upstream');
      } else commit = await requireCommit(repo, `refs/heads/${base}`, 'The base');
    }
    const entry = await treeEntry(repo, commit, input.path);
    if (!entry) return { commit, text: null };
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755'))
      return invalidInput(`${input.path} is not a regular file`);
    const size = Number((await must(repo, ['cat-file', '-s', entry.object], 'cat-file')).trim());
    if (!Number.isFinite(size) || size > DOC_FILE_MAX_BYTES)
      return invalidInput(`${input.path} is over 1 MiB`);
    const blob = await runGitBytes(repo, ['cat-file', 'blob', entry.object]);
    if (blob.code !== 0)
      throw new MergeError('git_failed', `cat-file failed: ${outputTail(blob.stderr, 500)}`);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(blob.stdout);
    } catch {
      return invalidInput(`${input.path} is not UTF-8 text`);
    }
    if (text.includes('\0')) return invalidInput(`${input.path} is not text`);
    return { commit, text };
  };

  const commitFiles = async (
    ref: MergeRepoRef,
    input: { onto: string; files: { path: string; text: string }[]; message: string },
  ): Promise<{ commit: string; changed: string[] }> => {
    const repo = args.repo(ref);
    const onto = args.commit(input.onto, 'The base commit');
    if (!isMergeMessage(input.message) || input.message.trim().length === 0)
      invalidInput('Not a commit message');
    if (!isCommitFileSet(input.files))
      invalidInput('Not a set of 1 to 2 different project documents, each text under 1 MiB');
    await requireCommit(repo, onto, 'The base commit');
    const identity = await identityOf(repo);
    // The index is a file of its own in a temporary directory: the repository's index, refs and working tree stay as they are.
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'projectman-index-'));
    try {
      const indexEnv = { GIT_INDEX_FILE: path.join(scratch, 'index') };
      await must(repo, ['read-tree', onto], 'read-tree', { env: indexEnv });
      let entries = '';
      for (const file of input.files) {
        const existing = await treeEntry(repo, onto, file.path);
        if (
          existing &&
          (existing.type !== 'blob' || (existing.mode !== '100644' && existing.mode !== '100755'))
        )
          invalidInput(`${file.path} is not a regular file`);
        // A file where onto has the directory's place would silently remove that file.
        for (let at = file.path.indexOf('/'); at !== -1; at = file.path.indexOf('/', at + 1)) {
          const parent = await treeEntry(repo, onto, file.path.slice(0, at));
          if (parent && parent.type !== 'tree')
            invalidInput(`${file.path.slice(0, at)} is a file, not a directory`);
        }
        const blob = (
          await must(repo, ['hash-object', '-w', '-t', 'blob', '--no-filters', '--stdin'], 'hash-object', {
            input: file.text,
          })
        ).trim();
        if (!isCommitId(blob)) throw new MergeError('git_failed', 'hash-object gave no object');
        entries += `${existing?.mode ?? '100644'} ${blob}\t${file.path}\0`;
      }
      await must(repo, ['update-index', '-z', '--index-info'], 'update-index', {
        env: indexEnv,
        input: entries,
      });
      const tree = (await must(repo, ['write-tree'], 'write-tree', { env: indexEnv })).trim();
      if (!isCommitId(tree)) throw new MergeError('git_failed', 'write-tree gave no tree');
      const made = (
        await must(repo, ['commit-tree', tree, '-p', onto, '-m', input.message], 'commit-tree', {
          env: identity,
        })
      ).trim();
      if (!isCommitId(made)) throw new MergeError('git_failed', 'commit-tree gave no commit');
      const diff = await must(
        repo,
        ['diff-tree', '-r', '--name-only', '-z', '--no-renames', '--no-commit-id', onto, made],
        'diff-tree',
      );
      return { commit: made, changed: nulPaths(diff).sort() };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };

  return { readFile, commitFiles };
}
