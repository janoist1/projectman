// The builder of an administration supervisor (PM-764): the full test and the image build of a pinned card
// commit, run on this machine. Both read the commit out of the builder repository (a detached check checkout,
// `git archive`), never the repository's working tree, and only digests and counts go back to the hub.
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createBuilderExecutors } from '../../apps/server/src/administration';
import type { BuilderToolbox } from '../../apps/server/src/administration';
import type { AdministrationExecutors } from '../../apps/server/src/contracts';
import { createLocalBranchMerger } from '../../apps/server/src/engine-host';
import { execCommand } from '../../apps/server/src/exec';
import { createFullTestExecutor, defaultHeavyLockDir } from '../../apps/server/src/full-test';
import { fullTestSandbox } from '../../apps/server/src/runtime/sessions';
import { realDeps } from '../cloud/deps';
import { buildPinnedImage } from '../cloud/images';

/** A test of the whole repository: the same four workers and hour the merge check is given. */
const MAX_WORKERS = 4;
const TIMEOUT_MS = 60 * 60_000;
const BUILDER_REF = { projectKey: 'BUILDER', repo: 'builder' };

export function createBuilderToolbox(builder: { repo: string; root: string }): BuilderToolbox {
  const merger = createLocalBranchMerger({ repoPath: () => builder.repo, worktreesRoot: builder.root });
  const executor = createFullTestExecutor({
    logger: Fastify({ logger: true }).log,
    heavyLockDir: defaultHeavyLockDir(),
    worktreesRoot: builder.root,
  });
  const userHome = os.homedir();
  return {
    async hasCommit(commit) {
      try {
        await execCommand('git', ['-C', builder.repo, 'cat-file', '-e', `${commit}^{commit}`], {
          env: { ...process.env },
        });
        return true;
      } catch {
        return false;
      }
    },
    async runTest({ runId, commit, command, signal }) {
      const available = await executor.available();
      if (!available.ok) return { outcome: 'error', exitCode: null, durationMs: 0, failedFiles: [] };
      const mergeId = `mrg_${randomBytes(8).toString('hex')}`;
      const checkout = await merger.checkoutForCheck(BUILDER_REF, {
        mergeId,
        mergeCommit: commit,
        depsFrom: null,
        allowDependencyInstall: true,
      });
      try {
        const result = await executor.run(
          {
            runId,
            cwd: checkout.path,
            command,
            maxWorkers: MAX_WORKERS,
            timeoutMs: TIMEOUT_MS,
            // One heavy run at a time on the machine, whatever happens to the queue (PM-658).
            requireHeavyLock: true,
            ...(checkout.dependencyInstallRequired === true ? { npmCi: { ref: BUILDER_REF, mergeId } } : {}),
            sandbox: fullTestSandbox({
              checkout: checkout.path,
              gitDir: checkout.gitDir,
              userHome,
              appHome: path.join(userHome, '.projectman'),
            }),
          },
          signal,
        );
        return {
          outcome: result.outcome,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          failedFiles: result.failedFiles,
        };
      } finally {
        await merger.releaseCheck(BUILDER_REF, { mergeId }).catch(() => {});
      }
    },
    async buildImage({ commit, platform, signal }) {
      const built = await buildPinnedImage(
        { deps: realDeps() },
        {
          repo: builder.repo,
          ref: commit,
          platform,
          workDir: path.join(builder.root, '_image-build'),
          signal,
        },
      );
      return {
        platform,
        imageDigest: built.imageId,
        archiveSha256: built.archiveSha256,
        bytes: built.archiveBytes,
      };
    },
  };
}

/** The executors of an installation with a builder; none without one, so the commands stay unavailable. */
export function builderExecutors(
  builder: { repo: string; root: string } | undefined,
): AdministrationExecutors | undefined {
  return builder ? createBuilderExecutors(createBuilderToolbox(builder)) : undefined;
}
