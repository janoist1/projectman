import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ComputeJobDefinition, GithubJobRunner } from '@projectman/shared';
import {
  locateComputeJobRun,
  regularFile,
  runNumber,
  verifyAttestation,
  type ComputeJobContext,
} from './compute-job-run';
import { refused } from './errors';
import { archiveDigest, bundleSchema, checked, imageRef, newOutputDirectory, verifyArchive } from './images';

/** The cloud image as a compute job (PM-1145); `docs/AWS.md` "Prebuilt ARM images" lists the same values. */
export const CLOUD_IMAGE_JOB = {
  id: 'cloud-image',
  runsOn: 'ubuntu-24.04-arm' satisfies GithubJobRunner,
  node: '22',
  timeoutMinutes: 60,
  outputs: ['bundle/manifest.json', 'bundle/linux-arm64.tar'],
  command:
    'npm ci && docker buildx create --name projectman --driver docker-container --bootstrap --use && ' +
    'npm run cloud -- image-build --ref "$PROJECTMAN_JOB_COMMIT" --out "$PROJECTMAN_JOB_OUT/bundle"',
} satisfies ComputeJobDefinition;

const MANIFEST_OUTPUT = CLOUD_IMAGE_JOB.outputs[0]!;
const ARCHIVE_OUTPUT = CLOUD_IMAGE_JOB.outputs[1]!;

/** Checks the downloaded, attested bundle and moves it into `out`, the manifest last. */
async function installBundle(
  context: ComputeJobContext,
  input: { ref: string; out: string; incoming: string },
): Promise<{ imageId: string; platform: string; archiveSha256: string }> {
  const { ref, out, incoming } = input;
  const manifestFile = regularFile(path.join(incoming, MANIFEST_OUTPUT));
  const archiveFile = regularFile(path.join(incoming, ARCHIVE_OUTPUT));
  const manifestText = fs.readFileSync(manifestFile, 'utf8');
  let bundle: z.output<typeof bundleSchema>;
  try {
    bundle = bundleSchema.parse(JSON.parse(manifestText));
  } catch {
    throw refused('the bundle manifest is invalid');
  }
  if (bundle.sourceSha !== ref) throw refused('the bundle was built from another commit');
  const image = bundle.images[0]!;
  const digest = archiveDigest(archiveFile);
  if (digest.archiveBytes !== image.archiveBytes || digest.archiveSha256 !== image.archiveSha256)
    throw refused('image archive hash or size differs from the manifest');
  await verifyArchive(context, archiveFile, image.imageId, image.platform, ref);
  fs.renameSync(archiveFile, path.join(out, image.archive));
  fs.rmSync(incoming, { recursive: true, force: true });
  const temporary = path.join(out, '.manifest.json.new');
  fs.writeFileSync(temporary, manifestText, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, path.join(out, 'manifest.json'));
  return image;
}

/**
 * Fetches the cloud image bundle that the general GitHub workflow built (PM-1145): finds or follows the run
 * (never starts one), checks where it ran, verifies the attestation of both files and the bundle, and writes
 * a bundle `deploy` accepts. Needs no cloud configuration and no Docker.
 */
export async function runImageFetch(
  context: ComputeJobContext,
  input: { ref: string; output: string; run?: string; dryRun: boolean },
): Promise<void> {
  const { deps, report } = context;
  const { ref } = input;
  imageRef('image-fetch', ref);
  const requested = input.run === undefined ? undefined : runNumber('image-fetch', input.run);
  const { root, out } = newOutputDirectory(deps, 'image-fetch', input.output);
  const { repo, branch, id, runId, url } = await locateComputeJobRun(context, {
    root,
    ref,
    job: CLOUD_IMAGE_JOB,
    ...(requested === undefined ? {} : { run: requested }),
  });
  if (input.dryRun) {
    report.step('ok', 'image-fetch', `${ref}: ${url} to ${out} (dry-run)`);
    return;
  }
  fs.mkdirSync(out, { mode: 0o700 });
  try {
    const incoming = path.join(out, '.incoming');
    await checked(context, 'gh', [
      'run',
      'download',
      String(id),
      '--repo',
      repo,
      '--name',
      `projectman-job-${runId}`,
      '--dir',
      incoming,
    ]);
    for (const output of CLOUD_IMAGE_JOB.outputs)
      await verifyAttestation(context, { repo, branch, run: id }, regularFile(path.join(incoming, output)));
    const image = await installBundle(context, { ref, out, incoming });
    report.step(
      'ok',
      'image',
      `source=${ref} platform=${image.platform} archiveSha256=${image.archiveSha256} imageId=${image.imageId} run=${url}`,
    );
  } catch (error) {
    fs.rmSync(out, { recursive: true, force: true });
    throw error;
  }
}
