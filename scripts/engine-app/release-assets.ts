import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CloudDeps } from '../cloud/deps';
import { CloudError, refused } from '../cloud/errors';

/** The three assets of a release, in upload order: the manifest is the commit marker, so it goes last. */
export const APP_ASSET_NAMES = ['projectman-motor.zip', 'projectman-motor.dmg', 'projectman-motor.json'];
export const APP_MANIFEST_NAME = APP_ASSET_NAMES[2]!;

export const hashFile = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const assetConflict = () =>
  refused('REFUSED [app_asset_conflict] a release asset has different content');

/**
 * GitHub access to the assets of one release tag (shared by `publish` and `upload`, PM-1198). The rules do not
 * depend on who built the app: an identical existing asset is skipped, a different one is a conflict and is never
 * replaced, and the manifest goes up last.
 */
export function releaseAccess(
  raw: CloudDeps['run'],
  signal: AbortSignal,
  request: { tag: string; repositoryUrl: string },
) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(request.repositoryUrl);
  if (!match) throw refused('origin must be an HTTPS GitHub repository');
  const repo = match[1]!;
  const run = async (command: string, args: string[]) => {
    signal.throwIfAborted();
    const result = await raw(command, args, { signal, env: { GIT_TERMINAL_PROMPT: '0' } });
    signal.throwIfAborted();
    if (result.code !== 0) throw new CloudError(`${command} ${args[0]} failed (status ${result.code})`);
    return result.stdout;
  };
  return {
    run,
    /** The commit the tag points at; `app_release_missing` when the tag does not exist. */
    async commit(): Promise<string> {
      const refs = await run('git', [
        'ls-remote',
        '--tags',
        request.repositoryUrl,
        `refs/tags/${request.tag}`,
        `refs/tags/${request.tag}^{}`,
      ]);
      const rows = refs
        .trim()
        .split('\n')
        .map((line) => line.split(/\s+/));
      const commit = (rows.find((row) => row[1]?.endsWith('^{}')) ?? rows[0])?.[0];
      if (!commit || !/^[a-f0-9]{40}$/.test(commit))
        throw refused('REFUSED [app_release_missing] run publish_release first');
      return commit;
    },
    /** Downloads the assets the release already has into `dir` (created here). */
    async download(dir: string): Promise<void> {
      const viewed = await raw('gh', ['release', 'view', request.tag, '--repo', repo, '--json', 'assets'], {
        signal,
      });
      signal.throwIfAborted();
      if (viewed.code !== 0) {
        if (/release not found|not found|HTTP 404/i.test(viewed.stderr))
          throw refused('REFUSED [app_release_missing] run publish_release first');
        throw new CloudError('gh release view failed');
      }
      const assets = z
        .object({ assets: z.array(z.object({ name: z.string() })) })
        .parse(JSON.parse(viewed.stdout)).assets;
      fs.mkdirSync(dir);
      for (const name of APP_ASSET_NAMES.filter((name) => assets.some((asset) => asset.name === name)))
        await run('gh', [
          'release',
          'download',
          request.tag,
          '--repo',
          repo,
          '--pattern',
          name,
          '--dir',
          dir,
        ]);
    },
    /** Uploads the files of `root` that the release lacks; `downloaded` is what `download` found. */
    async upload(downloaded: string, root: string): Promise<void> {
      // Check every collision before the first upload; never replace an asset.
      for (const name of APP_ASSET_NAMES) {
        const remote = path.join(downloaded, name);
        if (fs.existsSync(remote) && hashFile(remote) !== hashFile(path.join(root, name)))
          throw assetConflict();
      }
      for (const name of APP_ASSET_NAMES)
        if (!fs.existsSync(path.join(downloaded, name)))
          await run('gh', ['release', 'upload', request.tag, path.join(root, name), '--repo', repo]);
    },
  };
}
