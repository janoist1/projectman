import type { FullTestErrorReason } from '@projectman/shared';

/**
 * The server's full test of a task's pinned commit before it is reviewed (PM-217): what the
 * executor runs, and what it answers. The executor owns the OS sandbox; the domain decides what
 * runs and what the outcome means.
 */
export interface FullTestSandbox {
  /** Paths the command never reads (the user's home, the app home, the sensitive files). */
  denyRead: string[];
  /** Paths below a `denyRead` entry that are readable again (the checkout, its git directory). */
  allowRead: string[];
}

export interface FullTestSpec {
  runId: string;
  /** The root of the developer's checkout: read-only for the command. */
  cwd: string;
  /** Shell command, run as `/bin/sh -c`. */
  command: string;
  maxWorkers: number;
  timeoutMs: number;
  /** The executor adds its own run directory (the only place the command writes). */
  sandbox: FullTestSandbox;
}

export interface FullTestResult {
  outcome: 'passed' | 'failed' | 'error';
  /** `error` only. */
  reason?: FullTestErrorReason;
  exitCode: number | null;
  durationMs: number;
  /** Files of vitest's " FAIL " lines, unique, at most 20. */
  failedFiles: string[];
  /** The end of the output, ANSI removed: vitest's "Failed Tests" section from its start if there is one. */
  outputTail: string;
}

export interface FullTestExecutor {
  /** Whether the sandbox can run here; `reason` says why not. */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Aborting the signal stops the run (the whole process group); it ends as `error` / `killed`. Never throws for a run that failed. */
  run(spec: FullTestSpec, signal: AbortSignal): Promise<FullTestResult>;
}
