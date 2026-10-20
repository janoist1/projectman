import {
  MERGE_TEST_MARKED_FILES_MAX,
  mergeShardReports,
  mergeTestMarkedFiles,
  mergeTestMarkerLine,
  mergeTestReport,
  type MergeTestReport,
} from '@projectman/shared';
import type { FullTestResult, WorkflowJobInfo, WorkflowRunInfo, WorkflowStepInfo } from '../contracts';
import { failureReport } from './output';

/**
 * What a finished GitHub Actions merge check (PM-900) says: the verdict from the jobs' and steps'
 * conclusions, and the `FullTestResult` the local executor would have given from the jobs' logs. Pure
 * functions; the executor (`github-actions.ts`) fetches the data.
 */

/** The step of the workflow that runs `npm run merge-test`. */
export const MERGE_TEST_STEP = 'merge-test';
/** The most characters of an `outputTail` (the merge failure's own limit). */
export const GITHUB_OUTPUT_TAIL_CHARS = 8000;
/** The least characters a failed job keeps of its report, however many jobs failed. */
const REPORT_MIN_CHARS = 300;

/** GitHub prefixes every log line with a time (and the first with a byte order mark). */
const GITHUB_TIMESTAMP = /^\ufeff?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /;

export function stripGithubTimestamps(log: string): string {
  return log
    .split('\n')
    .map((line) => line.replace(GITHUB_TIMESTAMP, ''))
    .join('\n');
}

export type Judgement =
  | { kind: 'passed' }
  | { kind: 'failed'; failed: WorkflowJobInfo[] }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

const mergeStepOf = (job: WorkflowJobInfo): WorkflowStepInfo | undefined =>
  job.steps.find((step) => step.name === MERGE_TEST_STEP);

const succeeded = (job: WorkflowJobInfo): boolean =>
  job.conclusion === 'success' && mergeStepOf(job)?.conclusion === 'success';

/** The job failed in its `merge-test` step, after every step before it passed. */
function failedInMergeTest(job: WorkflowJobInfo): boolean {
  const step = mergeStepOf(job);
  if (job.conclusion !== 'failure' || step?.conclusion !== 'failure') return false;
  return job.steps.slice(0, job.steps.indexOf(step)).every((before) => before.conclusion === 'success');
}

function describeJob(job: WorkflowJobInfo): string {
  const step = job.steps.find((candidate) => candidate.conclusion === 'failure');
  return `"${job.name}" ${job.conclusion ?? job.status}${step ? ` (step "${step.name}")` : ''}`;
}

/** The verdict of a completed run on its jobs. */
export function judge(run: WorkflowRunInfo, commit: string, jobs: readonly WorkflowJobInfo[]): Judgement {
  if (run.headSha.toLowerCase() !== commit.toLowerCase())
    return { kind: 'error', message: `The run checked ${run.headSha}, not ${commit}.` };
  if (jobs.length === 0) return { kind: 'error', message: 'The run has no jobs.' };
  const skipped = jobs.find((job) => job.conclusion === 'skipped');
  if (skipped) return { kind: 'error', message: `The job "${skipped.name}" was skipped.` };
  const without = jobs.find((job) => !mergeStepOf(job));
  if (without) return { kind: 'error', message: `The job "${without.name}" has no ${MERGE_TEST_STEP} step.` };
  if (jobs.every(succeeded)) return { kind: 'passed' };
  const unsuccessful = jobs.filter((job) => !succeeded(job));
  if (unsuccessful.every(failedInMergeTest)) return { kind: 'failed', failed: unsuccessful };
  if (jobs.some((job) => job.conclusion === 'timed_out')) return { kind: 'timeout' };
  return {
    kind: 'error',
    message: `The run ended as ${run.conclusion ?? 'unknown'} without a test verdict: ${unsuccessful.map(describeJob).join(', ')}.`,
  };
}

/** The longest time of the jobs' `merge-test` steps; null when none has both times. */
export function mergeTestCommandMs(jobs: readonly WorkflowJobInfo[]): number | null {
  const times = jobs.flatMap((job) => {
    const step = mergeStepOf(job);
    const started = step?.startedAt ? Date.parse(step.startedAt) : Number.NaN;
    const completed = step?.completedAt ? Date.parse(step.completedAt) : Number.NaN;
    return Number.isFinite(started) && Number.isFinite(completed) ? [Math.max(0, completed - started)] : [];
  });
  return times.length > 0 ? Math.max(...times) : null;
}

export interface FinishedRun {
  run: WorkflowRunInfo;
  /** The jobs of the run and their logs (timestamps removed), in the same order. */
  jobs: readonly { job: WorkflowJobInfo; log: string }[];
  durationMs: number;
}

/** The first line of every output of a run that has a page. */
export const runHeader = (run: WorkflowRunInfo): string => `GitHub Actions: ${run.htmlUrl}`;

/** The text under the run's header, the header always kept: the end is cut when the text is too long. */
export function withHeader(run: WorkflowRunInfo | null, text: string): string {
  const header = run ? `${runHeader(run)}\n` : '';
  const room = Math.max(0, GITHUB_OUTPUT_TAIL_CHARS - header.length);
  return `${header}${text.length > room ? `${text.slice(0, Math.max(0, room - 2))}\n…` : text}`;
}

function sharedReport(finished: FinishedRun): MergeTestReport | null {
  const reports = finished.jobs
    .map(({ log }) => mergeTestReport(log, null))
    .filter((report): report is MergeTestReport => report !== null);
  return mergeShardReports(reports, mergeTestCommandMs(finished.jobs.map(({ job }) => job)));
}

/** The flaky marker lines of the shards, each file once. */
function flakyLines(finished: FinishedRun): string[] {
  const files: string[] = [];
  for (const { log } of finished.jobs)
    for (const file of mergeTestMarkedFiles(log, 'flaky'))
      if (!files.includes(file) && files.length < MERGE_TEST_MARKED_FILES_MAX) files.push(file);
  return files.map((file) => mergeTestMarkerLine('flaky', file));
}

export function passedResult(finished: FinishedRun): FullTestResult {
  return {
    outcome: 'passed',
    exitCode: 0,
    durationMs: finished.durationMs,
    failedFiles: [],
    outputTail: withHeader(finished.run, flakyLines(finished).join('\n')),
    report: sharedReport(finished),
    externalUrl: finished.run.htmlUrl,
  };
}

export function failedResult(finished: FinishedRun, failed: readonly WorkflowJobInfo[]): FullTestResult {
  const logs = failed.map((job) => ({
    job,
    log: finished.jobs.find((entry) => entry.job.id === job.id)?.log ?? '',
  }));
  const files: string[] = [];
  for (const { log } of finished.jobs)
    for (const file of mergeTestMarkedFiles(log, 'failed'))
      if (!files.includes(file) && files.length < MERGE_TEST_MARKED_FILES_MAX) files.push(file);
  // The reports share what the header and the titles leave, so that the cut falls on the reports.
  const titles = logs.map(({ job }) => `--- ${job.name} ---\n`);
  const room =
    GITHUB_OUTPUT_TAIL_CHARS -
    runHeader(finished.run).length -
    1 -
    titles.reduce((sum, title) => sum + title.length + 1, 0);
  const each = Math.max(REPORT_MIN_CHARS, Math.floor(room / Math.max(logs.length, 1)));
  const sections = logs.map(({ log }, index) => `${titles[index]}${failureReport(log, each)}`);
  return {
    outcome: 'failed',
    exitCode: 1,
    durationMs: finished.durationMs,
    failedFiles: files,
    outputTail: withHeader(finished.run, sections.join('\n')),
    report: sharedReport(finished),
    externalUrl: finished.run.htmlUrl,
  };
}
