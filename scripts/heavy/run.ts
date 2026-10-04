import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { basename } from 'node:path';
import {
  acquireHeavyLock,
  defaultHeavyLockDir,
  HeavyLockError,
} from '../../apps/server/src/full-test/heavy-lock';
import type { HeavyLock, HeavyLockEntry } from '../../apps/server/src/full-test/heavy-lock';

/** Exit status of a `--max-wait` that ran out (EX_TEMPFAIL). */
export const EXIT_QUEUE_TIMEOUT = 75;
const EXIT_USAGE = 2;
const EXIT_NOT_FOUND = 127;
const LABEL_MAX = 120;
/** Set for everything the CLI runs: a nested call, and the server's full test, run without the lock. */
export const HELD_VARIABLE = 'PROJECTMAN_HEAVY_LOCK_HELD';

export const USAGE =
  'usage: npm run heavy -- [--label <text>] [--max-wait <seconds>] [--] <command> [args...]\n';

export interface HeavyArgs {
  label?: string;
  maxWaitSeconds?: number;
  command: string[];
}

/** The options up to the first argument that is not one; everything from there on is the command. */
export function parseHeavyArgs(argv: readonly string[]): HeavyArgs | { error: string } {
  const args: HeavyArgs = { command: [] };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg === '--label' || arg === '--max-wait') {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${arg} needs a value` };
      if (arg === '--label') args.label = value;
      else {
        const seconds = Number(value);
        if (value.trim() === '' || !Number.isFinite(seconds) || seconds < 0)
          return { error: `--max-wait needs a number of seconds, not "${value}"` };
        args.maxWaitSeconds = seconds;
      }
      index += 2;
      continue;
    }
    if (arg.startsWith('-')) return { error: `unknown option ${arg}` };
    break;
  }
  args.command = argv.slice(index);
  if (args.command.length === 0) return { error: 'no command' };
  return args;
}

/** `3m05s`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

function clock(iso: string | undefined): string {
  const date = iso ? new Date(iso) : undefined;
  if (!date || Number.isNaN(date.getTime())) return '?';
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function waitingLine(wait: { holder: HeavyLockEntry | null; ahead: number; waitedMs: number }): string {
  const who = wait.holder
    ? `"${wait.holder.label}" since ${clock(wait.holder.since ?? wait.holder.queuedAt)}`
    : 'someone';
  return `heavy: waiting for the machine's heavy-run queue: ${who}, ${wait.ahead} ahead of you (waited ${formatDuration(wait.waitedMs)})\n`;
}

export interface HeavyRun {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stderr: (text: string) => void;
}

/** Runs the command at its turn and returns the exit status; see docs/ARCHITECTURE.md "Heavy-run queue". */
export async function runHeavy(run: HeavyRun): Promise<number> {
  const parsed = parseHeavyArgs(run.argv);
  if ('error' in parsed) {
    run.stderr(`heavy: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const [file, ...rest] = parsed.command as [string, ...string[]];
  const childEnv = { ...run.env, [HELD_VARIABLE]: '1' };

  // A signal while waiting ends the wait; once the command runs it is passed on to it.
  const abort = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  let received: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    received = signal;
    if (child) child.kill(signal);
    else abort.abort();
  };
  const onInt = (): void => onSignal('SIGINT');
  const onTerm = (): void => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const signalStatus = (signal: NodeJS.Signals): number => 128 + (constants.signals[signal] ?? 0);

  let lock: HeavyLock | undefined;
  let waited = false;
  try {
    if (run.env[HELD_VARIABLE] !== '1') {
      try {
        lock = await acquireHeavyLock({
          dir: run.env.PROJECTMAN_HEAVY_LOCK_DIR || defaultHeavyLockDir(),
          label: (parsed.label ?? `${basename(run.cwd)}: ${parsed.command.join(' ')}`).slice(0, LABEL_MAX),
          cwd: run.cwd,
          ...(run.env.PROJECTMAN_SESSION_ID ? { sessionId: run.env.PROJECTMAN_SESSION_ID } : {}),
          ...(parsed.maxWaitSeconds !== undefined ? { maxWaitMs: parsed.maxWaitSeconds * 1000 } : {}),
          signal: abort.signal,
          onWait: (wait) => {
            waited = true;
            run.stderr(waitingLine(wait));
          },
        });
        if (waited) run.stderr(`heavy: started after ${formatDuration(lock.waitedMs)}\n`);
      } catch (err) {
        if (received) return signalStatus(received);
        if (err instanceof HeavyLockError && err.code === 'heavy_lock_timeout') {
          run.stderr(`heavy: ${err.message}\n`);
          return EXIT_QUEUE_TIMEOUT;
        }
        // Nothing is ever held back because of the lock: without it the command runs.
        if (err instanceof HeavyLockError) run.stderr(`heavy: ${err.message}; running without the queue\n`);
        else throw err;
      }
    }
    return await new Promise<number>((resolve) => {
      child = spawn(file, rest, { stdio: 'inherit', env: childEnv });
      child.on('error', (err: NodeJS.ErrnoException) => {
        run.stderr(`heavy: cannot run ${file}: ${err.message}\n`);
        resolve(err.code === 'ENOENT' ? EXIT_NOT_FOUND : 126);
      });
      child.on('close', (code, signal) => resolve(code ?? (signal ? signalStatus(signal) : 1)));
    });
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    await lock?.release();
  }
}
