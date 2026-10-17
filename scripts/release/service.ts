import fs from 'node:fs';
import path from 'node:path';
import { refused } from '../cloud/errors';
import { servicePathEnv } from '../engine/service';
import { bootout, bootstrap, isLoaded, launchctl, waitUntil } from '../live/launchd';
import type { LaunchdDeps } from '../live/launchd';
import { installedProgramArguments, renderPlistFile } from '../live/plist';
import { agentsDir, domainTarget, plistFile } from '../live/paths';
import { ensureStateDir, isWithin } from './config';
import type { LoadedHybridConfig } from './config';
import { acquireLocalLock, hasActiveJournal } from './journal';

/**
 * The hybrid release watcher as a macOS LaunchAgent (PM-751, `npm run release -- install|uninstall|status`). Like the
 * single-target watcher's (PM-493) it is written from code with every value escaped, and launchd starts one round
 * a minute and never a second one while a round runs (no KeepAlive). The plist names exactly HOME, PATH, LANG and
 * TZ and the configuration file: no billing variable, no key, no token, and no secret path. The checkout it runs
 * from and the node it runs with are the ones recorded at install time; a plist that was not written from a stable
 * admin checkout is never produced, and nothing here replaces or removes the job while a round or an unfinished
 * journal exists.
 */

export const WATCHER_LABEL = 'com.projectman.hybrid-release-watcher';
export const WATCHER_LAUNCHER = 'projectman-hybrid-release-watcher';
export const WATCHER_LOG = 'watcher.log';
/** One round a minute. */
export const START_INTERVAL_SECONDS = 60;
/** The only variables of the job's environment, taken from the installing shell when they are set there. */
export const PLIST_ENVIRONMENT_NAMES = ['HOME', 'PATH', 'LANG', 'TZ'] as const;

export const watcherLauncher = (root: string) =>
  path.join(root, 'scripts', 'release', 'bin', WATCHER_LAUNCHER);
export const watcherCli = (root: string) => path.join(root, 'scripts', 'release', 'cli.ts');

export interface WatcherDeps extends LaunchdDeps {
  readonly platform: NodeJS.Platform;
  /** The absolute path of `node` (`process.execPath`). */
  readonly nodePath: string;
  /** The environment of the installing shell. */
  readonly env: NodeJS.ProcessEnv;
  out(text: string): void;
}

export interface WatcherPlistInput {
  root: string;
  nodePath: string;
  env: NodeJS.ProcessEnv;
  userHome: string;
  configFile: string;
  logFile: string;
}

/** The watcher's LaunchAgent file. */
export function buildWatcherPlist(input: WatcherPlistInput): string {
  const pathEnv = servicePathEnv(input.env.PATH ?? '');
  if (!pathEnv) throw refused('PATH is empty: the watcher could not find git, aws and ssh');
  const environment: Record<string, string> = { HOME: input.userHome, PATH: pathEnv };
  for (const name of ['LANG', 'TZ'] as const) {
    const value = input.env[name];
    if (value !== undefined && value !== '') environment[name] = value;
  }
  return renderPlistFile({
    Label: WATCHER_LABEL,
    ProgramArguments: [
      watcherLauncher(input.root),
      input.nodePath,
      '--import',
      'tsx',
      watcherCli(input.root),
      'watch',
      '--config',
      input.configFile,
    ],
    WorkingDirectory: input.root,
    EnvironmentVariables: environment,
    RunAtLoad: true,
    StartInterval: START_INTERVAL_SECONDS,
    StandardOutPath: input.logFile,
    StandardErrorPath: input.logFile,
  });
}

/** The configuration file an installed watcher plist names, or null. */
export function installedWatcherConfig(plist: string): string | null {
  const args = installedProgramArguments(plist);
  if (!args) return null;
  const at = args.indexOf('--config');
  return at >= 0 ? (args[at + 1] ?? null) : null;
}

function requireMac(deps: Pick<WatcherDeps, 'platform'>): void {
  if (deps.platform !== 'darwin') throw refused('the release watcher is a macOS LaunchAgent (launchd)');
}

/** The checkout and the node that a plist may name: real, absolute, and not a member's workspace. */
function assertStable(deps: WatcherDeps, root: string): void {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || root.length < 2)
    throw refused('the admin checkout must be a normalized absolute path');
  let real: string;
  try {
    real = fs.realpathSync(root);
  } catch {
    throw refused('the admin checkout does not exist');
  }
  if (real !== root) throw refused('the admin checkout path must not go through a symbolic link');
  if (isWithin(path.join(deps.homeDir, '.projectman', 'workspaces'), root))
    throw refused('the watcher must run from the stable admin checkout, not from a member workspace');
  for (const file of [watcherCli(root), watcherLauncher(root)])
    if (!fs.existsSync(file)) throw refused('the admin checkout has no hybrid release watcher');
  try {
    fs.accessSync(watcherLauncher(root), fs.constants.X_OK);
  } catch {
    throw refused('the watcher launcher is not executable');
  }
  if (!path.isAbsolute(deps.nodePath) || !fs.existsSync(deps.nodePath))
    throw refused('the node path must be an existing absolute path');
}

function writeAtomic(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o644, flag: 'w' });
  fs.chmodSync(temporary, 0o644);
  fs.renameSync(temporary, file);
}

export interface WatcherState {
  installed: boolean;
  loaded: boolean;
  running: boolean;
}

/** What launchd says about the job: the file, whether launchd knows it, whether a round runs now. */
export async function watcherState(deps: WatcherDeps): Promise<WatcherState> {
  requireMac(deps);
  const installed = fs.existsSync(plistFile(deps.homeDir, WATCHER_LABEL));
  const printed = await launchctl(deps, ['print', domainTarget(deps.uid, WATCHER_LABEL)]);
  if (printed.status !== 0) return { installed, loaded: false, running: false };
  const state = /^\s*state = (\w+)/m.exec(printed.stdout)?.[1];
  return { installed, loaded: true, running: state === 'running' || /^\s*pid = \d+/m.test(printed.stdout) };
}

/**
 * Writes the watcher's plist and loads it. A round that runs, or a journal that is not finished, refuses it: the
 * job is not replaced under a deployment. The same plist that is loaded already changes nothing.
 */
export async function installWatcher(
  deps: WatcherDeps,
  input: { root: string; loaded: LoadedHybridConfig },
): Promise<'installed' | 'unchanged'> {
  requireMac(deps);
  assertStable(deps, input.root);
  const stateDir = ensureStateDir(input.loaded);
  const text = buildWatcherPlist({
    root: input.root,
    nodePath: deps.nodePath,
    env: deps.env,
    userHome: deps.homeDir,
    configFile: input.loaded.configFile,
    logFile: path.join(stateDir, WATCHER_LOG),
  });
  const file = plistFile(deps.homeDir, WATCHER_LABEL);
  const lock = acquireLocalLock(stateDir);
  let released = false;
  const release = () => {
    if (!released) lock.release();
    released = true;
  };
  try {
    if (hasActiveJournal(stateDir))
      throw refused('a release is in progress or needs recovery: the watcher is not replaced');
    const loadedNow = await isLoaded(deps, WATCHER_LABEL);
    if (loadedNow && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return 'unchanged';
    fs.mkdirSync(agentsDir(deps.homeDir), { recursive: true });
    if (loadedNow) {
      const stopped = await bootout(deps, WATCHER_LABEL);
      if (stopped.status !== 0)
        throw refused(`launchctl bootout failed (${stopped.status}): nothing was replaced`);
    }
    writeAtomic(file, text);
    // The old job is gone and no round runs: a new one may start.
    release();
    const started = await bootstrap(deps, WATCHER_LABEL);
    if (started.status !== 0) throw refused(`launchctl bootstrap failed (${started.status})`);
    if (!(await waitUntil(deps, 10_000, () => isLoaded(deps, WATCHER_LABEL), 500)))
      throw refused('launchd did not load the watcher');
    deps.out(`release watcher installed: ${file}\n`);
    return 'installed';
  } finally {
    release();
  }
}

/** Unloads the watcher and removes its file. The state directory, the journal and the archive stay. */
export async function uninstallWatcher(
  deps: WatcherDeps,
  loaded: Pick<LoadedHybridConfig, 'config' | 'secretsRoot'>,
): Promise<'removed' | 'absent'> {
  requireMac(deps);
  const stateDir = ensureStateDir(loaded);
  const lock = acquireLocalLock(stateDir);
  try {
    if (hasActiveJournal(stateDir))
      throw refused('a release is in progress or needs recovery: the watcher is not removed');
    const file = plistFile(deps.homeDir, WATCHER_LABEL);
    const stopped = await bootout(deps, WATCHER_LABEL);
    if (stopped.status !== 0)
      throw refused(`launchctl bootout failed (${stopped.status}): nothing was removed`);
    const had = fs.existsSync(file);
    fs.rmSync(file, { force: true });
    deps.out(had ? `release watcher removed: ${file}\n` : 'no release watcher was installed\n');
    return had ? 'removed' : 'absent';
  } finally {
    lock.release();
  }
}
