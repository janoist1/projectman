import { z } from 'zod';
import { isRepoFilePath } from '../config/project-docs';

/**
 * The marker lines `npm run merge-test` prints (PM-842), one per test file: `failed` for a file that
 * still failed after its one rerun (or was not rerun), `flaky` for one that failed and then passed.
 * The script writes them, the full test executor and the server read them: the rule lives here.
 */
export const MERGE_TEST_FAILED_PREFIX = 'merge-test failed: ';
export const MERGE_TEST_FLAKY_PREFIX = 'merge-test flaky: ';
export const MERGE_TEST_PASSED_STEP_PREFIX = 'merge-test step passed: ';
/** The most marked files read from one output. */
export const MERGE_TEST_MARKED_FILES_MAX = 20;

export type MergeTestMark = 'failed' | 'flaky';

const PREFIX: Record<MergeTestMark, string> = {
  failed: MERGE_TEST_FAILED_PREFIX,
  flaky: MERGE_TEST_FLAKY_PREFIX,
};

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** The 64-hex keys of the line-anchored passed-step lines (ANSI removed), unique, at most 50. */
export function mergeTestPassedSteps(output: string): string[] {
  const keys = new Set<string>();
  for (const line of output.replace(ANSI, '').split(/\r?\n/)) {
    if (!line.startsWith(MERGE_TEST_PASSED_STEP_PREFIX)) continue;
    const key = line.slice(MERGE_TEST_PASSED_STEP_PREFIX.length);
    if (!/^[a-f0-9]{64}$/i.test(key)) continue;
    keys.add(key);
    if (keys.size >= 50) break;
  }
  return [...keys];
}

/** One marker line, without newline. Throws TypeError when `path` is not `isRepoFilePath`. */
export function mergeTestMarkerLine(kind: MergeTestMark, path: string): string {
  if (!isRepoFilePath(path)) throw new TypeError(`not a repository file path: ${path}`);
  return `${PREFIX[kind]}${path}`;
}

/** One word of a shell command, in single quotes: nothing in it is expanded. */
export function quoteShellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that runs only `files` (PM-844): the configured `filesCommand` prefix and the
 * repository-relative paths, each shell-quoted.
 */
export function mergeTestFilesCommand(filesCommand: string, files: readonly string[]): string {
  return [filesCommand, ...files.map(quoteShellWord)].join(' ');
}

/**
 * The paths of the line-anchored marker lines of `kind` (ANSI removed, CRLF accepted), unique, in
 * order, at most `MERGE_TEST_MARKED_FILES_MAX`; lines with an invalid path are skipped.
 */
export function mergeTestMarkedFiles(output: string, kind: MergeTestMark): string[] {
  const prefix = PREFIX[kind];
  const files: string[] = [];
  for (const line of output.replace(ANSI, '').split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const file = line.slice(prefix.length);
    if (!isRepoFilePath(file) || files.includes(file)) continue;
    files.push(file);
    if (files.length >= MERGE_TEST_MARKED_FILES_MAX) break;
  }
  return files;
}

/** The measurement lines of `npm run merge-test` (PM-876): one JSON step timing, and the worker count. */
export const MERGE_TEST_TIMING_PREFIX = 'merge-test timing: ';
export const MERGE_TEST_WORKERS_PREFIX = 'merge-test workers: ';
const MERGE_TEST_SCOPE_LINE = /^merge-test scope: (all|modules|cloud|shared|workspaces|none|files)\b/;

export const MergeTestScopeKind = z.enum([
  'all',
  'modules',
  'cloud',
  'shared',
  'workspaces',
  'none',
  'files',
]);
export type MergeTestScopeKind = z.infer<typeof MergeTestScopeKind>;
/** `cached`: taken from the step cache, not measured. `rerun_*`: the failed files were rerun once. */
export const MergeTestStepResult = z.enum(['passed', 'failed', 'cached', 'rerun_passed', 'rerun_failed']);
export type MergeTestStepResult = z.infer<typeof MergeTestStepResult>;
export const MergeTestStepTiming = z.strictObject({
  /** The step's position in the run. */
  index: z.number().int().min(0).max(63),
  kind: z.enum(['typecheck', 'test']),
  workspace: z
    .string()
    .regex(/^(apps|packages)\/[a-z0-9-]+$/)
    .max(64),
  result: MergeTestStepResult,
  /** Null only for `cached`: a step that was not run has no duration, never 0. */
  durationMs: z.number().int().min(0).nullable(),
  /** `rerun_*` only: the rerun's own time; `durationMs` is the first run's. */
  rerunMs: z.number().int().min(0).optional(),
});
export type MergeTestStepTiming = z.infer<typeof MergeTestStepTiming>;
export const MergeTestReport = z.strictObject({
  /** Null: the output had no scope line. */
  scope: MergeTestScopeKind.nullable(),
  /** What the script saw in `VITEST_MAX_FORKS`; null: unset or invalid. */
  workers: z.number().int().min(1).nullable(),
  /** The merge-test command's own time (no probes, no `npm ci`). */
  commandMs: z.number().int().min(0).nullable(),
  /** By index; the finished steps only. */
  steps: z.array(MergeTestStepTiming).max(64),
});
export type MergeTestReport = z.infer<typeof MergeTestReport>;

/** Where a merge check runs (PM-900): the card's engine, or the repository's GitHub Actions workflow. */
export const MergeCheckRunner = z.enum(['engine', 'github_actions']);
export type MergeCheckRunner = z.infer<typeof MergeCheckRunner>;
/** The repository workflow file of the GitHub Actions merge check. */
export const MERGE_CHECK_WORKFLOW = 'merge-check.yml';

/** The result of a step, worst last. */
const STEP_RESULT_ORDER: readonly MergeTestStepResult[] = [
  'cached',
  'passed',
  'rerun_passed',
  'rerun_failed',
  'failed',
];

/**
 * One report from the shard reports of a sharded run (PM-900): the steps merged by index, each with
 * the worst result of its shards and the longest times. Null for no reports.
 */
export function mergeShardReports(
  reports: readonly MergeTestReport[],
  commandMs: number | null,
): MergeTestReport | null {
  if (reports.length === 0) return null;
  const byIndex = new Map<number, MergeTestStepTiming[]>();
  for (const report of reports)
    for (const step of report.steps) byIndex.set(step.index, [...(byIndex.get(step.index) ?? []), step]);
  const steps = [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, shards]): MergeTestStepTiming => {
      const first = shards[0]!;
      const result = shards.reduce(
        (worst, { result: next }) =>
          STEP_RESULT_ORDER.indexOf(next) > STEP_RESULT_ORDER.indexOf(worst) ? next : worst,
        first.result,
      );
      const durations = shards.flatMap((s) => (s.durationMs === null ? [] : [s.durationMs]));
      const reruns = shards.flatMap((s) => (s.rerunMs === undefined ? [] : [s.rerunMs]));
      return {
        index,
        kind: first.kind,
        workspace: first.workspace,
        result,
        durationMs: durations.length > 0 ? Math.max(...durations) : null,
        ...(result.startsWith('rerun_') && reruns.length > 0 ? { rerunMs: Math.max(...reruns) } : {}),
      };
    });
  return {
    scope: reports.find((r) => r.scope !== null)?.scope ?? null,
    workers: reports.find((r) => r.workers !== null)?.workers ?? null,
    commandMs: commandMs === null ? null : Math.max(0, Math.round(commandMs)),
    steps,
  };
}

/** One timing line, without newline. */
export function mergeTestTimingLine(step: MergeTestStepTiming): string {
  return `${MERGE_TEST_TIMING_PREFIX}${JSON.stringify(MergeTestStepTiming.parse(step))}`;
}

/**
 * The measurements in a merge-test output (ANSI removed, line-anchored prefixes): the scope kind,
 * the worker count and the step timings (an invalid line is skipped; for one index the last line
 * wins). Null when the output has none of them: another command, or a script older than PM-876.
 */
export function mergeTestReport(output: string, commandMs: number | null): MergeTestReport | null {
  let scope: MergeTestScopeKind | null = null;
  let workers: number | null = null;
  let seen = false;
  const steps = new Map<number, MergeTestStepTiming>();
  for (const line of output.replace(ANSI, '').split(/\r?\n/)) {
    if (line.startsWith(MERGE_TEST_TIMING_PREFIX)) {
      try {
        const step = MergeTestStepTiming.safeParse(JSON.parse(line.slice(MERGE_TEST_TIMING_PREFIX.length)));
        if (step.success) {
          steps.set(step.data.index, step.data);
          seen = true;
        }
      } catch {
        // Not JSON: skipped.
      }
    } else if (line.startsWith(MERGE_TEST_WORKERS_PREFIX)) {
      const value = line.slice(MERGE_TEST_WORKERS_PREFIX.length);
      seen = true;
      if (/^[1-9][0-9]{0,5}$/.test(value)) workers = Number(value);
    } else {
      const match = MERGE_TEST_SCOPE_LINE.exec(line);
      if (match && scope === null) {
        scope = match[1] as MergeTestScopeKind;
        seen = true;
      }
    }
  }
  if (!seen) return null;
  return {
    scope,
    workers,
    commandMs: commandMs === null ? null : Math.max(0, Math.round(commandMs)),
    steps: [...steps.values()].sort((a, b) => a.index - b.index),
  };
}
