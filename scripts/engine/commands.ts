import { existsSync, realpathSync, statSync } from 'node:fs';
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

/**
 * The commands of `npm run engine -- …` (PM-314). Kept apart from `cli.ts` so that tests drive them with
 * a fake terminal. Exit status: 0 done, 1 refused or not healthy, 2 wrong usage.
 */

export class UsageError extends Error {}

export interface EngineCliIo {
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
}

const USAGE = `usage:
  npm run engine -- init --cloud <https-url> --id <eng_…> [--name <name>] [--force]   (the key on standard input)
  npm run engine -- project set <KEY> <path>
  npm run engine -- repo add <KEY> <repo> <path> [--full-test "<command>"]
  npm run engine -- repo remove <KEY> <repo>
  npm run engine -- status
  npm run engine -- start
  (all: [--home <dir>]; the home is PROJECTMAN_HOME or ~/.projectman)`;

interface Parsed {
  positional: string[];
  flags: Map<string, string>;
}

const BOOLEAN_FLAGS = new Set(['force']);
const VALUE_FLAGS = new Set(['cloud', 'id', 'name', 'home', 'full-test']);

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

function age(from: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
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
        const config = EngineConfig.parse({
          schemaVersion: 1,
          cloudUrl: cloud,
          engineId: id,
          ...(flags.get('name') ? { name: flags.get('name') } : {}),
          ...(previous?.keyFile ? { keyFile: previous.keyFile } : {}),
          ...(previous?.linkHeadersFile ? { linkHeadersFile: previous.linkHeadersFile } : {}),
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
        io.out('next: project set, repo add, then "npm run engine -- start"');
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
      case 'status': {
        if (sub !== undefined) throw new UsageError('status takes no arguments');
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
        io.out(`status written ${age(status.updatedAt, now)} ago; connection attempts: ${status.attempts}`);
        io.out(`events waiting for the cloud: ${status.pendingEvents}; dropped: ${status.droppedEvents}`);
        if (status.lastError)
          io.out(
            `last error: ${status.lastError.code} — ${status.lastError.message} (${age(status.lastError.at, now)} ago)`,
          );
        io.out(
          `sessions: ${status.running.length}${status.running.map((s) => `\n  ${s.sessionId} ${s.state}`).join('')}`,
        );
        return alive && status.connection === 'connected' ? 0 : 1;
      }
      case 'start': {
        if (sub !== undefined) throw new UsageError('start takes no arguments');
        // Fail with the cause before the process starts.
        const resolved = resolveEngineConfig(loadEngineConfig(home), home, resolveOptions);
        if (!existsSync(resolved.keyFile))
          throw new EngineConfigError('key_missing', `The engine key ${resolved.keyFile} does not exist.`);
        return io.startEngine(home, { ...io.env, PROJECTMAN_MODE: 'engine', PROJECTMAN_HOME: home });
      }
      default:
        throw new UsageError('commands: init, project set, repo add, repo remove, status, start');
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
