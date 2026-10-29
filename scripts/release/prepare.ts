import fs from 'node:fs';
import path from 'node:path';
import { acquireHeavyLock, defaultHeavyLockDir, runSandboxed } from '../../apps/server/src/full-test';
import type { CloudContext } from '../cloud/context';
import type { CloudDeps } from '../cloud/deps';
import { CloudError, refused } from '../cloud/errors';
import { archiveDigest, bundleSchema, runImageBuild } from '../cloud/images';
import type { BundleImage } from '../cloud/images';
import { checkoutExactCommit } from './checkout';
import { DEFAULT_TIMEOUTS, validatePrepareInput } from './config';
import type { HeldLock, PrepareOptions, PrepareReleaseInput } from './config';
import { prepareEngineCandidate, reverifyEngineCandidate } from './engine';
import type { EngineRun } from './engine';
import {
  hashRegularFile,
  preparedHybridReleaseSchema,
  readReceipt,
  readRegularFileWithHash,
  writeReceipt,
} from './receipt';
import type { PreparedHybridRelease, SmokeEvidence } from './receipt';
import { assertImageLoaded, smokeImage } from './smoke';

export type { PrepareOptions } from './config';
export type { PreparedHybridRelease } from './receipt';

/**
 * Prepares one release for the hybrid switch (PM-750): from one exact commit, a verified linux/arm64 image bundle
 * (the image proven by a runtime smoke; PM-916 dropped the unused emulated amd64 image) and a ready engine
 * checkout beside the running one. It changes no cloud resource, no running engine, no engine home and no LaunchAgent. The receipt
 * (`<outputDir>/preparation.json`) is written last, only when every check passed; it is neither an approval nor a
 * signature, and the coordinator checks it again right before it switches anything.
 */
export async function prepareHybridRelease(
  context: CloudContext,
  input: PrepareReleaseInput,
  options: PrepareOptions = {},
): Promise<PreparedHybridRelease> {
  const { input: request, paths } = validatePrepareInput(context, input, options);
  const abort = new AbortController();
  const stop = () => abort.abort();
  if (options.signal?.aborted) stop();
  options.signal?.addEventListener('abort', stop, { once: true });
  const removeInterrupt = context.deps.onInterrupt(stop);
  const signal = abort.signal;
  let lock: HeldLock | undefined;
  try {
    return await context.report.guard('release-prepare', async () => {
      lock = await waitForQueue(options, signal);
      return await prepare(abortable(context, signal), request, paths, options, signal);
    });
  } finally {
    removeInterrupt();
    options.signal?.removeEventListener('abort', stop);
    await lock?.release();
  }
}

function running(signal: AbortSignal): void {
  if (signal.aborted) throw new CloudError('the preparation was interrupted');
}

/** The machine's heavy-run queue is mandatory: an unusable queue is a failure, never a run without it. */
async function waitForQueue(options: PrepareOptions, signal: AbortSignal): Promise<HeldLock> {
  const acquire =
    options.heavyLock ??
    ((label: string, wait: AbortSignal) =>
      acquireHeavyLock({ dir: defaultHeavyLockDir(), label, signal: wait }));
  try {
    return await acquire('hybrid release preparation', signal);
  } catch {
    running(signal);
    throw refused("the machine's heavy-run queue is unavailable: the preparation does not run without it");
  }
}

/** Every process the preparation starts stops when it is interrupted, the builder's included. */
function abortable(context: CloudContext, signal: AbortSignal): CloudContext {
  const deps: CloudDeps = {
    ...context.deps,
    run: (command, args, runOptions) =>
      context.deps.run(command, args, { ...runOptions, signal: runOptions?.signal ?? signal }),
    pipe: (from, to) =>
      context.deps.pipe({ ...from, signal: from.signal ?? signal }, { ...to, signal: to.signal ?? signal }),
  };
  return { ...context, deps };
}

interface VerifiedBundle {
  manifestPath: string;
  manifestSha256: string;
  manifestText: string;
  images: BundleImage[];
}

/** The manifest as the single source of the archives' hashes, sizes and image IDs, and every archive against it. */
function readBundle(imagesDir: string, commit: string): VerifiedBundle {
  const manifestPath = path.join(imagesDir, 'manifest.json');
  const { text: manifestText, sha256: manifestSha256 } = readRegularFileWithHash(manifestPath);
  const bundle = bundleSchema.parse(JSON.parse(manifestText));
  if (bundle.sourceSha !== commit) throw refused('the image bundle was built from another commit');
  for (const image of bundle.images) {
    const digest = archiveDigest(path.join(imagesDir, image.archive));
    if (digest.archiveSha256 !== image.archiveSha256 || digest.archiveBytes !== image.archiveBytes)
      throw refused('an image archive differs from the manifest');
  }
  return { manifestPath, manifestSha256, manifestText, images: bundle.images };
}

async function prepare(
  context: CloudContext,
  request: { releaseId: string; commit: string; outputDir: string; engineReleasesDir: string },
  paths: ReturnType<typeof validatePrepareInput>['paths'],
  options: PrepareOptions,
  signal: AbortSignal,
): Promise<PreparedHybridRelease> {
  const { releaseId, commit } = request;
  const { outputDir } = paths;
  const buildSource = path.join(outputDir, 'build-source');
  const imagesDir = path.join(outputDir, 'images');
  const timeout = (stage: keyof typeof DEFAULT_TIMEOUTS) =>
    options.timeouts?.[stage] ?? DEFAULT_TIMEOUTS[stage];
  try {
    fs.mkdirSync(outputDir, { mode: 0o700 });
  } catch {
    throw refused('outputDir must be a new directory that does not exist yet');
  }
  context.report.step('ok', 'release-prepare', `${releaseId} at ${commit}`);

  // 1. The builder's own clean checkout of the exact commit; the source checkout and the members' are not touched.
  await checkoutExactCommit(context, buildSource, commit, signal);
  context.report.step('ok', 'release-checkout', buildSource);
  const lockfileAtBuild = hashRegularFile(path.join(buildSource, 'package-lock.json'));

  // 2. The arm64 image only (the one platform of the cloud machine), tracked source only, on the admin builder
  // (no registry, no EC2, no builder provisioning).
  running(signal);
  const builderContext: CloudContext = { ...context, deps: { ...context.deps, repoRoot: buildSource } };
  await runImageBuild(builderContext, commit, imagesDir, false);
  const bundle = readBundle(imagesDir, commit);
  context.report.step('ok', 'release-images', `manifest sha256=${bundle.manifestSha256}`);

  // 3. A runtime smoke of each image by its ID: archive integrity is not proof that the image runs.
  const smoke: SmokeEvidence[] = [];
  for (const image of bundle.images) {
    running(signal);
    smoke.push(await smokeImage(context, { image, commit, signal, timeoutMs: timeout('smoke') }));
    context.report.step('ok', 'release-smoke', `${image.platform} ${image.imageId}`);
  }

  // 4. The engine candidate: a new checkout beside the running engine's, installed and built in the sandbox.
  running(signal);
  const engineRun: EngineRun = {
    context,
    releaseId,
    commit,
    paths,
    options,
    signal,
    sandbox: options.sandbox ?? runSandboxed,
  };
  const engine = await prepareEngineCandidate(engineRun);
  context.report.step('ok', 'release-engine', `${engine.root} lockfile sha256=${engine.lockfileSha256}`);

  // 5. Everything again, immediately before the receipt: the receipt must describe what stands there now.
  running(signal);
  const again = readBundle(imagesDir, commit);
  if (again.manifestSha256 !== bundle.manifestSha256 || again.manifestText !== bundle.manifestText)
    throw refused('the image manifest changed during the preparation');
  for (const image of again.images) await assertImageLoaded(context, image, commit, signal);
  const known = new Map(smoke.map((entry) => [entry.platform, entry.imageId]));
  if (
    again.images.length !== known.size ||
    again.images.some((image) => known.get(image.platform) !== image.imageId)
  )
    throw refused('the smoke evidence does not match the manifest images');
  await reverifyEngineCandidate(engineRun, engine);
  if (engine.lockfileSha256 !== lockfileAtBuild)
    throw refused('the engine candidate lockfile differs from the image builder checkout');

  // Our own temporary builder checkout goes; nothing else is removed.
  fs.rmSync(buildSource, { recursive: true, force: true });
  const receipt = preparedHybridReleaseSchema.parse({
    version: 1,
    releaseId,
    commit,
    preparedAt: context.deps.now().toISOString(),
    manifestPath: bundle.manifestPath,
    manifestSha256: bundle.manifestSha256,
    engine,
    smoke,
  });
  const file = writeReceipt(outputDir, receipt);
  context.report.step('created', 'release-receipt', file);
  return readReceipt(file);
}
