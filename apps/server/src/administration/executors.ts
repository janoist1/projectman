import { randomUUID } from 'node:crypto';
import type { AdministrationCommand, AdministrationExecutors, ImageArtifact } from '../contracts';
import { DomainError } from '../kernel';

/**
 * The business executors of a supervisor installation that has a builder (PM-764). They validate the pinned card
 * commit against the builder's repository, map the profile to its command and hand the work to the injected
 * toolbox, which runs on this machine: the full test in the existing sandbox behind the heavy-run queue, the
 * image build from the tracked sources of exactly that commit. What leaves is the result and the digests, never
 * output, paths or a raw error.
 */

type FullTestCommand = Extract<AdministrationCommand, { kind: 'full_test' }>;
type ImageBuildCommand = Extract<AdministrationCommand, { kind: 'image_build' }>;
type Platform = ImageBuildCommand['platforms'][number];

/** The commands of the profiles; the second runs every check, not only those the merge diff selects. */
export const FULL_TEST_COMMANDS: Record<FullTestCommand['profile'], string> = {
  'merge-test': 'npm run merge-test',
  'full-test': 'npm run merge-test -- --all',
};

export interface BuilderTestRun {
  outcome: 'passed' | 'failed' | 'error';
  exitCode: number | null;
  durationMs: number;
  failedFiles: string[];
}

export interface BuilderImage {
  platform: Platform;
  /** `sha256:<64 hex>`: the image id. */
  imageDigest: string;
  archiveSha256: string;
  bytes: number;
}

export interface BuilderToolbox {
  /** The commit object exists in the builder's repository. */
  hasCommit(commit: string): Promise<boolean>;
  /** Tests a clean, detached checkout of `commit`; waits for the machine's heavy-run queue. */
  runTest(input: {
    runId: string;
    commit: string;
    command: string;
    signal: AbortSignal;
  }): Promise<BuilderTestRun>;
  /** Builds one platform's image from the tracked sources of `commit`; loads and pushes nothing. */
  buildImage(input: { commit: string; platform: Platform; signal: AbortSignal }): Promise<BuilderImage>;
}

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const ARCHIVE_SHA = /^[0-9a-f]{64}$/;

export function createBuilderExecutors(
  toolbox: BuilderToolbox,
  options: { newId?: () => string } = {},
): Required<Pick<AdministrationExecutors, 'full_test' | 'image_build'>> {
  const newId = options.newId ?? randomUUID;
  const pinned = async (commit: string) => {
    if (!(await toolbox.hasCommit(commit)))
      throw new DomainError('invalid_request', 'the commit is not in the builder repository');
  };
  return {
    async full_test(command, signal) {
      await pinned(command.commit);
      const run = await toolbox.runTest({
        runId: `adminft_${newId()}`,
        commit: command.commit,
        command: FULL_TEST_COMMANDS[command.profile],
        signal,
      });
      return {
        kind: 'full_test',
        outcome: run.outcome,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        failedFiles: run.failedFiles.slice(0, 20),
      };
    },
    async image_build(command, signal) {
      await pinned(command.commit);
      const artifacts: ImageArtifact[] = [];
      for (const platform of [...new Set(command.platforms)]) {
        const image = await toolbox.buildImage({ commit: command.commit, platform, signal });
        if (
          image.platform !== platform ||
          !IMAGE_DIGEST.test(image.imageDigest) ||
          !ARCHIVE_SHA.test(image.archiveSha256) ||
          !Number.isSafeInteger(image.bytes) ||
          image.bytes <= 0
        )
          throw new DomainError('administration_failed', 'the image build answered invalid metadata');
        artifacts.push({
          artifactId: `img_${image.archiveSha256.slice(0, 32)}`,
          platform,
          commit: command.commit,
          imageDigest: image.imageDigest,
          archiveSha256: image.archiveSha256,
          bytes: image.bytes,
        });
      }
      return { kind: 'image_build', artifacts };
    },
  };
}
