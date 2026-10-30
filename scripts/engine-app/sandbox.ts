import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { defaultSessionTmpRoot, sharedClaudeTmpRoots } from '../../apps/server/src/engine-host';
import {
  canonicalRoot,
  fullTestEnv,
  installerSettings,
  quoteShellWord,
  runDirOf,
  runPaths,
  srtSettings,
} from '../../apps/server/src/full-test';
import type { SandboxedEnd, SandboxedRun } from '../../apps/server/src/full-test';
import type { FullTestSpec } from '../../apps/server/src/contracts';
import { fullTestSandbox } from '../../apps/server/src/runtime/sessions';
import { CloudError, refused } from '../cloud/errors';
import { noSymlinks } from '../cloud/images';
import { DEFAULT_TIMEOUTS } from './build-options';
import type { BuildOptions } from './build-options';
function hashRegularFile(file: string): string {
  noSymlinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw refused('a hashed input must be a regular file');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const count = fs.readSync(fd, buffer);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      throw refused('a hashed input changed while it was read');
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

/** Sandboxed installation, build and import checks for an engine package. No host fallback is permitted. */

const SHORT_TMP = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
const LOCAL_INSTALL_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'prepublish',
  'preprepare',
  'prepare',
  'postprepare',
  'dependencies',
] as const;
const SERVER_BUNDLE = 'apps/server/dist/index.js';
const NO_CONFIG = 'projectman engine: No engine configuration at';

const lockSchema = z.object({ packages: z.record(z.string(), z.unknown()) });
const manifestSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() });

/** The inputs npm will act on: the lockfile and the workspaces it names. Anything that could override them is refused. */
function installInputs(root: string): { lockfileSha256: string; nodeModules: string[] } {
  for (const name of ['.npmrc', 'npm-shrinkwrap.json'])
    if (fs.lstatSync(path.join(root, name), { throwIfNoEntry: false }))
      throw refused(`the engine candidate does not support ${name}`);
  const lockfileSha256 = hashRegularFile(path.join(root, 'package-lock.json'));
  const lock = lockSchema.parse(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')));
  const workspaces = Object.keys(lock.packages)
    .filter((entry) => entry !== '' && !entry.split('/').includes('node_modules'))
    .sort();
  for (const workspace of workspaces)
    if (!/^(?:apps|packages)\/[a-z0-9][a-z0-9._-]*$/.test(workspace))
      throw refused('the engine candidate has an unsupported workspace path');
  for (const parent of ['', ...workspaces]) {
    const manifest = manifestSchema.parse(
      JSON.parse(fs.readFileSync(path.join(root, parent, 'package.json'), 'utf8')),
    );
    for (const hook of LOCAL_INSTALL_HOOKS)
      if (Object.hasOwn(manifest.scripts ?? {}, hook))
        throw refused(`the engine candidate does not support a local ${hook} script`);
    if (fs.lstatSync(path.join(root, parent, 'binding.gyp'), { throwIfNoEntry: false }))
      throw refused('the engine candidate does not support a local binding.gyp');
  }
  return {
    lockfileSha256,
    nodeModules: ['', ...workspaces].map((parent) => path.join(root, parent, 'node_modules')),
  };
}

function outputTail(end: SandboxedEnd): string {
  const tail = end.output.trim().split('\n').slice(-5).join(' | ').slice(0, 500);
  return tail ? `: ${tail}` : '';
}

/**
 * The temporary roots every session of the machine shares (PM-353), closed like the server's full test and merge
 * check close them: Claude Code's (scratchpads, background outputs), the base of the sessions' own temporary
 * directories and the members' session folders. The install runs third-party lifecycle scripts with the registry
 * in reach, so none of these may be readable. The run's own directory is none of them and stays readable.
 */
function sharedTmpRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set([
      ...sharedClaudeTmpRoots({ claudeTmpBase: env.CLAUDE_CODE_TMPDIR || undefined }),
      defaultSessionTmpRoot(),
      path.join(fs.realpathSync(os.tmpdir()), 'projectman-sessions'),
    ]),
  ];
}

/** The isolated engine package build context. */
export interface SandboxRunInput {
  context: { deps: { homeDir: string } };
  paths: { engineHome: string };
  options: BuildOptions;
  signal: AbortSignal;
  sandbox: (run: SandboxedRun) => Promise<SandboxedEnd>;
}

/** What differs between the callers of `withSandboxRun` (PM-1121: the engine package pins its own node). */
export interface SandboxRunExtras {
  /** A directory put at the front of the steps' PATH (the node the native modules must be built for). */
  pathPrefix?: string;
  /** Directories the sandbox may read besides the checkout. */
  extraRead?: string[];
  /** Directories of the checkout the build step may write; default: the server bundle's. */
  buildWrite?: string[];
}

function isUnder(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The PATH of the sandboxed steps (PM-1156): the prefix, then the machine's PATH without the folders the sandbox
 * closes (under the user's home or the engine home, such as a hosted runner's toolcache). They cannot be read
 * there anyway, and a lookup that stumbles on one fails instead of moving on to the next folder.
 */
function stepPath(prefix: string | undefined, base: string | undefined, closed: string[]): string {
  const closedRoots = closed.flatMap((directory) => {
    const resolved = path.resolve(directory);
    try {
      const real = fs.realpathSync(resolved);
      return real === resolved ? [resolved] : [resolved, real];
    } catch {
      return [resolved];
    }
  });
  const kept = (base ?? '')
    .split(':')
    .filter((entry) => entry !== '' && !closedRoots.some((root) => isUnder(path.resolve(entry), root)));
  return [...(prefix ? [prefix] : []), ...kept].join(':');
}

/** One run directory for the sandboxed steps; its settings files are outside the child's write access. */
export async function withSandboxRun<T>(
  run: SandboxRunInput,
  root: string,
  body: (steps: SandboxSteps) => Promise<T>,
  extras: SandboxRunExtras = {},
): Promise<T> {
  const { context, options } = run;
  let runDir: string;
  try {
    runDir = runDirOf(
      canonicalRoot(options.tmpDir ?? os.tmpdir()),
      canonicalRoot(options.tmpDir ?? SHORT_TMP),
      randomBytes(8).toString('hex'),
    );
  } catch {
    throw refused('the sandbox run directory has no root that leaves room for its sockets');
  }
  const paths = runPaths(runDir);
  const userHome = options.userHome ?? context.deps.homeDir;
  const closedSandbox = fullTestSandbox({
    checkout: root,
    userHome,
    appHome: run.paths.engineHome,
    closedTmpRoots: sharedTmpRoots(options.baseEnv ?? process.env),
  });
  const spec: FullTestSpec = {
    runId: path.basename(runDir),
    cwd: root,
    command: '',
    maxWorkers: 1,
    timeoutMs: DEFAULT_TIMEOUTS.install,
    sandbox: { ...closedSandbox, allowRead: [...closedSandbox.allowRead, ...(extras.extraRead ?? [])] },
    requireHeavyLock: true,
  };
  fs.mkdirSync(runDir, { mode: 0o700 });
  try {
    for (const directory of [paths.home, paths.tmp, paths.npmCache])
      fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(paths.gitConfig, '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n');
    for (const file of [paths.npmUserConfig, paths.npmGlobalConfig])
      fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    const closed = srtSettings(spec, paths);
    // No network at all, not even a local listener: the candidate's steps have nothing to serve or fetch.
    const offline = {
      ...closed,
      network: { allowedDomains: [] as string[], deniedDomains: [] as string[], allowLocalBinding: false },
    };
    const write = (file: string, value: unknown) =>
      fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    const buildSettings = path.join(runDir, 'build-settings.json');
    write(paths.settings, offline);
    write(paths.installerSettings, installerSettings(spec, paths, installInputs(root).nodeModules));
    write(buildSettings, {
      ...offline,
      filesystem: {
        ...offline.filesystem,
        allowWrite: [
          paths.sandbox,
          ...(extras.buildWrite ?? [path.dirname(SERVER_BUNDLE)]).map((directory) =>
            path.join(root, directory),
          ),
        ],
      },
    });
    const env = fullTestEnv(paths, 1, options.baseEnv ?? process.env);
    env.PATH = stepPath(extras.pathPrefix, env.PATH, [userHome, run.paths.engineHome]);
    const config = `--userconfig=${quoteShellWord(paths.npmUserConfig)} --globalconfig=${quoteShellWord(paths.npmGlobalConfig)}`;
    const execute = async (
      stage: 'install' | 'build' | 'check',
      command: string,
      settings: string,
    ): Promise<SandboxedEnd> => {
      run.signal.throwIfAborted();
      const end = await run.sandbox({
        cwd: root,
        env,
        settings,
        command,
        timeoutMs: options.timeouts?.[stage] ?? DEFAULT_TIMEOUTS[stage],
        signal: run.signal,
      });
      if (end.aborted || run.signal.aborted) throw new CloudError('the preparation was interrupted');
      if (end.spawnError || end.timedOut || end.signal || end.exitCode !== 0)
        throw new CloudError(
          `the engine candidate ${stage} step failed${end.timedOut ? ' (timeout)' : ''}${outputTail(end)}`,
        );
      return end;
    };
    return await body({
      paths,
      config,
      probe: async () => {
        // The sandbox itself works and runs node, before anything of the candidate does.
        try {
          await execute('check', "/bin/sh -c 'node --version'", paths.settings);
        } catch (error) {
          if (run.signal.aborted) throw error;
          throw refused(
            `the preparer sandbox is unavailable: ${error instanceof Error ? error.message : ''}`,
          );
        }
      },
      install: () =>
        execute(
          'install',
          `npm ci --include=dev --include=optional --no-audit --no-fund --registry=https://registry.npmjs.org ${config}`,
          paths.installerSettings,
        ),
      build: () => execute('build', `npm run build -w @projectman/server ${config}`, buildSettings),
      check: (command) => execute('check', command, paths.settings),
      installerCommand: (command) => execute('install', command, paths.installerSettings),
      buildCommand: (command) => execute('build', command, buildSettings),
    });
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

export interface SandboxSteps {
  paths: ReturnType<typeof runPaths>;
  /** The `--userconfig`/`--globalconfig` flags that keep npm off the user's configuration. */
  config: string;
  probe(): Promise<void>;
  install(): Promise<SandboxedEnd>;
  build(): Promise<SandboxedEnd>;
  check(command: string): Promise<SandboxedEnd>;
  /** Any command with the install step's settings (registry reachable, package trees writable). */
  installerCommand(command: string): Promise<SandboxedEnd>;
  /** Any command with the build step's settings (offline, the build directories writable). */
  buildCommand(command: string): Promise<SandboxedEnd>;
}

/** Native modules load and work, and the engine's entry points load far enough to ask for the missing configuration. */
export async function importabilityChecks(
  steps: SandboxSteps,
  entries: readonly string[] = ['apps/server/dist/index.js'],
): Promise<void> {
  const database = path.join(steps.paths.tmp, 'engine-probe.sqlite');
  const fixtureHome = path.join(steps.paths.home, 'engine-fixture');
  await steps.check(
    `node -e 'const D = require("better-sqlite3"); const db = new D(process.argv[1]); db.exec("create table p (v text)"); db.prepare("insert into p values (?)").run("ok"); if (db.prepare("select count(*) as c from p").get().c !== 1) process.exit(3); db.close(); require("@lydell/node-pty"); console.log("native runtime ok")' ${quoteShellWord(database)}`,
  );
  // Both entry points stop on the missing engine configuration in a fixture home: all their static imports,
  // the native ones too, have loaded by then, and no machine key, home or cloud link exists to be touched.
  for (const entry of entries)
    await steps.check(
      `out="$(env PROJECTMAN_MODE=engine PROJECTMAN_HOME=${quoteShellWord(fixtureHome)} node ${entry} 2>&1)"; status=$?; case "$out" in *${quoteShellWord(NO_CONFIG)}*) [ "$status" -eq 1 ] ;; *) printf '%s\\n' "$out" | tail -n 20; exit 1 ;; esac`,
    );
}
