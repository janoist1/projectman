import { realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { isRegeneratedWriteDir } from '@projectman/shared';

type SandboxSpec = { sandbox: { denyRead: string[]; allowRead: string[] } };

/** The git identity and settings of a full test run: neutral, and no automatic maintenance. */
export const FULL_TEST_GIT_CONFIG =
  '[user]\n\tname = projectman full test\n\temail = full-test@projectman.invalid\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n';

/** A short temporary root for when `tmpDir` is too deep for the sandbox's socket (macOS: `/tmp` is a link to this). */
export const SHORT_ROOT = process.platform === 'darwin' ? '/private/tmp' : '/tmp';

/** One word of a shell command, in single quotes: nothing in it is expanded (the rule lives in shared, PM-844). */
export { quoteShellWord } from '@projectman/shared';

/**
 * The longest Unix socket path the sandbox can open, in bytes (UTF-8), a little below macOS's limit
 * (104 bytes with the terminating NUL).
 */
const SOCKET_PATH_MAX = 100;
/**
 * The room a run's own `tmp` and `home` must leave for the socket name that goes below them, separator
 * included: `srt`'s `srt-mux-<pid>-<n>.sock` (a pid of up to 7 digits) and the control socket's
 * `control.sock` both fit.
 */
const SOCKET_SUFFIX_MIN = 40;

/** `root` with its links resolved (macOS: `/var/folders` is `/private/var/folders`); a root that does not exist stays as it is. */
export function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(root);
    throw err;
  }
}

/**
 * The directory of a run: `<root>/pmft-<end of the run id>`, short, because the sandbox's TMPDIR below it
 * holds Unix sockets and a long path makes the sandbox fail ("listen EINVAL"). The roots must be canonical
 * (`canonicalRoot`): the sandbox opens the socket under the resolved path, so a link would hide extra
 * bytes. The root is `tmpRoot`; when `SOCKET_SUFFIX_MIN` bytes do not fit below its `tmp` and `home` within
 * `SOCKET_PATH_MAX` (a deep temporary directory), it is the short system-wide `shortRoot`. It throws when
 * neither fits: the run is not prepared with a wider permission or a longer path.
 */
export function runDirOf(tmpRoot: string, shortRoot: string, runId: string): string {
  const name = `pmft-${runId.replace(/[^A-Za-z0-9]/g, '').slice(-8)}`;
  const fits = (root: string) => {
    const paths = runPaths(path.join(root, name));
    return [paths.tmp, paths.home].every(
      (dir) => Buffer.byteLength(dir, 'utf8') + SOCKET_SUFFIX_MIN <= SOCKET_PATH_MAX,
    );
  };
  const root = [tmpRoot, shortRoot].find(fits);
  if (root === undefined)
    throw new Error(`no root leaves ${SOCKET_SUFFIX_MIN} bytes for a socket below the run directory`);
  return path.join(root, name);
}

/** The name of a run directory (`runDirOf`): `pmft-` and up to 8 characters of the run id. */
const RUN_DIR_NAME = /^pmft-[A-Za-z0-9]{1,8}$/;

/**
 * Removes the run directories a crash left behind (PM-837): the direct children of `roots` named like
 * `runDirOf`'s, real directories of this user (the shared `SHORT_ROOT` may hold another instance's), not
 * touched for `olderThanMs`. Links are never followed or removed. Returns how many it removed.
 */
export async function sweepStaleRunDirs(
  roots: readonly string[],
  olderThanMs: number,
  now: number = Date.now(),
): Promise<number> {
  const uid = process.getuid?.();
  let removed = 0;
  for (const root of new Set(roots.map(canonicalRoot))) {
    const names = await readdir(root).catch(() => []);
    for (const name of names) {
      if (!RUN_DIR_NAME.test(name)) continue;
      const target = path.join(root, name);
      const info = await lstat(target).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      if (uid !== undefined && info.uid !== uid) continue;
      if (now - info.mtimeMs <= olderThanMs) continue;
      await rm(target, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

/** The directories of one run: only `sandbox` is writable for the command. */
export function runPaths(runDir: string) {
  const sandbox = path.join(runDir, 'sandbox');
  return {
    runDir,
    settings: path.join(runDir, 'settings.json'),
    installerSettings: path.join(runDir, 'installer-settings.json'),
    npmUserConfig: path.join(runDir, 'npm-user.conf'),
    npmGlobalConfig: path.join(runDir, 'npm-global.conf'),
    sandbox,
    home: path.join(sandbox, 'home'),
    tmp: path.join(sandbox, 'tmp'),
    npmCache: path.join(sandbox, 'npm-cache'),
    gitConfig: path.join(sandbox, 'gitconfig'),
  };
}
export type RunPaths = ReturnType<typeof runPaths>;

/** The default temporary directory of srt (`SANDBOX_OWN_WRITE_PATHS`, srt 0.0.78), as `/tmp` and as its target. */
export const SRT_DEFAULT_TMP = ['/tmp/claude', '/private/tmp/claude'] as const;

/**
 * The `srt` settings of a run (Anthropic Sandbox Runtime, the Seatbelt layer Claude Code uses):
 * - reading: nothing of `spec.sandbox.denyRead`, except `allowRead` and the run's own directory;
 * - writing: only the run's `sandbox` directory (the checkout is read-only; srt's default temporary
 *   directory, which srt would open on its own, is denied);
 * - network: nothing outward, local ports open (decision 24), Unix sockets only below the run's own
 *   `tmp` (srt 0.0.78 on macOS binds and connects there; no other socket path, and not all of them);
 *   PTYs allowed (macOS only).
 */
export function srtSettings(spec: SandboxSpec, paths: RunPaths, writeDirs: readonly string[] = []) {
  return {
    network: {
      allowedDomains: [] as string[],
      deniedDomains: [] as string[],
      allowLocalBinding: true,
      allowUnixSockets: [paths.tmp],
      allowAllUnixSockets: false,
    },
    filesystem: {
      denyRead: [...new Set(spec.sandbox.denyRead)],
      allowRead: [...new Set([...spec.sandbox.allowRead, paths.sandbox])],
      allowWrite: [paths.sandbox, ...writeDirs],
      // srt always makes its own default temporary directory writable, outside `allowWrite`: it is shared
      // with the members' sandboxes and outlives the run, so a run may not write there.
      denyWrite: [...SRT_DEFAULT_TMP],
    },
    allowPty: true,
  };
}

/**
 * The absolute directories of `spec.sandbox.writeDirs` (PM-1050) the regenerating run may write, below the
 * canonical `cwd`. Each must be a safe relative directory (`isRegeneratedWriteDir`) whose every segment is a
 * real directory of the checkout, never a link; one that does not exist yet is made. It throws for anything
 * else, and the run does not start. Only the checkout's own directories qualify: its root, `.git`, hooks
 * and `node_modules` stay read-only.
 */
export async function resolveWriteDirs(cwd: string, dirs: readonly string[]): Promise<string[]> {
  if (dirs.length === 0) return [];
  const root = await realpath(cwd);
  const resolved = new Set<string>();
  for (const dir of dirs) {
    if (!isRegeneratedWriteDir(dir)) throw new Error(`A writable directory is not allowed: ${dir}`);
    let current = root;
    for (const segment of dir.split('/')) {
      current = path.join(current, segment);
      let info = await lstat(current).catch(() => null);
      if (info === null) {
        await mkdir(current);
        info = await lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`A writable directory is not a real directory of the checkout: ${dir}`);
    }
    if ((await realpath(current)) !== current)
      throw new Error(`A writable directory is not a real directory of the checkout: ${dir}`);
    resolved.add(current);
  }
  return [...resolved];
}

/** Installer writes only package trees; lifecycle scripts keep the source and git metadata read-only. */
export function installerSettings(spec: SandboxSpec, paths: RunPaths, nodeModules: string[]) {
  const settings = srtSettings(spec, paths);
  return {
    ...settings,
    network: {
      allowedDomains: ['registry.npmjs.org', 'nodejs.org'],
      deniedDomains: [],
      allowLocalBinding: false,
    },
    filesystem: {
      ...settings.filesystem,
      allowRead: [...settings.filesystem.allowRead, paths.npmUserConfig, paths.npmGlobalConfig],
      allowWrite: [paths.sandbox, ...nodeModules],
    },
  };
}

/**
 * The environment of a run: an allow list, nothing else comes from the server's environment, so no
 * `PROJECTMAN_*` (the PTY skip included), token, `SSH_AUTH_SOCK` or billing variable is inherited.
 * The executor alone supplies the optional disposable passed-step key file.
 */
export function fullTestEnv(
  paths: RunPaths,
  maxWorkers: number,
  base: NodeJS.ProcessEnv = process.env,
  passedKeysFile?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: base.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: paths.home,
    TMPDIR: paths.tmp,
    // srt gives the sandboxed command `TMPDIR=$CLAUDE_CODE_TMPDIR`, or a `/tmp/claude` that does not exist.
    CLAUDE_CODE_TMPDIR: paths.tmp,
    npm_config_cache: paths.npmCache,
    npm_config_update_notifier: 'false',
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    VITEST_MAX_FORKS: String(maxWorkers),
    VITEST_MAX_THREADS: String(maxWorkers),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    // The server holds the machine's heavy-run lock for the run: the npm scripts inside do not queue again.
    PROJECTMAN_HEAVY_LOCK_HELD: '1',
    PROJECTMAN_FULL_TEST_SANDBOX: '1',
  };
  if (passedKeysFile) env.PROJECTMAN_MERGE_TEST_PASSED_KEYS = passedKeysFile;
  for (const name of ['LANG', 'LC_ALL'] as const) {
    const value = base[name];
    if (value) env[name] = value;
  }
  return env;
}

/**
 * The command with its standard input closed (`/dev/null`) for all of it, a chain included. Inside the
 * sandbox, srt hands the command its input through a socket of its own, and a program that asks the
 * terminal about its input (`script`, so a PTY) fails on a socket ("Operation not supported on socket").
 */
export function closedStdin(command: string): string {
  return `exec </dev/null; ${command}`;
}

/**
 * The process that starts the sandbox, at low priority: the priority is set outside the sandbox
 * (Seatbelt refuses `setpriority` inside it), and the sandbox and the command below inherit it.
 */
export function niceSrtCommand(node: string, srtCli: string, settings: string, command: string) {
  return { file: '/usr/bin/nice', args: ['-n', '10', node, srtCli, '--settings', settings, '-c', command] };
}
