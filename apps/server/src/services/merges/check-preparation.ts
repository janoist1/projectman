import path from 'node:path';
import { MERGE_CHECK_WORKFLOW } from '@projectman/shared';
import type { MergeCheckRunner, ReviewTestConfig } from '@projectman/shared';
import { EngineLinkLostError } from '../../contracts';
import type { BranchMerger, EngineHost, FullTestExecutor, FullTestSpec, MergeRepoRef } from '../../contracts';
import type { MergeCheckSandbox } from './ports';

/** The most test files one lone diagnosis sends to the GitHub Actions workflow. */
const GITHUB_FILES_MAX = 20;

export const GITHUB_RUNNER_NEEDS_REPO =
  "reviewTest.runner github_actions needs the repository's github owner/name";

/** Where a repository's merge check runs: no `runner` means the card's engine. */
export function mergeCheckRunner(reviewTest: Pick<ReviewTestConfig, 'runner'>): MergeCheckRunner {
  return reviewTest.runner ?? 'engine';
}

/**
 * The executor a merge check needs. An engine run asks the executor whether its sandbox is usable, and
 * a lost engine link is `EngineLinkLostError`; a GitHub Actions run runs no local sandbox, so it asks
 * nothing (PM-900).
 */
export async function mergeCheckExecutor(
  engine: EngineHost,
  runner: MergeCheckRunner,
): Promise<{ ok: true; executor: FullTestExecutor } | { ok: false; reason: string }> {
  const executor = engine.fullTestExecutor;
  const available = runner === 'engine' ? await executor?.available() : undefined;
  if (available && !available.ok && available.reason === 'engine_offline')
    throw new EngineLinkLostError('the merge check engine is not connected');
  if (!executor || (runner === 'engine' && !available?.ok))
    return {
      ok: false,
      reason: available && !available.ok ? available.reason : 'No full test executor is available',
    };
  return { ok: true, executor };
}

export interface MergeCheckPreparation {
  ref: MergeRepoRef;
  /** The check id: `checkoutForCheck`/`releaseCheck` and the GitHub check branch use it. */
  mergeId: string;
  mergeCommit: string;
  /** The default branch the merge commit is built onto. */
  base: string;
  depsFrom: string | null;
  runner: MergeCheckRunner;
  /** `repos[].github`; a GitHub Actions run needs it. */
  github: string | undefined;
  /** Lone diagnosis only (GitHub Actions): the test files to run. */
  files?: readonly string[];
  checkSandbox: MergeCheckSandbox;
  paths: ReturnType<EngineHost['paths']>;
}

export interface MergeCheckSpecInput {
  runId: string;
  command: string;
  reviewTest: Pick<ReviewTestConfig, 'maxWorkers' | 'timeoutMinutes'>;
}

export interface PreparedMergeCheck {
  /** The full test spec of the run: the three merge-check call sites build it here. */
  spec(input: MergeCheckSpecInput): FullTestSpec;
}

/**
 * Prepares one merge check and builds its full test spec (PM-900). On the engine: the checkout of the
 * merge commit, the dependency preparation under the heavy-run lock, the sandbox. On GitHub Actions: no
 * checkout, no lock and no installation; a still held checkout of the same check id is released, and
 * the spec carries the `githubActions` descriptor the engine's executor orchestrates.
 */
export async function prepareMergeCheck(
  merger: BranchMerger,
  input: MergeCheckPreparation,
): Promise<PreparedMergeCheck> {
  const { ref, mergeId, mergeCommit } = input;
  if (input.runner === 'github_actions') {
    if (!input.github) throw new Error(GITHUB_RUNNER_NEEDS_REPO);
    const github = input.github;
    // A checkout may still exist from an earlier run of this check id; a missing one is fine.
    await merger.releaseCheck(ref, { mergeId });
    return {
      spec: ({ runId, command, reviewTest }) => ({
        runId,
        cwd: `github-actions:${github}`,
        command,
        maxWorkers: reviewTest.maxWorkers,
        timeoutMs: reviewTest.timeoutMinutes * 60_000,
        sandbox: { denyRead: [], allowRead: [] },
        githubActions: {
          ref,
          mergeId,
          repo: github,
          base: input.base,
          commit: mergeCommit,
          workflow: MERGE_CHECK_WORKFLOW,
          ...(input.files ? { files: input.files.slice(0, GITHUB_FILES_MAX) } : {}),
        },
      }),
    };
  }
  // All merge checks prepare missing dependencies under the executor's heavy-run lock.
  const checkout = await merger.checkoutForCheck(ref, {
    mergeId,
    mergeCommit,
    depsFrom: input.depsFrom,
    allowDependencyInstall: true,
  });
  const preparation: Pick<FullTestSpec, 'requireHeavyLock' | 'npmCi'> = {
    requireHeavyLock: true,
    ...(checkout.dependencyInstallRequired === true ? { npmCi: { ref, mergeId } } : {}),
  };
  const { paths } = input;
  return {
    spec: ({ runId, command, reviewTest }) => ({
      runId,
      cwd: checkout.path,
      command,
      maxWorkers: reviewTest.maxWorkers,
      timeoutMs: reviewTest.timeoutMinutes * 60_000,
      ...preparation,
      sandbox: input.checkSandbox({
        checkout: checkout.path,
        gitDir: checkout.gitDir,
        userHome: paths.userHome,
        appHome: paths.home ?? undefined,
        closedTmpRoots: [
          ...paths.claudeTmpRoots,
          ...(paths.sessionTmpRoot ? [path.dirname(paths.sessionTmpRoot)] : []),
        ],
      }),
    }),
  };
}
