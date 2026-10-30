import { servicePathEnv } from '../engine/service';
import { DEFAULT_SHUTDOWN_PAUSE_MS, launcherFile, LiveError, SERVER_LABEL, SERVER_LAUNCHER } from './paths';

/**
 * The LaunchAgent file of the live instance (PM-493), written from code with every value escaped:
 * the list of environment variables changes with the installing shell, so there is no template. launchd
 * gives a job no shell environment, so the files name exactly what the job needs and nothing else: no
 * billing variable, no integrator key, and no `PROJECTMAN_VERSION`, which would falsify the running commit (`appVersion`).
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

const unescapeXml = (value: string): string =>
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

function renderPlistFile(dict: { [key: string]: PlistValue }): string {
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
    throw new LiveError(`PROJECTMAN_MODE=${mode}: the live service serves a single-mode instance.`, 2);
  const pathEnv = servicePathEnv(input.env.PATH ?? '');
  if (!pathEnv) throw new LiveError('PATH is empty: the sessions could not find their CLIs.', 2);
  const environment: Record<string, string> = {
    PATH: pathEnv,
    HOME: input.userHome,
    PORT: String(input.port),
    PROJECTMAN_HOME: input.home,
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
