import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import {
  MERGE_TEST_PASSED_STEP_PREFIX,
  mergeTestMarkerLine,
  mergeTestTimingLine,
  type MergeTestStepResult,
} from '@projectman/shared';
import { stripAnsi, vitestFailedFiles } from '../../apps/server/src/full-test/output';

/**
 * One command of the merge check (not a contract): `kind` tells the rerun rule what it may do. `index` is
 * the step's place in the whole list when a shard runs only some of them (the timing line carries it).
 */
export type MergeTestStep = { kind: 'typecheck' | 'test'; workspace: string; args: string[]; index?: number };

/** The `k`th of `count` shards of one merge check (`--shard k/n`), `index` counted from 1. */
export interface MergeTestShard {
  index: number;
  count: number;
}

/** The most shards a merge check is split into. */
export const MERGE_TEST_SHARDS_MAX = 8;

/** The workspaces of the repository, in the order the full run checks them. */
export const MERGE_TEST_WORKSPACES = [
  'packages/shared',
  'packages/templates',
  'apps/feedback-widget',
  'apps/server',
  'apps/web',
] as const;

/** A failed test step is rerun once only when at most this many files failed (PM-842). */
export const RERUN_FILES_MAX = 5;

/** How `npm` ended: its exit code (128 + the signal number when a signal stopped it) and its output. */
export interface StepRun {
  code: number;
  signaled: boolean;
  output: string;
}

export interface MergeTestDeps {
  /** Runs `npm <args>`, passing its output through, and returns what it printed. Rejects when npm cannot start. */
  spawn(args: string[]): Promise<StepRun>;
  /**
   * The repository files the merge changed (`HEAD^1..HEAD`); `null` when that is unknown, which
   * allows no rerun: a file the merge changed is never rerun, as it is the card's own test.
   */
  changed: ReadonlySet<string> | null;
  /** The complete candidate tree, from `git rev-parse HEAD^{tree}`. */
  tree: string;
  passedKeysFile?: string;
  noCache?: boolean;
  /** The clock in milliseconds; default `Date.now`. */
  now?: () => number;
  log(line: string): void;
}

/** Identical commands in different checkouts share a key only for the same full tree and runtime. */
export function mergeTestStepKey(
  tree: string,
  args: readonly string[],
  root = process.cwd(),
  runtime = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    maxWorkers: process.env.VITEST_MAX_FORKS ?? '',
  },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: 1,
        tree,
        args: args.map((arg) => (isAbsolute(arg) ? relative(root, arg).split(sep).join('/') : arg)),
        node: runtime.node,
        platform: runtime.platform,
        arch: runtime.arch,
        maxWorkers: runtime.maxWorkers,
      }),
    )
    .digest('hex');
}

function passedKeys(deps: MergeTestDeps): ReadonlySet<string> {
  if (!deps.noCache && deps.passedKeysFile) {
    try {
      return new Set(readFileSync(deps.passedKeysFile, 'utf8').split(/\r?\n/));
    } catch {
      // A missing or unreadable list is a cache miss; every step still runs.
    }
  }
  return new Set();
}

export function typecheckStep(workspace: string, ifPresent = false): MergeTestStep {
  return {
    kind: 'typecheck',
    workspace,
    args: ['run', 'typecheck', '-w', workspace, ...(ifPresent ? ['--if-present'] : [])],
  };
}

export function testStep(workspace: string, files?: readonly string[], ifPresent = false): MergeTestStep {
  return {
    kind: 'test',
    workspace,
    args: [
      'test',
      '-w',
      workspace,
      ...(ifPresent ? ['--if-present'] : []),
      ...(files ? ['--', ...files.map((file) => resolve(file))] : []),
    ],
  };
}

/**
 * The steps one shard runs: the type checks are dealt round-robin by their order among the type checks,
 * and every test step runs on every shard with vitest's own `--shard` (a shard may hold no file of a
 * workspace, which `--passWithNoTests` allows). Each step keeps its place in the whole list.
 */
export function shardSteps(steps: readonly MergeTestStep[], shard: MergeTestShard): MergeTestStep[] {
  let typechecks = 0;
  return steps.flatMap((step, index) => {
    if (step.kind === 'typecheck')
      return typechecks++ % shard.count === shard.index - 1 ? [{ ...step, index }] : [];
    const flags = [`--shard=${shard.index}/${shard.count}`, '--passWithNoTests'];
    return [{ ...step, index, args: [...step.args, ...(step.args.includes('--') ? [] : ['--']), ...flags] }];
  });
}

/** The workspace a repository path belongs to, or undefined. */
export function workspaceOf(path: string): string | undefined {
  return MERGE_TEST_WORKSPACES.find((workspace) => path.startsWith(`${workspace}/`));
}

/**
 * The `--files` steps: the files grouped by workspace in `MERGE_TEST_WORKSPACES` order, no type check.
 * `absent` lists the files that do not exist in the checkout (another train member's new test), which
 * never run: a filter that matches nothing makes the server's `vitest run` exit 1.
 */
export function filesSteps(
  files: readonly string[],
  exists: (file: string) => boolean,
): { steps: MergeTestStep[]; absent: string[] } {
  const absent = files.filter((file) => !exists(file));
  const present = files.filter((file) => !absent.includes(file));
  const steps = MERGE_TEST_WORKSPACES.flatMap((workspace) => {
    const own = present.filter((file) => workspaceOf(file) === workspace);
    return own.length ? [testStep(workspace, own)] : [];
  });
  return { steps, absent };
}

/** `file` as vitest printed it in the workspace, as a repository path; null when it cannot be told. */
function repoPathOf(workspace: string, file: string): string | null {
  if (file.startsWith('/') || file.startsWith('..')) return null;
  const path = posix.join(workspace, file);
  return path.startsWith(`${workspace}/`) ? path : null;
}

/** The failed files of a test step as repository paths; null for a file that cannot be placed. */
function failedRepoFiles(step: MergeTestStep, output: string): string[] | null {
  const paths = vitestFailedFiles(output).map((file) => repoPathOf(step.workspace, file));
  return paths.some((path) => path === null) ? null : [...new Set(paths as string[])];
}

/** vitest's "Unhandled Errors" block: an error that belongs to no file. */
const UNHANDLED_ERRORS = /^\s*⎯+\s*Unhandled \w+/m;

/** The files to rerun once, or undefined when the rule does not allow a rerun (PM-842). */
function rerunFiles(step: MergeTestStep, run: StepRun, deps: MergeTestDeps): string[] | undefined {
  if (step.kind !== 'test' || run.signaled || deps.changed === null) return undefined;
  if (UNHANDLED_ERRORS.test(stripAnsi(run.output))) return undefined;
  const files = failedRepoFiles(step, run.output);
  if (!files || files.length === 0 || files.length > RERUN_FILES_MAX) return undefined;
  if (files.some((file) => deps.changed!.has(file))) return undefined;
  return files;
}

/**
 * Runs the steps in order and stops at the first failed one; returns its exit code (0 when all passed).
 * A failed test step reruns once, with only its failed files, when `rerunFiles` allows it: a green
 * rerun makes the step green and the files `flaky`. The marker lines (`mergeTestMarkerLine`) are
 * printed at the end, so they are the last thing before the caller's scope line.
 */
export async function runSteps(steps: readonly MergeTestStep[], deps: MergeTestDeps): Promise<number> {
  const failed: string[] = [];
  const flaky: string[] = [];
  const cached = passedKeys(deps);
  const passed = new Set<string>();
  const markPassed = (key: string) => {
    passed.add(key);
    deps.log(`${MERGE_TEST_PASSED_STEP_PREFIX}${key}`);
  };
  const now = deps.now ?? Date.now;
  const timings: string[] = [];
  // Printed at once (a run stopped by its timeout keeps what finished) and again at the end.
  const timed = (
    index: number,
    step: MergeTestStep,
    result: MergeTestStepResult,
    durationMs: number | null,
    rerunMs?: number,
  ) => {
    const line = mergeTestTimingLine({
      index,
      kind: step.kind,
      workspace: step.workspace,
      result,
      durationMs,
      ...(rerunMs === undefined ? {} : { rerunMs }),
    });
    timings.push(line);
    deps.log(line);
  };
  try {
    for (const [position, step] of steps.entries()) {
      const index = step.index ?? position;
      const key = mergeTestStepKey(deps.tree, step.args);
      if (cached.has(key)) {
        deps.log(`merge-test cached: npm ${step.args.join(' ')}`);
        markPassed(key);
        timed(index, step, 'cached', null);
        continue;
      }
      const startedAt = now();
      const first = await deps.spawn(step.args);
      const firstMs = Math.max(0, now() - startedAt);
      if (first.code === 0 && !first.signaled) {
        markPassed(key);
        timed(index, step, 'passed', firstMs);
        continue;
      }
      const files = rerunFiles(step, first, deps);
      if (!files) {
        if (step.kind === 'test' && !first.signaled)
          failed.push(...(failedRepoFiles(step, first.output) ?? []));
        timed(index, step, 'failed', firstMs);
        return first.code;
      }
      deps.log(`merge-test: rerunning the failed files of ${step.workspace} once: ${files.join(', ')}`);
      const rerunStarted = now();
      const again = await deps.spawn(testStep(step.workspace, files).args);
      const rerunMs = Math.max(0, now() - rerunStarted);
      if (again.code === 0 && !again.signaled) {
        // A flaky result depends on the changed-file rerun rule and must keep its diagnostic on retries.
        flaky.push(...files);
        timed(index, step, 'rerun_passed', firstMs, rerunMs);
        continue;
      }
      const still = again.signaled ? null : failedRepoFiles(step, again.output);
      failed.push(...(still?.length ? still : files));
      timed(index, step, 'rerun_failed', firstMs, rerunMs);
      return again.code;
    }
    return 0;
  } finally {
    for (const line of timings) deps.log(line);
    for (const key of passed) deps.log(`${MERGE_TEST_PASSED_STEP_PREFIX}${key}`);
    for (const file of new Set(failed)) deps.log(mergeTestMarkerLine('failed', file));
    for (const file of new Set(flaky)) deps.log(mergeTestMarkerLine('flaky', file));
  }
}
