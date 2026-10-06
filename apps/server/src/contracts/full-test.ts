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

/**
 * The screenshots of a Codex member (PM-351): `npm run shots` run by the server, in the same
 * sandbox the full test runs in, because Chromium does not start in the member's own.
 */
export interface ScreenshotRunSpec {
  runId: string;
  /** The session's worktree; the command runs here. */
  cwd: string;
  /** The session's own folder: `PROJECTMAN_SESSION_DIR` of the run. */
  sessionDir: string;
  browsersDir?: string;
  /** Arguments after `npm run shots --`, built by the server from the validated input. */
  args: string[];
  /** From the session's sandbox (`AgentSandbox`): what the run may read and write besides its own directory. */
  sandbox: { allowWrite: string[]; denyWrite: string[]; denyRead: string[]; allowRead: string[] };
  /** The heavy-run queue label, e.g. `shots PM-339 codex`. */
  label: string;
  timeoutMs: number;
}

/** What a session's screenshot run needs from the session: its worktree, its own folder, its sandbox's limits. */
export interface ScreenshotScope {
  cwd: string;
  sessionDir: string;
  browsersDir?: string;
  sandbox: ScreenshotRunSpec['sandbox'];
}

export interface ScreenshotRunEnded {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  /** The sandbox could not be prepared or started. */
  spawnError?: string;
  /** The end of the output. */
  output: string;
}

export interface ScreenshotExecutor {
  /**
   * `onStarted` is called once the run got its turn in the heavy-run queue and its process started.
   * Aborting the signal stops the run (the whole process group). Never throws for a run that failed.
   */
  run(spec: ScreenshotRunSpec, signal: AbortSignal, onStarted: () => void): Promise<ScreenshotRunEnded>;
}

export interface FullTestExecutor {
  /** Whether the sandbox can run here; `reason` says why not. */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Aborting the signal stops the run (the whole process group); it ends as `error` / `killed`. Never throws for a run that failed. */
  run(spec: FullTestSpec, signal: AbortSignal): Promise<FullTestResult>;
}
