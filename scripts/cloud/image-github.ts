import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import type { HostSession } from './host';
import {
  artifactDownloadUrl,
  computeJobArtifact,
  locateComputeJobRun,
  verifyAttestation,
  type ComputeJobRun,
} from './compute-job-run';
import { CLOUD_IMAGE_JOB } from './image-fetch';
import { bundleSchema, checked, selectedImage, type ReceivedImage } from './images';
import { githubRepoOf } from './github';

/**
 * The cloud machine downloads the image itself (PM-1154): this computer only conducts. It finds the GitHub run
 * and its artifact, asks for a short-lived download link and hands it to the machine's `stage-image`, which
 * leaves the files in a stage. The small `manifest.json` that comes back is the only file checked here
 * (attestation, schema, commit); the archive is checked against it by the machine's `receive-image`.
 */

const STAGE_TIMEOUT_MS = 35 * 60_000;
const stagedSchema = z.strictObject({
  stage: z.string().regex(/^[0-9a-f]{32}$/),
  manifest: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

/** A run of the cloud image job and its live artifact, found before the machine is touched. */
export interface GithubImage {
  run: ComputeJobRun;
  artifact: { id: number; name: string; bytes: number };
}

export function usesGithubImage(context: Pick<CloudContext, 'config'>): boolean {
  return context.config.deployment?.imageSource === 'github';
}

/** The run (given, found or followed) of the image at `sha` and its artifact; starts nothing. */
export async function locateGithubImage(
  context: CloudContext,
  input: { sha: string; run?: number },
): Promise<GithubImage> {
  const run = await locateComputeJobRun(context, {
    root: context.deps.repoRoot,
    ref: input.sha,
    job: CLOUD_IMAGE_JOB,
    ...(input.run === undefined ? {} : { run: input.run }),
  });
  return { run, artifact: await computeJobArtifact(context, run) };
}

/** The attested `manifest.json` that the machine returned must describe the image of `sha`. */
async function verifiedManifest(
  context: CloudContext,
  github: GithubImage,
  sha: string,
  manifest: Buffer,
): Promise<ReceivedImage> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'projectman-manifest-'));
  try {
    const file = path.join(directory, 'manifest.json');
    fs.writeFileSync(file, manifest, { flag: 'wx', mode: 0o600 });
    const { repo, branch, id } = github.run;
    await verifyAttestation(context, { repo, branch, run: id }, file);
    let bundle: z.output<typeof bundleSchema>;
    try {
      bundle = bundleSchema.parse(JSON.parse(manifest.toString('utf8')));
    } catch {
      throw refused('the bundle manifest is invalid');
    }
    if (bundle.sourceSha !== sha) throw refused('the bundle was built from another commit');
    const image = bundle.images[0]!;
    return { ...image, sourceSha: bundle.sourceSha };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Has the machine download and unpack the artifact, then verifies the manifest it returned. The link goes to the
 * machine on the standard input only, and a failure never names it.
 */
export async function stageGithubImage(
  context: CloudContext,
  host: HostSession,
  input: { sha: string; github: GithubImage },
): Promise<{ stage: string; image: ReceivedImage }> {
  const { sha, github } = input;
  const url = await artifactDownloadUrl(context, github.run.repo, github.artifact.id);
  const answer = await host.call('stage-image', [String(github.artifact.bytes)], {
    input: `${url}\n`,
    timeoutMs: STAGE_TIMEOUT_MS,
  });
  let staged: z.output<typeof stagedSchema>;
  try {
    staged = stagedSchema.parse(JSON.parse(answer));
  } catch {
    throw new CloudError('the machine answered stage-image in an unexpected shape');
  }
  const image = await verifiedManifest(context, github, sha, Buffer.from(staged.manifest, 'base64'));
  return { stage: staged.stage, image };
}

/** The preflight of the image: a bundle on this computer, or a GitHub login that can read the repository. */
export async function imagePreflight(context: CloudContext): Promise<void> {
  if (!usesGithubImage(context)) {
    selectedImage(context);
    return;
  }
  const repo = githubRepoOf(
    (await checked(context, 'git', ['-C', context.deps.repoRoot, 'remote', 'get-url', 'origin'])).trim(),
  );
  await checked(context, 'gh', ['api', `repos/${repo}`]);
  context.report.step('ok', 'image', `source: GitHub (${repo})`);
}
