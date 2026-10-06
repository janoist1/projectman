import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { OutputTail } from './output';
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
  const { signal } = run;
  return await new Promise<SandboxedEnd>((resolve) => {
    const tail = new OutputTail();
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const start = niceSrtCommand(process.execPath, srtCli(), run.settings, closedStdin(run.command));
    const child = spawn(start.file, start.args, {
      cwd: run.cwd,
      env: run.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // The group is already gone.
      }
    };
    const stop = (): void => {
      killGroup('SIGTERM');
      killTimer ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, run.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    const finish = (ended: Omit<SandboxedEnd, 'timedOut' | 'aborted' | 'output'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      // A child that detached itself may outlive the shell; the group is stopped either way.
      killGroup('SIGKILL');
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...ended, timedOut, aborted, output: tail.value() });
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => tail.push(chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => tail.push(chunk));
    child.on('error', (spawnError) => finish({ exitCode: null, signal: null, spawnError }));
    child.on('close', (exitCode, exitSignal) => finish({ exitCode, signal: exitSignal }));
  });
}
