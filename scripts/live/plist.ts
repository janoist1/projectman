import { servicePathEnv } from '../engine/service';
import {
  DEFAULT_SHUTDOWN_PAUSE_MS,
  launcherFile,
  LiveError,
  SERVER_LABEL,
  SERVER_LAUNCHER,
  WATCHER_LABEL,
  WATCHER_LAUNCHER,
} from './paths';

/**
 * The two LaunchAgent files of the live instance (PM-493), written from code with every value escaped:
 * the list of environment variables changes with the installing shell, so there is no template. launchd
 * gives a job no shell environment, so the files name exactly what the job needs and nothing else: no
 * billing variable, no integrator key, and no `PROJECTMAN_VERSION`, which would falsify the commit the
 * watcher compares (`appVersion`).
 */

/** Taken from the installing shell when they are set there. */
export const PASSED_VARIABLES = [
  'HOST',
  'LOG_LEVEL',
  'CLAUDE_BIN',
  'CODEX_BIN',
  'GH_BIN',
  'GH_HOST',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'PROJECTMAN_BROWSERS_PATH',
  'PROJECTMAN_HEAVY_LOCK_DIR',
  'PROJECTMAN_WORKSPACES',
  'PROJECTMAN_TERMINAL',
  'PROJECTMAN_CLIENT_IP_HEADER',
  'PROJECTMAN_FEEDBACK_PUBLIC_URL',
  'PROJECTMAN_SHUTDOWN_PAUSE_MS',
  'PROJECTMAN_CLONE_DEPENDENCIES',
] as const;

export const xmlEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const unescapeXml = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * The first strings of an installed file's `ProgramArguments`, unescaped. Since PM-514 the first is the
 * launcher and the second node; a file from PM-493 starts with node itself.
 */
export function installedProgramArguments(plist: string): string[] | null {
  const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  if (!block) return null;
  return [...block[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => unescapeXml(match[1]!));
}

type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function render(value: PlistValue, indent: string): string {
  if (typeof value === 'string') return `${indent}<string>${xmlEscape(value)}</string>`;
  if (typeof value === 'number') return `${indent}<integer>${value}</integer>`;
  if (typeof value === 'boolean') return `${indent}<${value}/>`;
  if (Array.isArray(value))
    return [
      `${indent}<array>`,
      ...value.map((item) => render(item, `${indent}  `)),
      `${indent}</array>`,
    ].join('\n');
  return [
    `${indent}<dict>`,
    ...Object.entries(value).flatMap(([key, item]) => [
      `${indent}  <key>${xmlEscape(key)}</key>`,
      render(item, `${indent}  `),
    ]),
    `${indent}</dict>`,
  ].join('\n');
}

export function renderPlistFile(dict: { [key: string]: PlistValue }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    render(dict, ''),
    '</plist>',
    '',
  ].join('\n');
}

/** How long launchd waits for the server to stop on its own: the shutdown pause, and 30 seconds. */
export function exitTimeoutSeconds(env: NodeJS.ProcessEnv): number {
  const raw = env.PROJECTMAN_SHUTDOWN_PAUSE_MS?.trim();
  const ms = raw === undefined || raw === '' ? DEFAULT_SHUTDOWN_PAUSE_MS : Number(raw);
  if (!Number.isInteger(ms) || ms < 0)
    throw new LiveError(`PROJECTMAN_SHUTDOWN_PAUSE_MS must be a number of milliseconds, not "${raw}"`, 2);
  return Math.ceil(ms / 1000) + 30;
}

/** The `ExitTimeOut` of an installed server plist, or null. */
export function installedExitTimeout(plist: string): number | null {
  const match = /<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist);
  return match ? Number(match[1]) : null;
}

export interface ServerPlistInput {
  nodePath: string;
  root: string;
  home: string;
  /** The HOME of the user the job runs as. */
  userHome: string;
  port: number;
  /** `<project key>/<repository>`. */
  target: string;
  /** The installing shell's environment. */
  env: NodeJS.ProcessEnv;
  logFile: string;
}

interface BuiltPlist {
  text: string;
  /** The names (never the values) of the variables the file carries. */
  variables: string[];
}

/** The environment of the live server: an allowlist, built from the installing shell's. */
function serverEnvironment(input: ServerPlistInput): Record<string, string> {
  const mode = input.env.PROJECTMAN_MODE?.trim();
  if (mode !== undefined && mode !== '' && mode !== 'single')
    throw new LiveError(
      `PROJECTMAN_MODE=${mode}: the live watcher serves a single-mode instance. In a hybrid installation the engine would have to be switched too, which is not part of it.`,
      2,
    );
  const pathEnv = servicePathEnv(input.env.PATH ?? '');
  if (!pathEnv) throw new LiveError('PATH is empty: the sessions could not find their CLIs.', 2);
  const environment: Record<string, string> = {
    PATH: pathEnv,
    HOME: input.userHome,
    PORT: String(input.port),
    PROJECTMAN_HOME: input.home,
    PROJECTMAN_RELEASE_TARGET: input.target,
  };
  for (const name of PASSED_VARIABLES) {
    const value = input.env[name];
    if (value !== undefined && value !== '') environment[name] = value;
  }
  return environment;
}

/**
 * The server runs `node dist/index.js` itself, not `npm start`: launchd's SIGTERM reaches the server
 * (the Linux unit's `KillMode=mixed`).
 */
export function buildServerPlist(input: ServerPlistInput): BuiltPlist {
  const environment = serverEnvironment(input);
  const text = renderPlistFile({
    Label: SERVER_LABEL,
    ProgramArguments: [
      launcherFile(input.root, SERVER_LAUNCHER),
      input.nodePath,
      `${input.root}/apps/server/dist/index.js`,
    ],
    WorkingDirectory: `${input.root}/apps/server`,
    EnvironmentVariables: environment,
    RunAtLoad: true,
    KeepAlive: true,
    ThrottleInterval: 10,
    ExitTimeOut: exitTimeoutSeconds(input.env),
    StandardOutPath: input.logFile,
    StandardErrorPath: input.logFile,
  });
  return { text, variables: Object.keys(environment) };
}

export interface WatcherPlistInput {
  nodePath: string;
  root: string;
  home: string;
  userHome: string;
  port: number;
  remote: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
}

/** The watcher: launchd starts it every minute and never a second one while it runs (no KeepAlive). */
export function buildWatcherPlist(input: WatcherPlistInput): BuiltPlist {
  const pathEnv = servicePathEnv(input.env.PATH ?? '');
  if (!pathEnv) throw new LiveError('PATH is empty: the watcher could not find git, npm and gh.', 2);
  const environment: Record<string, string> = { PATH: pathEnv, HOME: input.userHome };
  const lockDir = input.env.PROJECTMAN_HEAVY_LOCK_DIR;
  if (lockDir !== undefined && lockDir !== '') environment.PROJECTMAN_HEAVY_LOCK_DIR = lockDir;
  const text = renderPlistFile({
    Label: WATCHER_LABEL,
    ProgramArguments: [
      launcherFile(input.root, WATCHER_LAUNCHER),
      input.nodePath,
      '--import',
      'tsx',
      `${input.root}/scripts/live/cli.ts`,
      'watch',
      '--root',
      input.root,
      '--home',
      input.home,
      '--port',
      String(input.port),
      '--remote',
      input.remote,
    ],
    WorkingDirectory: input.root,
    EnvironmentVariables: environment,
    RunAtLoad: true,
    StartInterval: 60,
    StandardOutPath: input.logFile,
    StandardErrorPath: input.logFile,
  });
  return { text, variables: Object.keys(environment) };
}
