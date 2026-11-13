import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeTestPlaces, placeWorkers } from '@projectman/shared';
import {
  acquireHeavyLock,
  defaultHeavyLockDir,
  heavyCommandKey,
  heavyHeldBy,
  HeavyLockError,
  machineHost,
} from '../../apps/server/src/full-test/heavy-lock';
import type { HeavyLock, PlacesRequest } from '../../apps/server/src/full-test/heavy-lock';
import {
  EXIT_ALREADY_RUNNING,
  EXIT_QUEUE_TIMEOUT,
  EXIT_QUEUE_UNAVAILABLE,
  formatDuration,
  unavailableMessage,
  waitingLine,
} from './messages';

export { EXIT_ALREADY_RUNNING, EXIT_QUEUE_UNAVAILABLE };

const EXIT_USAGE = 2;
const LABEL_MAX = 120;
const CHILD_GUARD = fileURLToPath(new URL('../lib/child-guard.mjs', import.meta.url));
/**
 * Set for everything the CLI runs: the holder's ticket. A nested call, and the server's full test, run
 * without asking for places while that holder lives (`heavyHeldBy`).
 */
const HELD_VARIABLE = 'PROJECTMAN_HEAVY_LOCK_HELD';

const USAGE =
  'usage: npm run heavy -- [--label <text>] [--max-wait <seconds>] [--places all|merge-test|<n>|<min>-<max>] [--] <command> [args...]\n';

interface HeavyArgs {
  label?: string;
  maxWaitSeconds?: number;
  places?: PlacesRequest;
  command: string[];
}

/** `all`, `3` (exactly 3) or `2-4`. */
function parsePlaces(value: string): PlacesRequest | undefined {
  if (value === 'all') return 'all';
  if (value === 'merge-test') {
    const places = mergeTestPlaces(machineHost());
    return { min: places, max: places };
  }
  const match = /^(\d+)(?:-(\d+))?$/.exec(value);
  if (!match) return undefined;
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  return min >= 1 && max >= min ? { min, max } : undefined;
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
    if (arg === '--label' || arg === '--max-wait' || arg === '--places') {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${arg} needs a value` };
      if (arg === '--label') args.label = value;
      else if (arg === '--places') {
        const places = parsePlaces(value);
        if (!places) return { error: `--places needs all, merge-test, a number or min-max, not "${value}"` };
        args.places = places;
      } else {
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

interface HeavyRun {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  stderr: (text: string) => void;
}

/** Runs the command at its turn and returns the exit status; see docs/modules/scripts.md "Heavy-run queue". */
export async function runHeavy(run: HeavyRun): Promise<number> {
  const parsed = parseHeavyArgs(run.argv);
  if ('error' in parsed) {
    run.stderr(`heavy: ${parsed.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const [file, ...rest] = parsed.command as [string, ...string[]];
  const lockDir = run.env.PROJECTMAN_HEAVY_LOCK_DIR || defaultHeavyLockDir();
  const label = (parsed.label ?? `${basename(run.cwd)}: ${parsed.command.join(' ')}`).slice(0, LABEL_MAX);

  // A signal while waiting ends the wait; once the command runs it is passed on to the guard, which
  // stops the command's whole process group (SIGTERM, then SIGKILL).
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
  const onHup = (): void => onSignal('SIGHUP');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);
  const signalStatus = (signal: NodeJS.Signals): number => 128 + (constants.signals[signal] ?? 0);

  let lock: HeavyLock | undefined;
  let waited = false;
  let childEnv: NodeJS.ProcessEnv = run.env;
  try {
    if (!(await heavyHeldBy(lockDir, run.env[HELD_VARIABLE]))) {
      try {
        lock = await acquireHeavyLock({
          dir: lockDir,
          label,
          cwd: run.cwd,
          command: heavyCommandKey(run.cwd, parsed.command),
          ...(parsed.places ? { places: parsed.places } : {}),
          ...(run.env.PROJECTMAN_SESSION_ID ? { sessionId: run.env.PROJECTMAN_SESSION_ID } : {}),
          ...(parsed.maxWaitSeconds !== undefined ? { maxWaitMs: parsed.maxWaitSeconds * 1000 } : {}),
          signal: abort.signal,
          onWait: (wait) => {
            waited = true;
            run.stderr(waitingLine(wait));
          },
        });
        if (waited) run.stderr(`heavy: started after ${formatDuration(lock.waitedMs)}\n`);
        // What the command runs under: the holder's ticket, and the workers its places allow (a caller's
        // own limit stays).
        const workers = String(placeWorkers(lock.granted, machineHost()));
        childEnv = {
          ...run.env,
          [HELD_VARIABLE]: lock.ticket,
          VITEST_MAX_FORKS: run.env.VITEST_MAX_FORKS || workers,
          VITEST_MAX_THREADS: run.env.VITEST_MAX_THREADS || workers,
        };
      } catch (err) {
        if (received) return signalStatus(received);
        if (err instanceof HeavyLockError && err.code === 'heavy_lock_duplicate') {
          run.stderr(`heavy: ${err.message}\n`);
          return EXIT_ALREADY_RUNNING;
        }
        if (err instanceof HeavyLockError && err.code === 'heavy_lock_timeout') {
          run.stderr(`heavy: ${err.message}\n`);
          return EXIT_QUEUE_TIMEOUT;
        }
        // A queue that cannot be used stops the command (owner's decision, PM-346): without it a member's
        // full test would run beside the others and overload the machine.
        if (!(err instanceof HeavyLockError)) throw err;
        run.stderr(unavailableMessage(label, err.message));
        return EXIT_QUEUE_UNAVAILABLE;
      }
    }
    // A signal that came after the lock was taken but before the command started.
    if (received) return signalStatus(received);
    // The command runs under the child guard (PM-863): it leads its own process group, and the group is
    // stopped when this process gets a signal or dies, even by SIGKILL (the guard's stdin is a pipe from
    // here). The lock is released only after the guard has gone, so the next run never overlaps leftovers.
    return await new Promise<number>((resolve) => {
      child = spawn(process.execPath, [CHILD_GUARD, file, ...rest], {
        stdio: ['pipe', 'inherit', 'inherit'],
        env: childEnv,
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        run.stderr(`heavy: cannot run ${file}: ${err.message}\n`);
        resolve(126);
      });
      child.on('close', (code, signal) => resolve(code ?? (signal ? signalStatus(signal) : 1)));
    });
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    process.off('SIGHUP', onHup);
    await lock?.release();
  }
}
