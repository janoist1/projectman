import { isReleaseTagName } from '@projectman/shared';
import type { GithubService } from '../../contracts';
import { GithubError } from './errors';
import { isValidRepo } from './refs';

/** The longest release notes and title `publishRelease` takes (GitHub's own limit for the body is 125000). */
const MAX_RELEASE_NOTES = 20_000;
const MAX_RELEASE_TITLE = 200;

type RunGh = (args: readonly string[]) => Promise<string>;

/** The URL in the JSON of `gh release view --json url`; null when there is none. */
function viewedUrl(stdout: string): string | null {
  try {
    const url = (JSON.parse(stdout) as { url?: unknown }).url;
    return typeof url === 'string' && url ? url : null;
  } catch {
    return null;
  }
}

/**
 * `GithubService.publishRelease` (`publish_release`, PM-968): the public GitHub release of a tag that is on the
 * remote already. A release that exists is reused (the call may be repeated after a failure); `--verify-tag`
 * makes gh refuse to create the tag itself. Nothing else on GitHub is written.
 */
export function createReleasePublisher(run: RunGh): GithubService['publishRelease'] {
  return async (repo, input) => {
    if (!isValidRepo(repo))
      throw new GithubError('invalid_argument', `invalid repository "${repo}", expected owner/name`);
    if (!isReleaseTagName(input.tag))
      throw new GithubError('invalid_argument', `invalid release tag "${input.tag}"`);
    if (input.title.length === 0 || input.title.length > MAX_RELEASE_TITLE)
      throw new GithubError('invalid_argument', 'the release title is empty or too long');
    if (input.notes.length > MAX_RELEASE_NOTES)
      throw new GithubError('invalid_argument', 'the release notes are too long');
    let existing: string | null = null;
    try {
      existing = viewedUrl(await run(['release', 'view', input.tag, `--repo=${repo}`, '--json', 'url']));
    } catch {
      // gh words "no such release" as a plain failure; any other failure shows again when creating.
    }
    if (existing) return { url: existing };
    const made = await run([
      'release',
      'create',
      input.tag,
      `--repo=${repo}`,
      `--title=${input.title}`,
      `--notes=${input.notes}`,
      '--verify-tag',
    ]);
    const url = made.trim().split('\n').pop()?.trim();
    if (!url) throw new GithubError('invalid_response', 'gh release create printed no URL');
    return { url };
  };
}
