import path from 'node:path';
import type { ReleaseArtifact } from '@projectman/shared';
import { refused } from '../cloud/errors';
import { archiveDigest, bundleSchema } from '../cloud/images';
import type { Platform, SelectedImage } from '../cloud/images';
import { candidateFingerprints } from './engine';
import {
  preparedHybridReleaseSchema,
  RECEIPT_FILE,
  readCandidateMarker,
  readRegularFileWithHash,
} from './receipt';

/** The only platform the hybrid machine runs; a preparation builds and smokes just this one (PM-916). */
const HYBRID_PLATFORM ='linux/arm64' satisfies Platform;

/** What the coordinator carries to the targets once a preparation was checked again. */
export interface VerifiedPrepared {
  receiptPath: string;
  receiptSha256: string;
  artifact: ReleaseArtifact;
  /** The ARM archive as the cloud's image import takes it. */
  selected: SelectedImage;
  engineRoot: string;
}

export interface VerifyPreparedInput {
  outputDir: string;
  engineReleasesDir: string;
  releaseId: string;
  commit: string;
  /** The receipt hash the journal holds; null the first time, when the receipt was just read. */
  expectedReceiptSha256: string | null;
}

/**
 * The preparation (PM-750) checked again right before it is used (PM-751): the receipt bytes against the journal's
 * hash, the manifest and every archive against the receipt, the ARM smoke evidence, the engine candidate against
 * its marker. Nothing here trusts a path or a hash that was only remembered.
 */
export function verifyPreparedRelease(input: VerifyPreparedInput): VerifiedPrepared {
  const receiptPath = path.join(input.outputDir, RECEIPT_FILE);
  const { text, sha256 } = readRegularFileWithHash(receiptPath);
  if (input.expectedReceiptSha256 !== null && sha256 !== input.expectedReceiptSha256)
    throw refused('the preparation receipt changed since it was bound');
  let receipt: ReturnType<typeof preparedHybridReleaseSchema.parse>;
  try {
    receipt = preparedHybridReleaseSchema.parse(JSON.parse(text));
  } catch {
    throw refused('the preparation receipt is invalid');
  }
  if (receipt.releaseId !== input.releaseId || receipt.commit !== input.commit)
    throw refused('the preparation receipt belongs to another release');
  const imagesDir = path.join(input.outputDir, 'images');
  if (receipt.manifestPath !== path.join(imagesDir, 'manifest.json'))
    throw refused('the preparation receipt names a manifest outside its own directory');
  const manifest = readRegularFileWithHash(receipt.manifestPath);
  if (manifest.sha256 !== receipt.manifestSha256) throw refused('the image manifest changed');
  let bundle: ReturnType<typeof bundleSchema.parse>;
  try {
    bundle = bundleSchema.parse(JSON.parse(manifest.text));
  } catch {
    throw refused('the image manifest is invalid');
  }
  if (bundle.sourceSha !== input.commit) throw refused('the image bundle was built from another commit');
  for (const image of bundle.images) {
    const digest = archiveDigest(path.join(imagesDir, image.archive));
    if (digest.archiveSha256 !== image.archiveSha256 || digest.archiveBytes !== image.archiveBytes)
      throw refused('an image archive differs from the manifest');
  }
  const arm = bundle.images.find((image) => image.platform === HYBRID_PLATFORM);
  if (!arm) throw refused(`the image bundle has no ${HYBRID_PLATFORM} image`);
  const smoke = receipt.smoke.find((entry) => entry.platform === HYBRID_PLATFORM);
  if (!smoke || smoke.imageId !== arm.imageId)
    throw refused(`the smoke evidence does not match the ${HYBRID_PLATFORM} image`);

  const engineRoot = path.join(input.engineReleasesDir, `${input.releaseId}-${input.commit}`);
  if (receipt.engine.root !== engineRoot)
    throw refused('the engine candidate is not where the configuration says');
  const marker = readCandidateMarker(engineRoot);
  if (
    !marker ||
    marker.releaseId !== input.releaseId ||
    marker.commit !== input.commit ||
    marker.root !== engineRoot ||
    marker.lockfileSha256 !== receipt.engine.lockfileSha256
  )
    throw refused('the engine candidate marker does not match the receipt');
  const now = candidateFingerprints(engineRoot);
  if (
    now.lockfileSha256 !== marker.lockfileSha256 ||
    now.installedTreeSha256 !== marker.installedTreeSha256 ||
    now.serverBundleSha256 !== marker.serverBundleSha256
  )
    throw refused('the engine candidate differs from its marker');

  const artifact: ReleaseArtifact = {
    commit: input.commit,
    imageId: arm.imageId,
    platform: HYBRID_PLATFORM,
    manifestSha256: manifest.sha256,
    archiveSha256: arm.archiveSha256,
    archiveBytes: arm.archiveBytes,
  };
  return {
    receiptPath,
    receiptSha256: sha256,
    artifact,
    selected: { ...arm, file: path.join(imagesDir, arm.archive), sourceSha: input.commit },
    engineRoot,
  };
}
