import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CloudDeps } from '../cloud/deps';
import { refused } from '../cloud/errors';
import type { EnginePackageRequest } from './package';
import type { EngineAppBuildRequest } from './build';
import type { HeldLock } from './build-options';
import { checkoutExactCommit } from './checkout';
import { EngineAppManifest } from './manifest';
import { APP_MANIFEST_NAME, assetConflict, hashFile, releaseAccess } from './release-assets';
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

/** The manifest is the commit marker: upload it only after both verified archives. */
export async function publishEngineApp(
  deps: PublishDeps,
  request: { tag: string; config?: string; repositoryUrl: string },
  parentSignal?: AbortSignal,
): Promise<void> {
  const config = readReleaseConfig(request.config);
  const signal = AbortSignal.any([AbortSignal.timeout(45 * 60_000), ...(parentSignal ? [parentSignal] : [])]);
  const release = releaseAccess(deps.run, signal, request);
  const commit = await release.commit();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-app-publish-'));
  try {
    const downloaded = path.join(work, 'remote');
    await release.download(downloaded);
    if (fs.existsSync(path.join(downloaded, APP_MANIFEST_NAME))) {
      let value: unknown;
      try {
        value = JSON.parse(fs.readFileSync(path.join(downloaded, APP_MANIFEST_NAME), 'utf8'));
      } catch {
        throw assetConflict();
      }
      const parsed = EngineAppManifest.safeParse(value);
      if (!parsed.success) throw assetConflict();
      const manifest = parsed.data;
      if (manifest.tag !== request.tag || manifest.version !== commit || manifest.teamId !== config.teamId)
        throw assetConflict();
      for (const asset of [manifest.zip, manifest.dmg]) {
        const file = path.join(downloaded, asset.name);
        if (!fs.existsSync(file) || hashFile(file) !== asset.sha256 || fs.statSync(file).size !== asset.size)
          throw assetConflict();
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
      await release.run('git', ['-C', checkout, 'tag', request.tag, commit]);
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
    await release.upload(downloaded, built.root);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
