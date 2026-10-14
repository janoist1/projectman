import { createRequire } from 'node:module';
import path from 'node:path';
import { runPromise } from '../kernel';
import { runProcessGroup } from './run-sandboxed-core';
import { closedStdin, niceSrtCommand } from './sandbox';

/** How long a stopped run gets to end on its own before the process group is killed. */
const KILL_GRACE_MS = 10_000;

export interface SandboxedEnd {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
  timedOut: boolean;
  aborted: boolean;
  output: string;
}

export interface SandboxedRun {
  /** The directory the command runs in. */
  cwd: string;
  /** The whole environment of the command. */
  env: Record<string, string>;
  /** The `srt` settings file of the run. */
  settings: string;
  /** Shell command, run as `/bin/sh -c`. */
  command: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/** The command line tool of the pinned Anthropic Sandbox Runtime. */
export function srtCli(): string {
  const manifest = createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json');
  return path.join(path.dirname(manifest), 'dist', 'cli.js');
}

/**
 * One command in the Anthropic Sandbox Runtime (`srt`), at low priority, as a child process of its own
 * process group: the group is stopped on abort and after `timeoutMs`, and killed when the command ends.
 * The full test (PM-217) and the screenshots of the Codex members (PM-351) both run through it.
 */
export async function runSandboxed(run: SandboxedRun): Promise<SandboxedEnd> {
  return runPromise(
    runProcessGroup({
      ...niceSrtCommand(process.execPath, srtCli(), run.settings, closedStdin(run.command)),
      cwd: run.cwd,
      env: run.env,
      timeoutMs: run.timeoutMs,
      killGraceMs: KILL_GRACE_MS,
      signal: run.signal,
    }),
  );
}
