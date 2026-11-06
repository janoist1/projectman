import { basename } from 'node:path';
import { machinePlaces as capacityOf, placeWorkers } from '@projectman/shared';
import {
  acquireHeavyLock,
  defaultHeavyLockDir,
  heavyCommandKey,
  heavyHeldBy,
  HeavyLockError,
  machineHost,
} from '../../apps/server/src/full-test/heavy-lock';
import {
  EXIT_ALREADY_RUNNING,
  EXIT_QUEUE_UNAVAILABLE,
  formatDuration,
  unavailableMessage,
  waitingLine,
} from './messages';

/**
 * The places a workspace vitest run asks the machine's pool for (PM-1278): two to four, and the run
 * gives back what it cannot use once it knows how many test files it has. The worker count comes from
 * the places it holds (`placeWorkers`), so no `vitest.config.ts` counts its own.
 */
const REQUEST = { min: 2, max: 4 };
const HELD_VARIABLE = 'PROJECTMAN_HEAVY_LOCK_HELD';
/** One claim per process: with `extends: true` projects the hook runs for each of them. */
const STATE = Symbol.for('projectman.machinePlaces');

/** A worker limit the caller set (the holder CLI, the server's full test): it wins over the places. */
function callerWorkers(env) {
  for (const name of ['VITEST_MAX_THREADS', 'VITEST_MAX_FORKS']) {
    const value = Number.parseInt(env[name] ?? '', 10);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** The workers a run may use, and the places to give back once the files are known. */
async function claim(cwd, env) {
  const host = machineHost();
  const lockDir = env.PROJECTMAN_HEAVY_LOCK_DIR || defaultHeavyLockDir();
  const fixed = callerWorkers(env);
  // Something above this run holds places for it: it asks for none.
  if (await heavyHeldBy(lockDir, env[HELD_VARIABLE]))
    return { workers: fixed ?? placeWorkers(capacityOf(host), host), lock: undefined };

  let waited = false;
  try {
    const lock = await acquireHeavyLock({
      dir: lockDir,
      label: `${basename(cwd)}: vitest ${process.argv.slice(2).join(' ')}`.slice(0, 120),
      cwd,
      command: heavyCommandKey(cwd, process.argv.slice(2)),
      places: REQUEST,
      ...(env.PROJECTMAN_SESSION_ID ? { sessionId: env.PROJECTMAN_SESSION_ID } : {}),
      onWait: (wait) => {
        waited = true;
        process.stderr.write(waitingLine(wait));
      },
    });
    if (waited) process.stderr.write(`heavy: started after ${formatDuration(lock.waitedMs)}\n`);
    return { workers: fixed ?? placeWorkers(lock.granted, host), lock };
  } catch (err) {
    if (!(err instanceof HeavyLockError)) throw err;
    if (err.code === 'heavy_lock_duplicate') {
      process.stderr.write(`heavy: ${err.message}\n`);
      process.exit(EXIT_ALREADY_RUNNING);
    }
    // A pool that cannot be used stops the run (owner's decision, PM-346).
    process.stderr.write(unavailableMessage(`${basename(cwd)}: vitest`, err.message));
    process.exit(EXIT_QUEUE_UNAVAILABLE);
  }
}

/** Sets what the worker count decides: the run's workers, and the thread pool's minimum with its maximum. */
function applyWorkers(config, workers) {
  config.maxWorkers = workers;
  config.minWorkers = 1;
  config.poolOptions = {
    ...config.poolOptions,
    // The threads' minimum is their maximum: with fewer, tinypool ends an idle worker thread before it
    // has finished a file when `isolate` is off, and the run dies with "Terminating worker thread".
    threads: { ...config.poolOptions?.threads, maxThreads: workers, minThreads: workers },
    forks: { ...config.poolOptions?.forks, maxForks: workers },
  };
}

/** Vitest plugin: the run takes its places from the machine's pool before it selects and runs files. */
export function machinePlaces() {
  return {
    name: 'projectman-machine-places',
    async configureVitest({ vitest }) {
      const claimed = (globalThis[STATE] ??= claim(process.cwd(), process.env).then((result) => {
        const { lock } = result;
        if (lock) {
          process.once('exit', () => lock.releaseSync());
          vitest.onClose(() => lock.release());
        }
        return result;
      }));
      const { workers, lock } = await claimed;
      applyWorkers(vitest.config, workers);
      if (vitest.config[STATE]) return;
      vitest.config[STATE] = true;
      // The files are known when the run starts, before the pool exists: workers and places shrink to them.
      vitest.config.reporters = [
        ...vitest.config.reporters,
        {
          async onTestRunStart(specs) {
            const files = new Set(specs.map((spec) => spec.moduleId)).size;
            const used = Math.max(1, Math.min(workers, files));
            applyWorkers(vitest.config, used);
            if (lock) await lock.reduce(1 + used);
          },
        },
      ];
    },
  };
}
