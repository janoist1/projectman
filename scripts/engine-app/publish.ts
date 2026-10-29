import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CloudDeps } from '../cloud/deps';
import { CloudError, refused } from '../cloud/errors';
import type { EnginePackageRequest } from './package';
import type { EngineAppBuildRequest } from './build';
import type { HeldLock } from './build-options';
import { checkoutExactCommit } from './checkout';
import { EngineAppManifest } from './manifest';
import { EngineAppReleaseConfig } from './release-config';

function readReleaseConfig(file: string | undefined) {
  try {
    return EngineAppReleaseConfig.parse(JSON.parse(fs.readFileSync(file ?? '', 'utf8')));
  } catch {
    throw refused('REFUSED [app_release_not_configured] provide a valid release configuration');
  }
}

export interface PublishDeps {
  run: CloudDeps['run'];
  heavyLock(signal: AbortSignal): Promise<HeldLock>;
  build(request: EnginePackageRequest, signal: AbortSignal): Promise<{ root: string }>;
  buildApp(request: EngineAppBuildRequest, signal: AbortSignal): Promise<{ root: string }>;
}

const names = ['projectman-motor.zip', 'projectman-motor.dmg', 'projectman-motor.json'];
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const conflict = () => refused('REFUSED [app_asset_conflict] a release asset has different content');

/** The manifest is the commit marker: upload it only after both verified archives. */
export async function publishEngineApp(
  deps: PublishDeps,
  request: { tag: string; config?: string; repositoryUrl: string },
  parentSignal?: AbortSignal,
): Promise<void> {
  const config = readReleaseConfig(request.config);
  const signal = AbortSignal.any([AbortSignal.timeout(45 * 60_000), ...(parentSignal ? [parentSignal] : [])]);
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(request.repositoryUrl);
  if (!match) throw refused('origin must be an HTTPS GitHub repository');
  const repo = match[1]!;
  const run = async (command: string, args: string[]) => {
    signal.throwIfAborted();
    const result = await deps.run(command, args, { signal, env: { GIT_TERMINAL_PROMPT: '0' } });
    signal.throwIfAborted();
    if (result.code !== 0) throw new CloudError(`${command} ${args[0]} failed (status ${result.code})`);
    return result.stdout;
  };
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
  const viewed = await deps.run('gh', ['release', 'view', request.tag, '--repo', repo, '--json', 'assets'], {
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
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-app-publish-'));
  try {
    const downloaded = path.join(work, 'remote');
    fs.mkdirSync(downloaded);
    for (const name of names.filter((name) => assets.some((asset) => asset.name === name)))
      await run('gh', [
        'release',
        'download',
        request.tag,
        '--repo',
        repo,
        '--pattern',
        name,
        '--dir',
        downloaded,
      ]);
    if (fs.existsSync(path.join(downloaded, names[2]!))) {
      let value: unknown;
      try {
        value = JSON.parse(fs.readFileSync(path.join(downloaded, names[2]!), 'utf8'));
      } catch {
        throw conflict();
      }
      const parsed = EngineAppManifest.safeParse(value);
      if (!parsed.success) throw conflict();
      const manifest = parsed.data;
      if (manifest.tag !== request.tag || manifest.version !== commit || manifest.teamId !== config.teamId)
        throw conflict();
      for (const asset of [manifest.zip, manifest.dmg]) {
        const file = path.join(downloaded, asset.name);
        if (!fs.existsSync(file) || hash(file) !== asset.sha256 || fs.statSync(file).size !== asset.size)
          throw conflict();
      }
      return;
    }
    const lock = await deps.heavyLock(signal);
    let built: { root: string };
    try {
      const checkout = path.join(work, 'checkout');
      await checkoutExactCommit(
        { deps, config: { repository: { url: request.repositoryUrl } } },
        checkout,
        commit,
        signal,
      );
      // Exactly one local tag gives the package builder the requested release identity.
      await run('git', ['-C', checkout, 'tag', request.tag, commit]);
      const pkg = await deps.build(
        {
          commit,
          outDir: path.join(work, 'package'),
          repositoryUrl: request.repositoryUrl,
          sourceRepo: checkout,
        },
        signal,
      );
      built = await deps.buildApp(
        {
          packageDir: pkg.root,
          outDir: path.join(work, 'app'),
          sourceRepo: checkout,
          originUrl: request.repositoryUrl,
          adHoc: false,
          identity: config.signingIdentity,
          teamId: config.teamId,
          notaryProfile: config.notaryProfile,
        },
        signal,
      );
    } finally {
      await lock.release();
    }
    // Check every collision before the first upload; never replace an asset.
    for (const name of names) {
      const remote = path.join(downloaded, name);
      if (fs.existsSync(remote) && hash(remote) !== hash(path.join(built.root, name))) throw conflict();
    }
    for (const name of names)
      if (!fs.existsSync(path.join(downloaded, name)))
        await run('gh', ['release', 'upload', request.tag, path.join(built.root, name), '--repo', repo]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
