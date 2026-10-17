import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AdministrationSetupError,
  SOCKET_PATH_MAX,
  SupervisorConfig,
  ensurePrivateDir,
  expectedServiceKind,
  writeFileAtomic,
} from '../../apps/server/src/administration';

/**
 * The administration installer's preparation step (PM-763). It builds the supervisor's protected configuration
 * and the service file for the host's service manager and writes them into one output folder. It does not
 * install, load, start or enable anything and calls no `launchctl` or `systemctl`: placing the files and
 * starting the supervisor on a live machine is a separate rollout the owner approves. Every value that ends up in
 * a service file is checked against a narrow pattern first.
 */

export const SUPERVISOR_LABEL = 'com.projectman.administration';
export const SUPERVISOR_UNIT = 'projectman-administration.service';
export const PLIST_TEMPLATE = path.join('deploy', 'mac', `${SUPERVISOR_LABEL}.plist`);
export const UNIT_TEMPLATE = path.join('deploy', SUPERVISOR_UNIT);
export const CONFIG_NAME = 'supervisor.json';
/** The app-home folder `contracts/sandbox.ts` `sensitivePaths` denies to member sessions. */
export const ADMINISTRATION_FOLDER = 'administration';

export interface PrepareInput {
  /** `hub`, or `engine:<engine id>`. */
  target: string;
  /** The launchd label (macOS) or the systemd unit (Linux) of the one service the supervisor may restart. */
  service: string;
  /** The app home of the machine's projectman; the state and socket directories must lie below its `administration` folder. */
  appHome: string;
  stateDir: string;
  socketDir: string;
  /** Where the prepared files go; created private when missing. */
  outDir: string;
  /** The repository checkout the supervisor runs from. */
  root: string;
  nodePath: string;
  platform: NodeJS.Platform;
  /** The user and group of the systemd unit (Linux only). */
  user?: string;
  group?: string;
}

export interface PreparedFile {
  name: string;
  /** Written 0600 into a private folder, like every file of the adapter. */
  content: string;
}

export class PrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrepareError';
  }
}

const SAFE_PATH = /^\/[A-Za-z0-9_./+-]{1,900}$/;
const SAFE_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const SOCKET_NAME = 'supervisor.sock';

const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Fills a template; a placeholder the values do not know is an error, so a typo cannot ship. */
export function render(
  template: string,
  values: Record<string, string>,
  escape: (value: string) => string,
): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new PrepareError(`the template names an unknown placeholder {{${name}}}`);
    return escape(value);
  });
}

function parseTarget(text: string): SupervisorConfig['target'] {
  if (text === 'hub') return { kind: 'hub' };
  const match = /^engine:([a-z0-9_]{1,32})$/.exec(text);
  if (!match) throw new PrepareError('the target is "hub" or "engine:<engine id>"');
  // The configuration schema decides whether this is an engine id.
  return { kind: 'engine', id: match[1]! as never };
}

function checkPath(label: string, value: string): string {
  if (!path.isAbsolute(value) || !SAFE_PATH.test(value) || value.split('/').includes('..'))
    throw new PrepareError(`${label} must be a plain absolute path`);
  return value;
}

/** The files to write, without touching the disk. */
export function prepareFiles(input: PrepareInput): PreparedFile[] {
  const kind = expectedServiceKind(input.platform);
  if (!kind)
    throw new PrepareError('this operating system has no supported service manager (launchd or systemd)');
  const stateDir = checkPath('the state directory', input.stateDir);
  const socketDir = checkPath('the socket directory', input.socketDir);
  const root = checkPath('the repository', input.root);
  const nodePath = checkPath('the node binary', input.nodePath);
  checkPath('the output directory', input.outDir);
  if (stateDir === socketDir) throw new PrepareError('the state and the socket directories must differ');
  // Member sessions run as the same OS user, and their sandbox denies `<app home>/administration` only
  // (contracts/sandbox.ts); a directory anywhere else would leave the 0600 socket reachable from a session.
  const protectedRoot = path.join(checkPath('the app home', input.appHome), ADMINISTRATION_FOLDER);
  for (const [label, dir] of [
    ['the state directory', stateDir],
    ['the socket directory', socketDir],
  ] as const) {
    if (!dir.startsWith(`${protectedRoot}/`))
      throw new PrepareError(
        `${label} must be below ${protectedRoot}, the folder the session sandbox denies`,
      );
  }

  const socketPath = path.join(socketDir, SOCKET_NAME);
  if (socketPath.length > SOCKET_PATH_MAX)
    throw new PrepareError(
      `the socket path is longer than ${SOCKET_PATH_MAX} characters; use a shorter directory`,
    );
  const config = SupervisorConfig.safeParse({
    version: 1,
    target: parseTarget(input.target),
    stateDir,
    socketPath,
    service: kind === 'launchd' ? { kind, label: input.service } : { kind, unit: input.service },
  });
  if (!config.success)
    throw new PrepareError('the configuration is not valid (check the target and the service name)');
  const configFile = path.join(path.resolve(input.outDir), CONFIG_NAME);
  const files: PreparedFile[] = [{ name: CONFIG_NAME, content: `${JSON.stringify(config.data, null, 2)}\n` }];

  const templateFile = path.join(root, kind === 'launchd' ? PLIST_TEMPLATE : UNIT_TEMPLATE);
  if (!existsSync(templateFile))
    throw new PrepareError(`the service template ${templateFile} does not exist`);
  const template = readFileSync(templateFile, 'utf8');
  if (kind === 'launchd') {
    files.push({
      name: `${SUPERVISOR_LABEL}.plist`,
      content: render(
        template,
        { LABEL: SUPERVISOR_LABEL, NODE: nodePath, ROOT: root, CONFIG: configFile, STATE: stateDir },
        xml,
      ),
    });
  } else {
    if (!input.user || !SAFE_NAME.test(input.user) || !SAFE_NAME.test(input.group ?? input.user))
      throw new PrepareError('a systemd unit needs the user (and optionally the group) the hub runs as');
    files.push({
      name: SUPERVISOR_UNIT,
      content: render(
        template,
        {
          USER: input.user,
          GROUP: input.group ?? input.user,
          NODE: nodePath,
          ROOT: root,
          CONFIG: configFile,
          STATE: stateDir,
          SOCKET_DIR: socketDir,
        },
        (value) => value,
      ),
    });
  }
  return files;
}

/** Writes the prepared files into the output folder (private, created when missing); returns their paths. */
export async function writePrepared(outDir: string, files: PreparedFile[]): Promise<string[]> {
  await ensurePrivateDir(outDir);
  const written: string[] = [];
  for (const file of files) {
    await writeFileAtomic(outDir, file.name, file.content);
    written.push(path.join(outDir, file.name));
  }
  return written;
}

export { AdministrationSetupError };
