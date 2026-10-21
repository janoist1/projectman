import { createHash } from 'node:crypto';
import { execCommand } from '../exec';
import { AdministrationSetupError } from './secure-fs';
import type { SupervisorConfig } from './schemas';

/**
 * The only way the supervisor touches the machine's service manager (PM-763). The binaries are fixed absolute
 * paths, the arguments are built from the protected configuration (never from a request), no shell is used and
 * the environment is minimal. `run` is injectable so the tests drive a fake launchctl and a fake systemctl.
 */

export interface RunResult {
  exitCode: number;
  stdout: string;
}
export type RunCommand = (
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBytes?: number },
) => Promise<RunResult>;

export interface ServiceProbe {
  running: boolean;
  /** Changes whenever the service starts anew; null when it is not running. */
  bootId: string | null;
}

export interface ServiceController {
  readonly kind: 'launchd' | 'systemd';
  probe(): Promise<ServiceProbe>;
  /** Asks the service manager to restart the one configured service; resolves when the command was accepted. */
  restart(): Promise<void>;
  /** The process id of the running service's main process, or null; the process cleanup never touches it (PM-886). */
  mainPid?(): Promise<number | null>;
}

const COMMAND_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MINIMAL_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' } as const;

export const LAUNCHCTL = '/bin/launchctl';
export const PS = '/bin/ps';
export const SYSTEMCTL = '/usr/bin/systemctl';

/** The real runner: the shared exec helper with an absolute binary, a minimal environment and a bounded output. */
export const runCommand: RunCommand = async (file, args, { timeoutMs, maxBytes }) => {
  try {
    const { exitCode, stdout } = await execCommand(file, args, {
      env: { ...MINIMAL_ENV },
      timeoutMs,
      maxOutputBytes: maxBytes ?? MAX_OUTPUT_BYTES,
      okExitCodes: 'any',
    });
    return { exitCode, stdout };
  } catch {
    throw new Error('the service manager command could not run');
  }
};

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

function launchdController(label: string, uid: number | null, run: RunCommand): ServiceController {
  // No guessed user: launchd's per-user domain needs the real uid, and a platform without one has no launchd.
  if (uid === null) throw new AdministrationSetupError('unsupported', 'launchd needs the numeric user id');
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  return {
    kind: 'launchd',
    async probe() {
      const printed = await run(LAUNCHCTL, ['print', target], { timeoutMs: COMMAND_TIMEOUT_MS });
      if (printed.exitCode !== 0) return { running: false, bootId: null };
      const pid = /^\s*pid = (\d{1,10})\s*$/m.exec(printed.stdout)?.[1];
      if (!pid) return { running: false, bootId: null };
      // pid plus the process start time: a restart that reuses the pid still changes the start time.
      const started = await run(PS, ['-o', 'lstart=', '-p', pid], { timeoutMs: COMMAND_TIMEOUT_MS });
      if (started.exitCode !== 0) return { running: false, bootId: null };
      return { running: true, bootId: `launchd-${hash(`${pid}|${started.stdout.trim()}`)}` };
    },
    async restart() {
      const result = await run(LAUNCHCTL, ['kickstart', '-k', target], { timeoutMs: COMMAND_TIMEOUT_MS });
      if (result.exitCode !== 0) throw new Error('the service manager refused the restart');
    },
    async mainPid() {
      const printed = await run(LAUNCHCTL, ['print', target], { timeoutMs: COMMAND_TIMEOUT_MS });
      const pid = printed.exitCode === 0 ? /^\s*pid = (\d{1,10})\s*$/m.exec(printed.stdout)?.[1] : undefined;
      return pid ? Number(pid) : null;
    },
  };
}

function systemdController(unit: string, run: RunCommand): ServiceController {
  return {
    kind: 'systemd',
    async probe() {
      const shown = await run(
        SYSTEMCTL,
        ['show', '--property=ActiveState', '--property=InvocationID', unit],
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
      if (shown.exitCode !== 0) return { running: false, bootId: null };
      const state = /^ActiveState=(\w+)$/m.exec(shown.stdout)?.[1];
      const invocation = /^InvocationID=([0-9a-f]{32})$/m.exec(shown.stdout)?.[1];
      if (state !== 'active' || !invocation) return { running: false, bootId: null };
      return { running: true, bootId: `systemd-${invocation}` };
    },
    async restart() {
      const result = await run(SYSTEMCTL, ['restart', unit], { timeoutMs: COMMAND_TIMEOUT_MS });
      if (result.exitCode !== 0) throw new Error('the service manager refused the restart');
    },
    async mainPid() {
      const shown = await run(SYSTEMCTL, ['show', '--property=MainPID', unit], {
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      const pid = shown.exitCode === 0 ? /^MainPID=(\d{1,10})$/m.exec(shown.stdout)?.[1] : undefined;
      return pid && Number(pid) > 0 ? Number(pid) : null;
    },
  };
}

/** The controller of the configured service, or null when the host's service manager is the other kind. */
export function createServiceController(
  config: Pick<SupervisorConfig, 'service'>,
  platform: NodeJS.Platform,
  options: { run?: RunCommand; uid?: number | null } = {},
): ServiceController | null {
  const run = options.run ?? runCommand;
  const uid =
    options.uid === undefined
      ? typeof process.getuid === 'function'
        ? process.getuid()
        : null
      : options.uid;
  if (config.service.kind === 'launchd')
    return platform === 'darwin' ? launchdController(config.service.label, uid, run) : null;
  return platform === 'linux' ? systemdController(config.service.unit, run) : null;
}
