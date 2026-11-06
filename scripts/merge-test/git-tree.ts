import { spawnSync } from 'node:child_process';
import type { MergeTestFile } from './impact';

/** Runs `git <args>` and returns its output; throws when git fails. */
export function runGit(args: string[]): string {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'git failed');
  return result.stdout;
}

/** The files of a revision under `roots` as immutable git blobs. */
export function readGitTree(
  revision: string,
  roots: readonly string[],
  git: (args: string[]) => string = runGit,
): MergeTestFile[] {
  const entries = git(['ls-tree', '-r', '-z', revision, '--', ...roots])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      return { oid: entry.slice(0, tab).split(' ')[2]!, path: entry.slice(tab + 1) };
    });
  const result = spawnSync('git', ['cat-file', '--batch'], {
    input: entries.map((entry) => entry.oid).join('\n') + '\n',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('git cat-file failed');
  let offset = 0;
  return entries.map(({ path }) => {
    const end = result.stdout.indexOf(10, offset);
    const header = result.stdout.subarray(offset, end).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (
      end < 0 ||
      header[1] !== 'blob' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      end + size + 1 >= result.stdout.length
    )
      throw new Error('invalid git blob response');
    const source = result.stdout.subarray(end + 1, end + 1 + size).toString('utf8');
    offset = end + size + 2;
    return { path, source };
  });
}
