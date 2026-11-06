import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineConfigError } from '../../apps/server/src/engine-link/engine-config';
import { ENGINE_PACKAGE_FILE, readEnginePackage } from '../../apps/server/src/engine-link/engine-package';
import { engineStartCommand } from './start-command';

/**
 * The engine as a macOS LaunchAgent (PM-318, `npm run engine -- service install|uninstall|status`). It
 * fills `deploy/mac/com.projectman.engine.plist` with the absolute paths of this machine, writes it to
 * `~/Library/LaunchAgents` and loads it into the user's `gui` domain with `launchctl`. launchd gives the
 * job no shell environment: the file names exactly PATH, `PROJECTMAN_MODE` and `PROJECTMAN_HOME`, so no
 * billing variable and no `PROJECTMAN_INTEGRATOR_KEY` reaches the engine. Everything that touches the
 * machine (`launchctl`, the directories, the node binary) is injected, so tests run without launchd.
 */

export const SERVICE_LABEL = 'com.projectman.engine';
export const PLIST_TEMPLATE = path.join('deploy', 'mac', `${SERVICE_LABEL}.plist`);

export interface LaunchctlResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ServiceOptions {
  /** The engine's home (`PROJECTMAN_HOME`); its `logs/` takes the service's output. */
  home: string;
  /** The checkout or extracted package the engine runs from. */
  root: string;
  /** The absolute path of `node` (`process.execPath` at install time). */
  nodePath: string;
  /** The `PATH` the sessions' CLIs are found on (the installing shell's, written at install time). */
  pathEnv: string;
  /** A switch preserves absolute installed PATH entries, including deliberate local customization. */
  preservePathEnv?: boolean;
  /** `~/Library/LaunchAgents`. */
  agentsDir: string;
  /** The numeric user id: the domain is `gui/<uid>`. */
  uid: number;
  launchctl: (args: string[]) => LaunchctlResult;
  platform: NodeJS.Platform;
  out: (text: string) => void;
  /** Waits between the retries of `bootstrap` and the polls for an exiting engine (default: a timer; tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Whether a process is alive; `stop` waits for the engine's pid with it (default: `kill(pid, 0)`). */
  isRunning?: (pid: number) => boolean;
  /** How many times `bootstrap` is tried while launchd still tears the old job down (default 5; PM-751 waits longer). */
  bootstrapTries?: number;
}

/** launchctl's "5: Input/output error": the old job is still being torn down; a short wait cures it. */
const BOOTSTRAP_BUSY = 5;
const BOOTSTRAP_TRIES = 5;
const BOOTSTRAP_WAIT_MS = 500;

const timerSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** launchd must never resolve relative PATH entries against the service's working directory. */
function absolutePathEntries(pathEnv: string): string[] {
  return pathEnv.split(path.delimiter).filter((entry) => entry !== '' && path.isAbsolute(entry));
}

/** Leave out the installing npm run's node_modules/.bin folders as well. */
export function servicePathEnv(pathEnv: string): string {
  return absolutePathEntries(pathEnv)
    .filter((entry) => !entry.endsWith(path.join('node_modules', '.bin')))
    .join(path.delimiter);
}

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface PlistValues {
  label: string;
  node: string;
  root: string;
  path: string;
  home: string;
  logOut: string;
  logErr: string;
  executable?: string;
}

/** Fills the template; a placeholder the values do not know is an error, so a typo cannot ship. */
export function renderPlist(template: string, values: PlistValues): string {
  const map: Record<string, string> = {
    LABEL: values.label,
    NODE: values.node,
    ROOT: values.root,
    PATH: values.path,
    HOME: values.home,
    LOG_OUT: values.logOut,
    LOG_ERR: values.logErr,
    EXECUTABLE: values.executable ?? values.node,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, name: string) => {
    const value = map[name];
    if (value === undefined) throw new Error(`the plist template names an unknown placeholder {{${name}}}`);
    return xml(value);
  });
}

/** Where the service writes its output (the plist's `StandardOutPath` and `StandardErrorPath`). */
export function serviceLogPaths(home: string) {
  return {
    logOut: path.join(home, 'logs', 'engine-service.out.log'),
    logErr: path.join(home, 'logs', 'engine-service.err.log'),
  };
}

export function servicePaths(options: Pick<ServiceOptions, 'home' | 'agentsDir'>) {
  return {
    plist: path.join(options.agentsDir, `${SERVICE_LABEL}.plist`),
    ...serviceLogPaths(options.home),
  };
}

const domainTarget = (uid: number) => `gui/${uid}/${SERVICE_LABEL}`;

/** A string setting in the installed XML plist, with the template's entities decoded. */
export function plistString(
  plist: string,
  key: 'PROJECTMAN_HOME' | 'WorkingDirectory' | 'PATH',
): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  return match
    ? match[1]!
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
    : null;
}

const installedHome = (plist: string) => plistString(plist, 'PROJECTMAN_HOME');

export function serviceInstallation(plist: string) {
  const root = plistString(plist, 'WorkingDirectory');
  const manager =
    root && existsSync(path.join(root, ENGINE_PACKAGE_FILE)) ? ('app' as const) : ('checkout' as const);
  const manifest = root ? readEnginePackage(root) : null;
  return {
    manager,
    package: manifest && root ? { version: manifest.version, tag: manifest.tag, root } : null,
  };
}

/**
 * The LaunchAgent file that starts the engine on this home, or null. The way back and the activation look
 * here, because a loaded job restarts the engine 30 seconds after every exit (`KeepAlive`).
 */
export function installedServiceFor(home: string, agentsDir?: string): string | null {
  const plist = servicePaths({
    home,
    agentsDir: agentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents'),
  }).plist;
  if (!existsSync(plist)) return null;
  return installedHome(readFileSync(plist, 'utf8')) === path.resolve(home) ? plist : null;
}

function requireMac(options: ServiceOptions): void {
  if (options.platform !== 'darwin')
    throw new EngineConfigError(
      'service_unsupported',
      'The engine service is a macOS LaunchAgent (launchd).',
    );
}

/**
 * Writes the LaunchAgent and loads it; an installed one for the same home is replaced. The old engine is
 * waited for between the unload and the load: it pauses its sessions first (`ExitTimeOut`), and a job loaded
 * meanwhile would start a second engine on the same home or give up on launchd's busy answer.
 */
export async function installService(options: ServiceOptions): Promise<void> {
  requireMac(options);
  if (!path.isAbsolute(options.nodePath) || !path.isAbsolute(options.root) || !path.isAbsolute(options.home))
    throw new EngineConfigError('service_paths', 'The node, repository and home paths must be absolute.');
  const pathEnv = options.preservePathEnv
    ? absolutePathEntries(options.pathEnv).join(path.delimiter)
    : servicePathEnv(options.pathEnv);
  if (!pathEnv)
    throw new EngineConfigError('service_path_env', 'PATH is empty: the sessions could not find their CLIs.');
  const templateFile = path.join(options.root, PLIST_TEMPLATE);
  if (!existsSync(templateFile))
    throw new EngineConfigError('service_template', `The plist template ${templateFile} does not exist.`);
  const bundle = path.join(options.root, 'apps/server/dist/index.js');
  if (!existsSync(bundle))
    throw new EngineConfigError(
      'service_build_missing',
      'The engine has no built server: run npm run build -w @projectman/server before installing the service.',
    );
  const paths = servicePaths(options);
  if (existsSync(paths.plist)) {
    const other = installedHome(readFileSync(paths.plist, 'utf8'));
    if (other !== null && other !== options.home)
      throw new EngineConfigError(
        'service_other_home',
        `An engine service for ${other} is installed: run "npm run engine -- service uninstall" first.`,
      );
  }
  mkdirSync(path.dirname(paths.logOut), { recursive: true, mode: 0o700 });
  mkdirSync(options.agentsDir, { recursive: true });
  writeFileSync(
    paths.plist,
    renderPlist(readFileSync(templateFile, 'utf8'), {
      label: SERVICE_LABEL,
      node: engineStartCommand(options.root, options.nodePath).command,
      root: options.root,
      path: pathEnv,
      home: options.home,
      logOut: paths.logOut,
      logErr: paths.logErr,
    }),
    { mode: 0o644 },
  );
  chmodSync(paths.plist, 0o644);
  // A loaded job is unloaded first, so that the new file is the one launchd reads (the result is not an error).
  // launchd forgets the job at the bootout, so the engine to wait for is the pid read before it.
  const { pid } = serviceState(options);
  options.launchctl(['bootout', domainTarget(options.uid)]);
  await waitForExit(options, pid);
  await bootstrapJob(options, paths.plist);
  options.out(`engine service installed: ${paths.plist}`);
  options.out(`it starts now and at every login; logs: ${paths.logOut}, ${paths.logErr}`);
}

/** Loads the job; launchd's "busy" answer is retried while it still tears the old job down. */
export async function bootstrapJob(
  options: ServiceOptions,
  plist: string,
  errorCode = 'service_bootstrap',
): Promise<void> {
  let loaded = options.launchctl(['bootstrap', `gui/${options.uid}`, plist]);
  const tryLimit = options.bootstrapTries ?? BOOTSTRAP_TRIES;
  for (let tries = 1; loaded.status === BOOTSTRAP_BUSY && tries < tryLimit; tries += 1) {
    await (options.sleep ?? timerSleep)(BOOTSTRAP_WAIT_MS);
    loaded = options.launchctl(['bootstrap', `gui/${options.uid}`, plist]);
  }
  if (loaded.status !== 0)
    throw new EngineConfigError(
      errorCode,
      `launchctl bootstrap failed (${loaded.status}): ${(loaded.stderr || loaded.stdout).trim() || 'no output'}`,
    );
}

/** An installed agent of another home is not ours to touch (as with `install`). */
function refuseOtherHome(options: ServiceOptions, plist: string): void {
  if (!existsSync(plist)) return;
  const other = installedHome(readFileSync(plist, 'utf8'));
  if (other !== null && other !== path.resolve(options.home))
    throw new EngineConfigError(
      'service_other_home',
      `An engine service for ${other} is installed: this command is for ${options.home}.`,
    );
}

/** The agent's file for this home, or the refusal that tells what to do. */
function requireInstalled(options: ServiceOptions): string {
  requireMac(options);
  const { plist } = servicePaths(options);
  refuseOtherHome(options, plist);
  if (!existsSync(plist))
    throw new EngineConfigError(
      'service_not_installed',
      'No engine service is installed: run "npm run engine -- service install" first.',
    );
  return plist;
}

/** Starts the installed agent: loads it when launchd does not know it, kicks it when it is loaded but idle. */
export async function startService(options: ServiceOptions): Promise<void> {
  const plist = requireInstalled(options);
  const state = serviceState(options);
  if (state.running) {
    options.out(`engine service is already running${state.pid ? ` (pid ${state.pid})` : ''}`);
    return;
  }
  if (state.loaded) kickstart(options, false);
  else await bootstrapJob(options, plist);
  options.out('engine service started');
}

/**
 * Restarts the engine: `kickstart -k` kills the running process (the engine pauses its sessions first, which
 * the plist's `ExitTimeOut` leaves time for) and starts it again; an agent launchd does not know is started.
 */
export async function restartService(options: ServiceOptions): Promise<void> {
  const plist = requireInstalled(options);
  if (!serviceState(options).loaded) {
    await bootstrapJob(options, plist);
    options.out('engine service started');
    return;
  }
  kickstart(options, true);
  options.out('engine service restarted: the running sessions pause first, then the engine starts again');
}

function kickstart(options: ServiceOptions, kill: boolean): void {
  const result = options.launchctl(['kickstart', ...(kill ? ['-k'] : []), domainTarget(options.uid)]);
  if (result.status !== 0)
    throw new EngineConfigError(
      'service_kickstart',
      `launchctl kickstart failed (${result.status}): ${(result.stderr || result.stdout).trim() || 'no output'}`,
    );
}

/** The longest a stop waits for the engine to leave: the shutdown pause (60 s) and its cap (20 s) with margin. */
const STOP_WAIT_MS = 100_000;
const STOP_POLL_MS = 1000;

/** Waits until the engine process `pid` (read before the unload; null: none) has left; it throws after `STOP_WAIT_MS`. */
async function waitForExit(options: ServiceOptions, pid: number | null): Promise<void> {
  const sleep = options.sleep ?? timerSleep;
  const alive = options.isRunning ?? processAlive;
  for (let waited = 0; pid !== null && alive(pid); waited += STOP_POLL_MS) {
    if (waited >= STOP_WAIT_MS)
      throw new EngineConfigError(
        'service_stop_timeout',
        `The engine did not leave within ${STOP_WAIT_MS / 1000} s.`,
      );
    await sleep(STOP_POLL_MS);
  }
}

/**
 * Unloads the agent and waits until the engine process has left. launchd forgets the job at once at `bootout`,
 * so the wait is on the pid read before it, not on the job. The file stays, so the engine starts again at the
 * next login (`RunAtLoad`); `service uninstall` removes it.
 */
export async function stopService(options: ServiceOptions): Promise<void> {
  requireMac(options);
  refuseOtherHome(options, servicePaths(options).plist);
  const { pid } = serviceState(options);
  const unloaded = options.launchctl(['bootout', domainTarget(options.uid)]);
  // 3: "no such process" (not loaded); 113: could not find the service. Both mean there is nothing to unload.
  if (unloaded.status !== 0 && unloaded.status !== 3 && unloaded.status !== 113)
    throw new EngineConfigError(
      'service_bootout',
      `launchctl bootout failed (${unloaded.status}): ${(unloaded.stderr || unloaded.stdout).trim() || 'no output'}`,
    );
  await waitForExit(options, pid);
  options.out('engine service stopped; the running sessions were paused and continue when it starts again');
  options.out('the file stays: the engine starts again at the next login, or with "service start"');
}

/** Unloads the LaunchAgent and removes its file; the logs stay. Nothing installed is no error. */
export function uninstallService(options: ServiceOptions): void {
  requireMac(options);
  const paths = servicePaths(options);
  const unloaded = options.launchctl(['bootout', domainTarget(options.uid)]);
  // 3: "no such process" (not loaded); 113: could not find the service. Both mean there is nothing to unload.
  if (unloaded.status !== 0 && unloaded.status !== 3 && unloaded.status !== 113)
    throw new EngineConfigError(
      'service_bootout',
      `launchctl bootout failed (${unloaded.status}): ${(unloaded.stderr || unloaded.stdout).trim() || 'no output'}`,
    );
  const had = existsSync(paths.plist);
  rmSync(paths.plist, { force: true });
  options.out(had ? `engine service removed: ${paths.plist}` : 'no engine service was installed');
}

export interface ServiceState {
  installed: boolean;
  loaded: boolean;
  running: boolean;
  pid: number | null;
}

/** What launchd says: installed (the file), loaded (known to launchd), running (with the pid). */
export function serviceState(options: ServiceOptions): ServiceState {
  requireMac(options);
  const paths = servicePaths(options);
  const installed = existsSync(paths.plist);
  const printed = options.launchctl(['print', domainTarget(options.uid)]);
  if (printed.status !== 0) return { installed, loaded: false, running: false, pid: null };
  const pid = /^\s*pid = (\d+)/m.exec(printed.stdout)?.[1];
  const state = /^\s*state = (\w+)/m.exec(printed.stdout)?.[1];
  return {
    installed,
    loaded: true,
    running: state === 'running' || pid !== undefined,
    pid: pid ? Number(pid) : null,
  };
}

/** Prints the state; returns whether the engine is running under launchd. */
export function reportService(options: ServiceOptions): boolean {
  const state = serviceState(options);
  const paths = servicePaths(options);
  options.out(`file: ${state.installed ? paths.plist : 'not installed'}`);
  options.out(
    `launchd: ${state.loaded ? (state.running ? `running${state.pid ? ` (pid ${state.pid})` : ''}` : 'loaded, not running') : 'not loaded'}`,
  );
  return state.running;
}
