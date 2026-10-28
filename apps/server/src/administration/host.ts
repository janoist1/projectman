import { readFile, readdir } from 'node:fs/promises';
import { PS, runCommand } from './service-control';
import type { RunCommand } from './service-control';

/**
 * What the machine readers and the process cleanup need from the host operating system (PM-886). The binaries
 * are fixed absolute paths, the arguments are written in this module (never taken from a request), no shell is
 * used and the environment is the supervisor's minimal one. Everything is injectable, so the tests drive
 * fixture outputs and a fake signal sender instead of the machine.
 */

export const SYSCTL = '/usr/sbin/sysctl';
export const VM_STAT = '/usr/bin/vm_stat';
export const JOURNALCTL = '/usr/bin/journalctl';
export { PS };

const COMMAND_TIMEOUT_MS = 10_000;
/** A process list of a busy machine is far larger than a service manager's answer. */
const LIST_MAX_BYTES = 8 * 1024 * 1024;

export interface HostSystem {
  platform: NodeJS.Platform;
  /** The numeric user id of the supervisor; null where the platform has none. */
  uid: number | null;
  /** The supervisor's own process id. */
  pid: number;
  /** Runs a fixed program and returns what it printed; rejects when it fails. */
  exec(file: string, args: readonly string[]): Promise<string>;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  now(): Date;
  /** Sends a signal to one process; never to a group (a negative or zero pid is refused). */
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): 'sent' | 'gone' | 'denied';
  sleep(ms: number): Promise<void>;
}

export function createHostSystem(options: { run?: RunCommand; platform?: NodeJS.Platform } = {}): HostSystem {
  const run = options.run ?? runCommand;
  return {
    platform: options.platform ?? process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    pid: process.pid,
    async exec(file, args) {
      const result = await run(file, args, { timeoutMs: COMMAND_TIMEOUT_MS, maxBytes: LIST_MAX_BYTES });
      if (result.exitCode !== 0) throw new Error('the host command failed');
      return result.stdout;
    },
    readFile: (path) => readFile(path, 'utf8'),
    readdir: (path) => readdir(path),
    now: () => new Date(),
    kill(pid, signal) {
      if (!Number.isInteger(pid) || pid <= 1) return 'denied';
      try {
        process.kill(pid, signal);
        return 'sent';
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'denied';
      }
    },
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}

/** `[[dd-]hh:]mm:ss` (ps `etime`) in seconds, or null. */
export function parseElapsed(text: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

/** Linux: clock ticks per second and the page size; the values every supported kernel build uses. */
export const LINUX_CLOCK_TICKS = 100;
export const LINUX_PAGE_BYTES = 4096;
