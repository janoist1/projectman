import { isReleaseTagName } from '@projectman/shared';
import { MergeError, type BranchMerger, type MergePushResult } from '../contracts';
import { classifyPush } from './git-output';
import { outputTail, runGit } from './merge-git';
import { invalidInput, type MergeArgs } from './merge-input';
import { identityOf, requireCommit, upstreamOf, type Upstream } from './merge-repo';

/**
 * The tags of a release (`publish_release`, PM-968): listed on the base's upstream remote and made and pushed
 * from a commit of the repository. Every git call goes through `runGit` (`merge-git.ts`): no hooks, no signing,
 * no prompt, no shell. The push uses the machine's own git login and is never forced: a tag that exists on the
 * remote is never moved.
 */

interface ReleaseTagOptions {
  args: MergeArgs;
  /** The time limit of a listing or a push (the engine's network git timeout). */
  networkTimeoutMs: number;
}

/** The most tags `remoteTags` returns. */
const MAX_TAGS = 5000;

export function createReleaseTags(options: ReleaseTagOptions): Pick<BranchMerger, 'remoteTags' | 'pushTag'> {
  const { args, networkTimeoutMs } = options;

  const remoteOf = async (repo: string, base: string): Promise<Upstream> => {
    const upstream = await upstreamOf(repo, base);
    if (!upstream) throw new MergeError('no_remote', `${base} has no upstream to push to`);
    return upstream;
  };

  /** The tag name: the pure rule, then git's own (`check-ref-format`). */
  const tagName = async (repo: string, value: string): Promise<string> => {
    if (!isReleaseTagName(value)) invalidInput('Not a release tag name');
    const checked = await runGit(repo, ['check-ref-format', `refs/tags/${value}`]);
    if (checked.code !== 0) invalidInput('Not a release tag name');
    return value;
  };

  const remoteTags: BranchMerger['remoteTags'] = async (ref, input) => {
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    const upstream = await remoteOf(repo, base);
    const listed = await runGit(repo, ['ls-remote', '--tags', '--', upstream.remote], {
      timeoutMs: networkTimeoutMs,
    });
    if (listed.code !== 0)
      throw new MergeError(
        'git_failed',
        `listing the tags failed${listed.timedOut ? ' (timed out)' : ''}: ${outputTail(listed.stderr || listed.stdout, 500)}`,
      );
    const tags = new Map<string, string>();
    for (const line of listed.stdout.split('\n')) {
      const found = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
      if (!found) continue;
      const [, commit, name, peeled] = found;
      // The peeled line is the commit of an annotated tag; it follows the tag object's own line.
      if (peeled || !tags.has(name!)) tags.set(name!, commit!);
    }
    return [...tags].slice(0, MAX_TAGS).map(([name, commit]) => ({ name, commit }));
  };

  const pushTag: BranchMerger['pushTag'] = async (ref, input) => {
    const repo = args.repo(ref);
    const base = await args.base(input.base);
    const tag = await tagName(repo, input.tag);
    const commit = args.commit(input.commit, 'The commit');
    const upstream = await remoteOf(repo, base);
    await requireCommit(repo, commit, 'The commit');
    const identity = await identityOf(repo);
    // An older local tag of the name (an earlier attempt) is replaced; the remote decides about its own.
    await runGit(repo, ['tag', '-d', '--', tag]);
    const made = await runGit(repo, ['tag', '-a', '--no-sign', '-m', tag, '--', tag, commit], {
      env: identity,
    });
    if (made.code !== 0)
      throw new MergeError('git_failed', `tag failed: ${outputTail(made.stderr || made.stdout, 500)}`);
    // No `+`, no `--force`: the remote refuses a tag it has.
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
        `refs/tags/${tag}:refs/tags/${tag}`,
      ],
      { timeoutMs: networkTimeoutMs },
    );
    if (pushed.code === 0) return { ok: true } satisfies MergePushResult;
    // A tag that was not sent is not kept: a later attempt starts clean.
    await runGit(repo, ['tag', '-d', '--', tag]);
    const output = `${pushed.stderr}\n${pushed.stdout}`;
    const reason = classifyPush(output, pushed.timedOut);
    return {
      ok: false,
      // A refused existing tag reads as a rejected ref; the remote's own words stay in the message.
      reason: /already exists/i.test(output) ? 'rejected' : reason,
      message: outputTail(pushed.timedOut ? `${output}\nthe push timed out` : output),
    };
  };

  return { remoteTags, pushTag };
}
