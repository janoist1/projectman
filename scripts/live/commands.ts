import path from 'node:path';
import { runConfigCheck } from './config-check';
import type { LiveDeps } from './deps';
import { install, status, uninstall } from './install';
import { DEFAULT_PORT, DEFAULT_TARGET, LiveError } from './paths';
import { runReleaseTest } from './release-test';
import { runWatch } from './watch';

export const USAGE = `usage:
  npm run live -- install [--root <dir>] [--home <dir>] [--port 4800] [--target PM/projectman] [--remote <url>]
  npm run live -- uninstall | status [--home <dir>]
  npm run live -- watch --root <dir> --home <dir> --port <port> --remote <url>   (launchd runs this)
  npm run live -- config-check --home <dir>
  npm run release-test
defaults: --root ~/projectman-live, --home ~/.projectman
`;

const COMMANDS = ['install', 'uninstall', 'status', 'watch', 'config-check', 'release-test'] as const;
type Command = (typeof COMMANDS)[number];
const OPTIONS = ['root', 'home', 'port', 'target', 'remote'] as const;

interface Parsed {
  command: Command;
  options: Partial<Record<(typeof OPTIONS)[number], string>>;
}

function parse(argv: readonly string[]): Parsed {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command))
    throw new LiveError(command ? `unknown command "${command}"\n${USAGE}` : USAGE, 2);
  const options: Parsed['options'] = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!;
    const name = flag.replace(/^--/, '');
    const value = rest[index + 1];
    if (!flag.startsWith('--') || !(OPTIONS as readonly string[]).includes(name))
      throw new LiveError(`unknown option "${flag}"\n${USAGE}`, 2);
    if (value === undefined || value.startsWith('--')) throw new LiveError(`${flag} needs a value`, 2);
    options[name as (typeof OPTIONS)[number]] = value;
  }
  return { command: command as Command, options };
}

/** The directory the options name; a path starting with `~/` is the user's home. */
function directory(value: string | undefined, fallback: string, userHome: string): string {
  const chosen = value ?? fallback;
  return path.resolve(chosen.startsWith('~/') ? path.join(userHome, chosen.slice(2)) : chosen);
}

function portOf(value: string | undefined): number {
  const port = value === undefined ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new LiveError(`--port must be a port number, not "${value}"`, 2);
  return port;
}

/** Parses the command line and runs the command; `makeDeps` gets the app home (the control socket is in it). */
export async function runLive(
  argv: readonly string[],
  makeDeps: (home: string) => LiveDeps,
): Promise<number> {
  let deps: LiveDeps | null = null;
  try {
    const { command, options } = parse(argv);
    const userHome = makeDeps('').homeDir;
    const home = directory(options.home, '~/.projectman', userHome);
    deps = makeDeps(home);
    switch (command) {
      case 'install':
        return await install(deps, {
          root: directory(options.root, '~/projectman-live', userHome),
          home,
          port: portOf(options.port),
          target: options.target ?? DEFAULT_TARGET,
          remote: options.remote ?? null,
        });
      case 'uninstall':
        return await uninstall(deps, { home });
      case 'status':
        return await status(deps, { home });
      case 'watch': {
        if (!options.root || !options.home || !options.remote)
          throw new LiveError('watch needs --root, --home and --remote', 2);
        return await runWatch(deps, {
          root: directory(options.root, '', userHome),
          home,
          port: portOf(options.port),
          remote: options.remote,
        });
      }
      case 'config-check':
        return await runConfigCheck(deps, home);
      case 'release-test':
        return await runReleaseTest(deps, directory(options.root, process.cwd(), userHome));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (deps ?? { out: (text: string) => process.stderr.write(text) }).out(`${message}\n`);
    return error instanceof LiveError ? error.exitCode : 1;
  }
}
