import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineConfigError } from '../../apps/server/src/engine-link/engine-config';

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
  /** The checkout the engine runs from (the repository root). */
  root: string;
  /** The absolute path of `node` (`process.execPath` at install time). */
  nodePath: string;
  /** The `PATH` the sessions' CLIs are found on (the installing shell's, written at install time). */
  pathEnv: string;
  /** `~/Library/LaunchAgents`. */
  agentsDir: string;
  /** The numeric user id: the domain is `gui/<uid>`. */
  uid: number;
  launchctl: (args: string[]) => LaunchctlResult;
  platform: NodeJS.Platform;
  out: (text: string) => void;
  /** Waits between the retries of `bootstrap` (default: a blocking wait; tests pass a no-op). */
  sleep?: (ms: number) => void;
}

/** launchctl's "5: Input/output error": the old job is still being torn down; a short wait cures it. */
const BOOTSTRAP_BUSY = 5;
const BOOTSTRAP_TRIES = 5;
const BOOTSTRAP_WAIT_MS = 500;

const blockingSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * `npm run engine` puts the checkout's `node_modules/.bin` folders in front of PATH; they are the installing
 * run's, not the sessions' tools, and would be written into the file. They are left out.
 */
export function servicePathEnv(pathEnv: string): string {
  return pathEnv
    .split(path.delimiter)
    .filter((entry) => entry !== '' && !entry.endsWith(path.join('node_modules', '.bin')))
    .join(path.delimiter);
}

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface PlistValues {
  label: string;
  node: string;
  root: string;
  path: string;
  home: string;
  logOut: string;
  logErr: string;
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
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, name: string) => {
    const value = map[name];
    if (value === undefined) throw new Error(`the plist template names an unknown placeholder {{${name}}}`);
    return xml(value);
  });
}

export function servicePaths(options: Pick<ServiceOptions, 'home' | 'agentsDir'>) {
  return {
    plist: path.join(options.agentsDir, `${SERVICE_LABEL}.plist`),
    logOut: path.join(options.home, 'logs', 'engine-service.out.log'),
    logErr: path.join(options.home, 'logs', 'engine-service.err.log'),
  };
}

const domainTarget = (uid: number) => `gui/${uid}/${SERVICE_LABEL}`;

/** The `PROJECTMAN_HOME` an installed plist names, or null. */
function installedHome(plist: string): string | null {
  const match = /<key>PROJECTMAN_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
  return match
    ? match[1]!
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
    : null;
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

/** Writes the LaunchAgent and loads it; an installed one for the same home is replaced. */
export function installService(options: ServiceOptions): void {
  requireMac(options);
  if (!path.isAbsolute(options.nodePath) || !path.isAbsolute(options.root) || !path.isAbsolute(options.home))
    throw new EngineConfigError('service_paths', 'The node, repository and home paths must be absolute.');
  const pathEnv = servicePathEnv(options.pathEnv);
  if (!pathEnv)
    throw new EngineConfigError('service_path_env', 'PATH is empty: the sessions could not find their CLIs.');
  const templateFile = path.join(options.root, PLIST_TEMPLATE);
  if (!existsSync(templateFile))
    throw new EngineConfigError('service_template', `The plist template ${templateFile} does not exist.`);
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
      node: options.nodePath,
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
  options.launchctl(['bootout', domainTarget(options.uid)]);
  let loaded = options.launchctl(['bootstrap', `gui/${options.uid}`, paths.plist]);
  for (let tries = 1; loaded.status === BOOTSTRAP_BUSY && tries < BOOTSTRAP_TRIES; tries += 1) {
    (options.sleep ?? blockingSleep)(BOOTSTRAP_WAIT_MS);
    loaded = options.launchctl(['bootstrap', `gui/${options.uid}`, paths.plist]);
  }
  if (loaded.status !== 0)
    throw new EngineConfigError(
      'service_bootstrap',
      `launchctl bootstrap failed (${loaded.status}): ${(loaded.stderr || loaded.stdout).trim() || 'no output'}`,
    );
  options.out(`engine service installed: ${paths.plist}`);
  options.out(`it starts now and at every login; logs: ${paths.logOut}, ${paths.logErr}`);
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
