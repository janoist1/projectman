import { spawn as spawnChild } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';

/**
 * PM-1086: keeps the Mac awake while the engine has work (docs/ARCHITECTURE.md "Machine-dependent
 * parts", "Keep awake while working"). It holds `/usr/bin/caffeinate` while a session, a merge check or a
 * screenshot run is active and lets go `releaseDelayMs` after the last one ended, so two jobs in a row do
 * not flicker. Everything machine-dependent (platform, pid, the process start, the clock) is injected.
 */

export type KeepAwakeMode = 'while_working' | 'off';

export interface KeepAwakeState {
  mode: KeepAwakeMode;
  holding: boolean;
  /** ISO time the current hold began. */
  since?: string;
  /** There is no way to keep this platform awake (only macOS is built). */
  unsupported?: boolean;
}

export interface KeepAwake {
  /** Called on every poll with whether any work is active. */
  update(busy: boolean): void;
  state(): KeepAwakeState;
  /** Lets go for good (the engine stops). */
  close(): void;
}

export interface KeepAwakeProcess {
  kill(signal?: NodeJS.Signals): void;
  onExit(listener: () => void): void;
}

export interface KeepAwakeOptions {
  mode: KeepAwakeMode;
  platform: NodeJS.Platform;
  enginePid: number;
  spawn: (command: string, args: string[]) => KeepAwakeProcess;
  now?: () => number;
  /** How long nothing may run before the hold ends. Default 2 minutes. */
  releaseDelayMs?: number;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
}

export const CAFFEINATE = '/usr/bin/caffeinate';
const DEFAULT_RELEASE_DELAY_MS = 120_000;
/** A caffeinate that ended by itself is started again at most this often. */
const RESTART_INTERVAL_MS = 60_000;

export function createKeepAwake(options: KeepAwakeOptions): KeepAwake {
  const now = options.now ?? Date.now;
  const releaseDelayMs = options.releaseDelayMs ?? DEFAULT_RELEASE_DELAY_MS;
  const supported = options.platform === 'darwin';
  const active = options.mode === 'while_working' && supported;
  let child: KeepAwakeProcess | null = null;
  let since: number | null = null;
  let idleSince: number | null = null;
  /** After a caffeinate ended by itself: the earliest time to start another. */
  let retryAt = 0;
  let closed = false;

  const release = () => {
    const held = child;
    child = null;
    since = null;
    idleSince = null;
    retryAt = 0;
    try {
      held?.kill('SIGTERM');
    } catch {
      // It is gone already.
    }
  };

  const lost = (gone: KeepAwakeProcess, startedAt: number) => {
    if (child !== gone) return; // released on purpose
    child = null;
    since = null;
    idleSince = null;
    retryAt = startedAt + RESTART_INTERVAL_MS;
    options.log.warn('caffeinate ended by itself; it is started again while work runs');
  };

  const start = () => {
    const startedAt = now();
    if (startedAt < retryAt) return;
    let started: KeepAwakeProcess;
    try {
      started = options.spawn(CAFFEINATE, ['-i', '-s', '-w', String(options.enginePid)]);
    } catch {
      retryAt = startedAt + RESTART_INTERVAL_MS;
      options.log.warn('caffeinate could not be started');
      return;
    }
    child = started;
    since = startedAt;
    idleSince = null;
    started.onExit(() => lost(started, startedAt));
    options.log.info('keeping the machine awake while work runs');
  };

  return {
    update(busy) {
      if (!active || closed) return;
      if (busy) {
        idleSince = null;
        if (!child) start();
        return;
      }
      if (!child) return;
      idleSince ??= now();
      if (now() - idleSince >= releaseDelayMs) {
        release();
        options.log.info('no work is running; the machine may sleep again');
      }
    },
    state: () => ({
      mode: options.mode,
      holding: child !== null,
      ...(since !== null ? { since: new Date(since).toISOString() } : {}),
      ...(supported ? {} : { unsupported: true }),
    }),
    close() {
      closed = true;
      release();
    },
  };
}

/** The real process start: `caffeinate` runs on its own, and an exit or a failed start both count as an exit. */
export function spawnKeepAwakeProcess(command: string, args: string[]): KeepAwakeProcess {
  const child = spawnChild(command, args, { stdio: 'ignore' });
  child.unref();
  return {
    kill: (signal) => void child.kill(signal),
    onExit(listener) {
      child.once('exit', listener);
      child.once('error', listener);
    },
  };
}
