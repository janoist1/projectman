import path from 'node:path';
import { CloudError } from '../cloud/errors';
import { ensureStateDir, existingStateDir, loadHybridReleaseConfig } from './config';
import type { LoadedHybridConfig } from './config';
import { HybridCoordinator } from './coordinator';
import { acquireLocalLock, JournalStore } from './journal';
import type { JournalPort } from './journal';
import { FAILURES } from './messages';
import { ControlError, RoundStopped } from './ports';
import type { CoordinatorPorts, RoundResult } from './ports';
import { installWatcher, uninstallWatcher } from './service';
import type { WatcherDeps } from './service';
import { clearLastError, readStatus, sanitizeMessage, writeLastError } from './status';

/**
 * `npm run release -- plan|watch|install|status|uninstall --config <file>` (PM-751). The commands take the outside
 * world as an argument, so their tests run against a fake world (no launchd, no AWS, no git remote).
 *
 * Exit status: 0 done or nothing to do (also a release that is live with only its publish pending), 1 an operational
 * failure (also a release that was rolled back and verified), 2 a safety, precondition or recovery refusal, 64 bad usage.
 */

export const USAGE = `usage: npm run release -- <command> --config <file>
commands:
  plan        read the state and print what a round would do; writes nothing, builds nothing
  watch       run one foreground round (the LaunchAgent runs this every minute)
  install     install the LaunchAgent that runs the watch round (from the stable admin checkout)
  status      print the watcher's state as one JSON line
  uninstall   unload and remove the LaunchAgent; the state directory and the journal stay
options:
  --config <file>   the hybrid release configuration, an absolute path inside ~/.config/projectman/cloud
exit status: 0 done or nothing to do, 1 failed (also a verified rollback), 2 refused (a precondition is missing or recovery is needed), 64 bad usage
`;

export const COMMANDS = ['plan', 'watch', 'install', 'status', 'uninstall'] as const;
export type ReleaseCommand = (typeof COMMANDS)[number];

export interface PortsInput {
  loaded: LoadedHybridConfig;
  journal: JournalPort;
  signal: AbortSignal;
  log: (line: string) => void;
}

export interface ReleaseDeps {
  watcher: WatcherDeps;
  /** The admin checkout this code runs from. */
  root: string;
  err(text: string): void;
  /** Reads and checks the configuration (the tests give a prepared one). */
  load?(file: string): LoadedHybridConfig;
  /** The real ports of one round; the tests give the fake world's. */
  ports(input: PortsInput): CoordinatorPorts;
  /** Runs `handler` on SIGINT or SIGTERM; returns how to stop listening. */
  onInterrupt(handler: () => void): () => void;
}

class UsageError extends Error {}

function parse(argv: string[]): { command: ReleaseCommand; configFile: string } {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command))
    throw new UsageError('an unknown command');
  let configFile: string | null = null;
  for (let at = 0; at < rest.length; at += 1) {
    if (rest[at] !== '--config' || configFile !== null) throw new UsageError(`an unknown or repeated option`);
    const value = rest[at + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError('--config needs a file');
    configFile = value;
    at += 1;
  }
  if (configFile === null) throw new UsageError('--config is required');
  if (!path.isAbsolute(configFile)) throw new UsageError('--config must be an absolute path');
  return { command: command as ReleaseCommand, configFile };
}

interface Failure {
  exit: 1 | 2 | 64;
  code: string;
  message: string;
}

/** What an escaped error becomes: a code and a short text; a raw error never reaches the terminal or `status`. */
export function classify(error: unknown): Failure {
  if (error instanceof CloudError)
    return {
      exit: error.exitCode,
      code: error.exitCode === 2 ? 'refused' : 'cloud_error',
      message: error.message,
    };
  if (error instanceof RoundStopped) return { exit: 1, code: error.code, message: error.message };
  if (error instanceof ControlError) return { exit: 1, code: error.code, message: error.message };
  return { exit: 1, code: 'internal_error', message: 'the release command failed unexpectedly' };
}

function exitOf(result: RoundResult): 0 | 1 | 2 {
  switch (result.status) {
    case 'idle':
    case 'live':
      return 0;
    case 'rolled_back':
    case 'failed':
      return 1;
    case 'recovery_required':
      return 2;
  }
}

function describe(result: RoundResult): string {
  switch (result.status) {
    case 'idle':
      return 'no release to deploy';
    case 'live':
      return `release ${result.releaseId} is live${result.publishPending ? '; its publish is pending' : ''}`;
    case 'rolled_back':
    case 'failed':
    case 'recovery_required':
      return `release ${result.releaseId}: ${result.status}: ${result.code}: ${FAILURES[result.code].message}`;
  }
}

async function withInterrupt<T>(deps: ReleaseDeps, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stopListening = deps.onInterrupt(() => controller.abort());
  try {
    return await body(controller.signal);
  } finally {
    stopListening();
  }
}

async function plan(deps: ReleaseDeps, loaded: LoadedHybridConfig): Promise<number> {
  return withInterrupt(deps, async (signal) => {
    // Nothing is created: the journal is only read, and the plan never takes the lock.
    const ports = deps.ports({
      loaded,
      journal: new JournalStore(loaded.config.stateDir),
      signal,
      log: (line) => deps.watcher.out(`${line}\n`),
    });
    const report = await new HybridCoordinator(ports).plan();
    deps.watcher.out(`${JSON.stringify(report)}\n`);
    return report.state === 'blocked' ? 2 : 0;
  });
}

async function watch(deps: ReleaseDeps, loaded: LoadedHybridConfig): Promise<number> {
  const stateDir = ensureStateDir(loaded);
  const lock = acquireLocalLock(stateDir);
  try {
    return await withInterrupt(deps, async (signal) => {
      const ports = deps.ports({
        loaded,
        journal: new JournalStore(stateDir),
        signal,
        log: (line) => deps.watcher.out(`${line}\n`),
      });
      try {
        const result = await new HybridCoordinator(ports).round();
        if (result.status === 'idle' || result.status === 'live') clearLastError(stateDir);
        else
          writeLastError(
            stateDir,
            { code: result.code, message: FAILURES[result.code].message },
            deps.watcher.now(),
          );
        deps.watcher.out(`${describe(result)}\n`);
        return exitOf(result);
      } catch (error) {
        const failure = classify(error);
        writeLastError(stateDir, { code: failure.code, message: failure.message }, deps.watcher.now());
        throw error;
      }
    });
  } finally {
    lock.release();
  }
}

export async function runRelease(argv: string[], deps: ReleaseDeps): Promise<number> {
  if (argv[0] === 'help' || argv[0] === '--help') {
    deps.watcher.out(USAGE);
    return 0;
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    deps.err(`${error instanceof UsageError ? error.message : 'bad usage'}\n${USAGE}`);
    return 64;
  }
  try {
    // A bad or missing configuration ends here, before anything is armed or touched.
    const loaded = deps.load
      ? deps.load(parsed.configFile)
      : loadHybridReleaseConfig(parsed.configFile, deps.watcher.homeDir);
    switch (parsed.command) {
      case 'plan':
        return await plan(deps, loaded);
      case 'watch':
        return await watch(deps, loaded);
      case 'install':
        await installWatcher(deps.watcher, { root: deps.root, loaded });
        return 0;
      case 'uninstall':
        await uninstallWatcher(deps.watcher, loaded);
        return 0;
      case 'status':
        deps.watcher.out(`${JSON.stringify(await readStatus(deps.watcher, existingStateDir(loaded)))}\n`);
        return 0;
    }
  } catch (error) {
    const failure = classify(error);
    deps.err(`${failure.exit === 2 ? 'refused' : 'failed'}: ${sanitizeMessage(failure.message)}\n`);
    return failure.exit;
  }
}
