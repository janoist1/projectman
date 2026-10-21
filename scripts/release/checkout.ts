import fs from 'node:fs';
import type { CloudContext } from '../cloud/context';
import { CloudError, refused } from '../cloud/errors';

/** Git never asks anything on a terminal while a release is prepared: a missing credential is a failure. */
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

export async function git(
  context: CloudContext,
  directory: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const result = await context.deps.run('git', ['-C', directory, ...args], { env: GIT_ENV, signal });
  if (signal.aborted || result.code === 130) throw new CloudError('the preparation was interrupted');
  if (result.code !== 0) throw new CloudError(`git ${args[0]} failed (status ${result.code})`);
  return result.stdout;
}

/** HEAD is the commit and the checkout holds nothing else (ignored build output aside). */
export async function assertCleanAt(
  context: CloudContext,
  directory: string,
  commit: string,
  signal: AbortSignal,
  label: string,
): Promise<void> {
  if ((await git(context, directory, ['rev-parse', 'HEAD'], signal)).trim() !== commit)
    throw refused(`${label} is not at the release commit`);
  if ((await git(context, directory, ['status', '--porcelain', '--untracked-files=all'], signal)).trim())
    throw refused(`${label} is dirty`);
}

/**
 * A fresh, private, detached checkout of one exact commit of the configured remote. Nothing is reused or
 * overwritten: the directory must not exist. The full object id is checked after the fetch, so neither a moved
 * branch nor a short or ambiguous name can pick another commit.
 */
export async function checkoutExactCommit(
  context: CloudContext,
  directory: string,
  commit: string,
  signal: AbortSignal,
): Promise<void> {
  const url = context.config.repository.url;
  if (!URL.canParse(url) || new URL(url).protocol !== 'https:')
    throw refused('the configured repository is not an https remote');
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch {
    throw refused('a checkout directory already exists or its parent is missing');
  }
  await git(context, directory, ['init', '--quiet'], signal);
  await git(context, directory, ['remote', 'add', 'origin', url], signal);
  await git(context, directory, ['fetch', '--quiet', '--no-tags', '--depth', '1', 'origin', commit], signal);
  if (
    (await git(context, directory, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], signal)).trim() !==
    commit
  )
    throw refused('the fetched object is not the release commit');
  await git(
    context,
    directory,
    ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', commit],
    signal,
  );
  await assertCleanAt(context, directory, commit, signal, 'the fresh checkout');
}
