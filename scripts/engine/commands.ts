import { existsSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  assertHomeNotInUse,
  cloudOrigin,
  EngineConfig,
  EngineConfigError,
  engineFiles,
  loadEngineConfig,
  resolveEngineConfig,
  saveEngineConfig,
  writeSecretFile,
} from '../../apps/server/src/engine-link/engine-config';
import { readEngineStatus } from '../../apps/server/src/engine-link/engine-status';
import type { EngineStatus } from '../../apps/server/src/engine-link/engine-status';
import { assertHomeMayStart } from '../../apps/server/src/instance';
import type { Exec } from './move-work-root';
import { LOG_LINES_DEFAULT, LOG_LINES_MAX, tailLines } from './logs';
import {
  installedServiceFor,
  installService,
  reportService,
  restartService,
  serviceLogPaths,
  serviceState,
  startService,
  stopService,
  uninstallService,
} from './service';
import type { ServiceOptions } from './service';
import { buildSnapshot } from './snapshot';
import { uninstallMenubar } from './menubar';
import type { MenubarMachine } from './menubar';
import { assertNotSwitching, switchService } from './service-switch';

/**
 * The commands of `npm run engine -- …` (PM-314). Kept apart from `cli.ts` so that tests drive them with
 * a fake terminal. Exit status: 0 done, 1 refused or not healthy, 2 wrong usage.
 */

class UsageError extends Error {}

export interface EngineCliIo {
  menubar?: MenubarMachine;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Everything on standard input (the key of `init`), or null when it is a terminal. */
  readStdin: () => Promise<string | null>;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Runs the engine process in the foreground; resolves with its exit status. */
  startEngine: (home: string, env: NodeJS.ProcessEnv) => Promise<number>;
  isRunning: (pid: number) => boolean;
  now?: () => number;
  /** The temporary directory sessions may use (`os.tmpdir()`); tests name another one. */
  tmpdir?: string;
  /** What `service install|uninstall|status` needs of the machine (launchd); absent where there is none. */
  launchd?: Omit<ServiceOptions, 'home' | 'pathEnv' | 'out'>;
  /** Runs `ditto`, `cp` and `git` for `move-work-root` (default: `execFile`); tests wrap or fail it. */
  exec?: Exec;
  /** The platform `move-work-root` copies for (default: this one). */
  platform?: NodeJS.Platform;
}

const USAGE = `usage:
  npm run engine -- app uninstall   (removes the menu bar app of PM-1088; the downloaded app installs itself)
  npm run engine -- init --cloud <https-url> --id <eng_…> [--name <name>] [--link-headers-file <path>] [--force]   (the key on standard input)
  npm run engine -- project set <KEY> <path>
  npm run engine -- repo add <KEY> <repo> <path> [--full-test "<command>"]
  npm run engine -- repo remove <KEY> <repo>
  npm run engine -- nanogpt-key set   (this engine's own NanoGPT key on standard input; its sessions then use it)
  npm run engine -- nanogpt-key clear
  npm run engine -- status [--json]   (--json: one line, the state for other programs; exit 0 in every state)
  npm run engine -- logs [--lines N] [--json]   (the end of the service's output and error logs; N up to ${LOG_LINES_MAX})
  npm run engine -- keep-awake on|off   (keep the Mac awake while work runs; takes effect when the engine restarts)
  npm run engine -- start
  npm run engine -- service install|uninstall|status|start|stop|restart   (macOS LaunchAgent: the engine starts at login and restarts)
  npm run engine -- service install [--path <PATH>]
  npm run engine -- service switch [--to <package-root> | --clear]
  npm run engine -- move-work-root <absolute path>   (the engine is stopped; copies worktrees/ and workspaces/ to the work volume)
  (all:[--home <dir>]; the home is PROJECTMAN_HOME or ~/.projectman)`;

interface Parsed {
  positional: string[];
  flags: Map<string, string>;
}

const BOOLEAN_FLAGS = new Set(['force', 'json', 'clear']);
const VALUE_FLAGS = new Set([
  'cloud',
  'id',
  'name',
  'home',
  'full-test',
  'link-headers-file',
  'lines',
  'path',
  'to',
]);

function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) flags.set(name, 'true');
    else if (VALUE_FLAGS.has(name)) {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      if (flags.has(name)) throw new UsageError(`--${name} is given twice`);
      flags.set(name, value);
      i += 1;
    } else throw new UsageError(`unknown option --${name}`);
  }
  return { positional, flags };
}

const absoluteDirectory = (value: string, cwd: string, what: string): string => {
  const resolved = path.resolve(cwd, value);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    throw new EngineConfigError('path_missing', `${what} does not exist: ${resolved}`);
  }
  if (!statSync(real).isDirectory())
    throw new EngineConfigError('path_not_directory', `${what} is not a directory: ${real}`);
  return real;
};

/** The real path of an existing regular file, resolved against `cwd`; its content is never read here. */
const absoluteFile = (value: string, cwd: string, what: string): string => {
  const resolved = path.resolve(cwd, value);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    throw new EngineConfigError('path_missing', `${what} does not exist: ${resolved}`);
  }
  if (!statSync(real).isFile())
    throw new EngineConfigError('path_not_file', `${what} is not a regular file: ${real}`);
  return real;
};

function age(from: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** PM-1086: the keep-awake state and the running work in one line; an older engine's file has neither. */
function keepAwakeLine(status: EngineStatus, alive: boolean, now: number): string {
  const { keepAwake, work } = status;
  if (!keepAwake) return 'keep awake: not reported by this engine version';
  let state: string;
  if (keepAwake.mode === 'off') state = 'off';
  else if (keepAwake.unsupported) state = 'not supported on this system';
  else if (!alive) state = 'not held (the engine is not running)';
  else if (keepAwake.holding) state = `holding${keepAwake.since ? ` for ${age(keepAwake.since, now)}` : ''}`;
  else state = 'not needed (nothing is running)';
  const counts = work
    ? `; work: ${work.sessions} sessions, ${work.fullTests} merge checks, ${work.screenshots} screenshot runs`
    : '';
  return `keep awake: ${state}${counts}`;
}

export async function runEngineCli(argv: string[], io: EngineCliIo): Promise<number> {
  try {
    const { positional, flags } = parse(argv);
    const home = path.resolve(
      flags.get('home') ?? io.env.PROJECTMAN_HOME ?? path.join(homedir(), '.projectman'),
    );
    const [command, sub, ...rest] = positional;
    const files = engineFiles(home);
    const resolveOptions = io.tmpdir ? { tmpdir: io.tmpdir } : {};
    switch (command) {
      case 'app': {
        if (rest.length || !['install', 'uninstall'].includes(sub ?? ''))
          throw new UsageError('app uninstall');
        if (sub === 'install')
          throw new EngineConfigError(
            'app_install_retired',
            'The menu bar app is no longer built from a checkout. Download the projectman motor app, open it and choose "Motor telepítése" (docs/DEPLOY.md "Engine menu bar app").',
          );
        if (!io.launchd || !io.menubar)
          throw new EngineConfigError('app_unsupported', 'The menu bar app requires macOS.');
        uninstallMenubar({ ...io.launchd, ...io.menubar, home, pathEnv: io.env.PATH ?? '', out: io.out });
        return 0;
      }
      case 'init': {
        const cloud = flags.get('cloud');
        const id = flags.get('id');
        if (!cloud || !id) throw new UsageError('init needs --cloud and --id');
        cloudOrigin(cloud); // https:// (http:// only for a loopback host)
        assertHomeNotInUse(home);
        const previous = existsSync(files.config) ? loadEngineConfig(home) : null;
        if (previous && !flags.has('force'))
          throw new EngineConfigError(
            'config_exists',
            `${files.config} exists. Use --force to set a new key or cloud address (the projects and repos stay).`,
          );
        const input = await io.readStdin();
        const key = input?.trim();
        if (!key)
          throw new UsageError(
            'the engine key is read from standard input: pbpaste | npm run engine -- init …',
          );
        if (key.length < 16 || key.length > 512 || /\s/.test(key))
          throw new EngineConfigError('key_invalid', 'That does not look like an engine key.');
        // Without the switch the previous file stays; with it the file is the one named, resolved against the cwd.
        const headersFlag = flags.get('link-headers-file');
        const linkHeadersFile = headersFlag
          ? absoluteFile(headersFlag, io.cwd, 'The link headers file')
          : previous?.linkHeadersFile;
        const config = EngineConfig.parse({
          schemaVersion: 1,
          cloudUrl: cloud,
          engineId: id,
          ...(flags.get('name') ? { name: flags.get('name') } : {}),
          ...(previous?.keyFile ? { keyFile: previous.keyFile } : {}),
          ...(linkHeadersFile ? { linkHeadersFile } : {}),
          ...(previous?.nanogptKeyFile ? { nanogptKeyFile: previous.nanogptKeyFile } : {}),
          projects: previous?.projects ?? [],
          repos: previous?.repos ?? [],
          maxPermissionMode: previous?.maxPermissionMode ?? 'auto',
          allowRemoteTerminalInput: previous?.allowRemoteTerminalInput ?? true,
        });
        writeSecretFile(config.keyFile ?? files.key, `${key}\n`);
        saveEngineConfig(home, config);
        io.out(
          `engine ${id} configured at ${files.config}; the key is in ${config.keyFile ?? files.key} (mode 0600)`,
        );
        io.out(
          'next: project set, repo add, then "npm run engine -- service install" (restarts the engine so it reports the project) or "npm run engine -- start"',
        );
        return 0;
      }
      case 'project': {
        if (sub !== 'set' || rest.length !== 2) throw new UsageError('project set <KEY> <path>');
        const [key, folder] = rest as [string, string];
        const config = loadEngineConfig(home);
        const workspacePath = absoluteDirectory(folder, io.cwd, 'The workspace');
        const projects = [
          ...config.projects.filter((entry) => entry.project !== key),
          { project: key, workspacePath },
        ];
        const next = EngineConfig.parse({ ...config, projects });
        resolveEngineConfig(next, home, resolveOptions); // repos stay inside their (new) workspace; the key outside it
        saveEngineConfig(home, next);
        io.out(`project ${key}: ${workspacePath}`);
        return 0;
      }
      case 'repo': {
        if (sub === 'add') {
          if (rest.length !== 3)
            throw new UsageError('repo add <KEY> <repo> <path> [--full-test "<command>"]');
          const config = loadEngineConfig(home);
          const [key, repo, folder] = rest as [string, string, string];
          const repoPath = absoluteDirectory(folder, io.cwd, 'The repository');
          const fullTest = flags.get('full-test');
          const repos = [
            ...config.repos.filter((entry) => !(entry.project === key && entry.repo === repo)),
            { project: key, repo, path: repoPath, ...(fullTest ? { fullTestCommand: fullTest } : {}) },
          ];
          const next = EngineConfig.parse({ ...config, repos });
          resolveEngineConfig(next, home, resolveOptions); // the project has a workspace and the repo is inside it
          saveEngineConfig(home, next);
          io.out(`repo ${key}/${repo}: ${repoPath}${fullTest ? ` (full test: ${fullTest})` : ''}`);
          return 0;
        }
        if (sub === 'remove') {
          if (rest.length !== 2) throw new UsageError('repo remove <KEY> <repo>');
          const config = loadEngineConfig(home);
          const [key, repo] = rest as [string, string];
          if (!config.repos.some((entry) => entry.project === key && entry.repo === repo)) {
            io.err(`${key}/${repo} is not registered`);
            return 1;
          }
          saveEngineConfig(home, {
            ...config,
            repos: config.repos.filter((entry) => !(entry.project === key && entry.repo === repo)),
          });
          io.out(`repo ${key}/${repo} removed`);
          return 0;
        }
        throw new UsageError('repo add or repo remove');
      }
      case 'nanogpt-key': {
        if (rest.length > 0 || (sub !== 'set' && sub !== 'clear'))
          throw new UsageError('nanogpt-key set (the key on standard input) or nanogpt-key clear');
        const config = loadEngineConfig(home);
        if (sub === 'set') {
          const key = (await io.readStdin())?.trim();
          if (!key)
            throw new UsageError(
              'the NanoGPT key is read from standard input: pbpaste | npm run engine -- nanogpt-key set',
            );
          if (key.length > 512 || /\s/.test(key))
            throw new EngineConfigError('key_invalid', 'That does not look like a NanoGPT key.');
          const keyFile = config.nanogptKeyFile ?? files.nanogptKey;
          // Checked before anything is written: a key file inside a session root is refused.
          const next = EngineConfig.parse({ ...config, nanogptKeyFile: keyFile });
          resolveEngineConfig(next, home, resolveOptions);
          writeSecretFile(keyFile, `${key}\n`);
          saveEngineConfig(home, next);
          io.out(`the NanoGPT key is in ${keyFile} (mode 0600); restart the engine to use it`);
          return 0;
        }
        if (!config.nanogptKeyFile) {
          io.out('this engine has no NanoGPT key of its own');
          return 0;
        }
        const { nanogptKeyFile, ...withoutKey } = config;
        try {
          unlinkSync(nanogptKeyFile);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        saveEngineConfig(home, withoutKey);
        io.out('the NanoGPT key of this engine is removed; restart the engine');
        return 0;
      }
      case 'status': {
        if (sub !== undefined) throw new UsageError('status takes no arguments');
        if (flags.has('json')) {
          // The state in every case is an answer, not a failure: the caller reads `overall`.
          const snapshot = buildSnapshot({
            home,
            now: () => new Date((io.now ?? Date.now)()),
            isRunning: io.isRunning,
            pathEnv: io.env.PATH ?? '',
            ...(io.launchd ? { launchd: io.launchd } : {}),
            ...(io.platform ? { platform: io.platform } : {}),
          });
          io.out(JSON.stringify(snapshot));
          return 0;
        }
        const status = readEngineStatus(files.status);
        if (!status) {
          io.err(`no engine status at ${files.status}: the engine has not run here`);
          return 1;
        }
        const now = (io.now ?? Date.now)();
        const alive = io.isRunning(status.pid);
        io.out(
          `engine process: ${alive ? `running (pid ${status.pid})` : `not running (last pid ${status.pid})`}`,
        );
        io.out(
          `link: ${alive ? status.connection : 'down'}${status.connectedSince && alive ? ` since ${age(status.connectedSince, now)} ago` : ''}`,
        );
        io.out(
          `version: ${status.version ?? 'not reported by this engine version'}; release: ${status.releaseTag ?? 'none'}`,
        );
        io.out(`status written ${age(status.updatedAt, now)} ago; connection attempts: ${status.attempts}`);
        io.out(`events waiting for the cloud: ${status.pendingEvents}; dropped: ${status.droppedEvents}`);
        if (status.lastError)
          io.out(
            `last error: ${status.lastError.code} — ${status.lastError.message} (${age(status.lastError.at, now)} ago)`,
          );
        io.out(
          `sessions: ${status.running.length}${status.running.map((s) => `\n  ${s.sessionId} ${s.state}`).join('')}`,
        );
        io.out(keepAwakeLine(status, alive, now));
        return alive && status.connection === 'connected' ? 0 : 1;
      }
      case 'logs': {
        if (sub !== undefined) throw new UsageError('logs takes no arguments');
        const linesFlag = flags.get('lines');
        const lines = linesFlag === undefined ? LOG_LINES_DEFAULT : Number(linesFlag);
        if (!Number.isInteger(lines) || lines < 1 || lines > LOG_LINES_MAX)
          throw new UsageError(`--lines is a whole number from 1 to ${LOG_LINES_MAX}`);
        const paths = serviceLogPaths(home);
        const tails = { out: tailLines(paths.logOut, lines), err: tailLines(paths.logErr, lines) };
        if (flags.has('json')) io.out(JSON.stringify(tails));
        else {
          io.out(`--- ${paths.logOut}`);
          for (const line of tails.out) io.out(line);
          io.out(`--- ${paths.logErr}`);
          for (const line of tails.err) io.out(line);
        }
        return 0;
      }
      case 'keep-awake': {
        if ((sub !== 'on' && sub !== 'off') || rest.length > 0) throw new UsageError('keep-awake on|off');
        const config = loadEngineConfig(home);
        saveEngineConfig(
          home,
          EngineConfig.parse({ ...config, keepAwake: sub === 'on' ? 'while_working' : 'off' }),
        );
        io.out(`keep awake while working: ${sub}. It takes effect when the engine is restarted.`);
        return 0;
      }
      case 'start': {
        if (sub !== undefined) throw new UsageError('start takes no arguments');
        // Fail with the cause before the process starts.
        const resolved = resolveEngineConfig(loadEngineConfig(home), home, resolveOptions);
        if (!existsSync(resolved.keyFile))
          throw new EngineConfigError('key_missing', `The engine key ${resolved.keyFile} does not exist.`);
        return io.startEngine(home, { ...io.env, PROJECTMAN_MODE: 'engine', PROJECTMAN_HOME: home });
      }
      case 'service': {
        if (
          rest.length > 0 ||
          !['install', 'uninstall', 'status', 'start', 'stop', 'restart', 'switch'].includes(sub ?? '')
        )
          throw new UsageError('service install, uninstall, status, start, stop, restart or switch');
        const launchd = io.launchd;
        if (!launchd)
          throw new EngineConfigError('service_unsupported', 'The engine service is not available here.');
        const options = {
          ...launchd,
          home,
          pathEnv: flags.get('path') ?? io.env.PATH ?? '',
          out: io.out,
          isRunning: io.isRunning,
        };
        if (
          (flags.has('path') && sub !== 'install') ||
          ((flags.has('to') || flags.has('clear')) && sub !== 'switch') ||
          (flags.has('to') && flags.has('clear'))
        )
          throw new UsageError('--path is for install; --to or --clear is for switch');
        if (sub === 'switch') {
          await switchService(
            { ...options, now: io.now },
            {
              ...(flags.has('to') ? { to: path.resolve(io.cwd, flags.get('to')!) } : {}),
              clear: flags.has('clear'),
            },
          );
          return 0;
        }
        if (sub !== 'status') assertNotSwitching(home);
        if (sub === 'install') {
          // The same preflight as "start": a service that would only crash and restart is not installed.
          const resolved = resolveEngineConfig(loadEngineConfig(home), home, resolveOptions);
          if (!existsSync(resolved.keyFile))
            throw new EngineConfigError('key_missing', `The engine key ${resolved.keyFile} does not exist.`);
          assertHomeMayStart(home, 'engine');
          await installService(options);
          return 0;
        }
        if (sub === 'uninstall') {
          uninstallService(options);
          return 0;
        }
        if (sub === 'start') {
          await startService(options);
          return 0;
        }
        if (sub === 'stop') {
          await stopService(options);
          return 0;
        }
        if (sub === 'restart') {
          await restartService(options);
          return 0;
        }
        return reportService(options) ? 0 : 1;
      }
      case 'move-work-root': {
        if (sub === undefined || rest.length > 0) throw new UsageError('move-work-root <absolute path>');
        const config = loadEngineConfig(home);
        const launchd = io.launchd;
        // Loaded here only: the menu bar polls `status` and `logs`, which must not pay for its git and work-root modules.
        const { defaultExec, moveWorkRoot } = await import('./move-work-root');
        return await moveWorkRoot({
          home,
          config,
          target: sub,
          exec: io.exec ?? defaultExec,
          platform: io.platform ?? process.platform,
          out: io.out,
          validate: (next) => void resolveEngineConfig(next, home, resolveOptions),
          engineRunning: () => {
            const status = readEngineStatus(files.status);
            if (status && io.isRunning(status.pid)) return true;
            if (!launchd || launchd.platform !== 'darwin' || !installedServiceFor(home, launchd.agentsDir))
              return false;
            return serviceState({ ...launchd, home, pathEnv: io.env.PATH ?? '', out: () => undefined })
              .running;
          },
        });
      }
      default:
        throw new UsageError(
          'commands: init, project set, repo add, repo remove, nanogpt-key, status, logs, keep-awake, start, service, move-work-root',
        );
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`usage error: ${error.message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof EngineConfigError) {
      io.err(`REFUSED [${error.code}]: ${error.message}`);
      return 1;
    }
    if (error instanceof Error && error.name === 'ZodError') {
      const issue = (error as Error & { issues?: Array<{ path: unknown[]; message: string }> }).issues?.[0];
      io.err(`REFUSED [config_invalid]: ${issue?.path.join('.') || 'value'}: ${issue?.message ?? 'invalid'}`);
      return 1;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
