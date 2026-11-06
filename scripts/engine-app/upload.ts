import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CloudDeps } from '../cloud/deps';
import { refused } from '../cloud/errors';
import { EngineAppManifest } from './manifest';
import { APP_ASSET_NAMES, APP_MANIFEST_NAME, hashFile, releaseAccess } from './release-assets';

const mismatch = (what: string) => refused(`REFUSED [app_manifest_mismatch] ${what}`);

/**
 * Puts a built app (ad-hoc or Developer ID) on an existing release (PM-1198). The manifest must name this tag and
 * the tag's commit, and the archives must be the ones it describes; the upload rules are `publish`'s.
 */
export async function uploadEngineApp(
  deps: { run: CloudDeps['run'] },
  request: { tag: string; dir: string; repositoryUrl: string },
  parentSignal?: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([AbortSignal.timeout(45 * 60_000), ...(parentSignal ? [parentSignal] : [])]);
  for (const name of APP_ASSET_NAMES)
    if (!fs.existsSync(path.join(request.dir, name))) throw mismatch(`${name} is missing from the directory`);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(path.join(request.dir, APP_MANIFEST_NAME), 'utf8'));
  } catch {
    throw mismatch('the manifest is not valid JSON');
  }
  const parsed = EngineAppManifest.safeParse(value);
  if (!parsed.success) throw mismatch('the manifest is not valid');
  const manifest = parsed.data;
  if (manifest.tag !== request.tag) throw mismatch('the manifest names another tag');
  for (const asset of [manifest.zip, manifest.dmg]) {
    const file = path.join(request.dir, asset.name);
    if (hashFile(file) !== asset.sha256 || fs.statSync(file).size !== asset.size)
      throw mismatch(`${asset.name} does not match the manifest`);
  }
  const release = releaseAccess(deps.run, signal, request);
  if (manifest.version !== (await release.commit())) throw mismatch('the manifest is not of the tag commit');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-app-upload-'));
  try {
    const downloaded = path.join(work, 'remote');
    await release.download(downloaded);
    await release.upload(downloaded, request.dir);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
