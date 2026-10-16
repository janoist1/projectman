import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { defaultSessionTmpRoot, sharedClaudeTmpRoots } from '../../apps/server/src/engine-host';
import {
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
import type { CloudContext } from '../cloud/context';
import { CloudError, refused } from '../cloud/errors';
import { assertCleanAt, checkoutExactCommit } from './checkout';
import { DEFAULT_TIMEOUTS } from './config';
import type { PrepareOptions, PreparedPaths } from './config';
import { candidateMarkerFile, hashRegularFile, readCandidateMarker, writeCandidateMarker } from './receipt';
import type { CandidateMarker } from './receipt';

/**
 * The engine candidate of a release (PM-750): a new checkout of the exact commit beside the running engine's
 * checkout, with its dependencies installed from the lockfile and its server built. Nothing here starts, stops
 * or reconfigures the running engine, and nothing reads its home.
 *
 * Every step that executes code from the checkout runs in the Anthropic Sandbox Runtime with the facade of the
 * full test: only the install may reach the network (registry.npmjs.org and nodejs.org), and each step writes
 * nothing but the candidate's own package trees or server bundle and a throwaway home. A sandbox that is
 * missing, refuses to start, times out or is interrupted ends the preparation: there is no fallback that runs
 * the same command on the host.
 */

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

export interface EngineCandidate {
  root: string;
  lockfileSha256: string;
}

export interface EngineRun {
  context: CloudContext;
  releaseId: string;
  commit: string;
  paths: PreparedPaths;
  options: PrepareOptions;
  signal: AbortSignal;
  sandbox: (run: SandboxedRun) => Promise<SandboxedEnd>;
}

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

function fingerprints(root: string) {
  return {
    installedTreeSha256: hashRegularFile(path.join(root, 'node_modules', '.package-lock.json')),
    serverBundleSha256: hashRegularFile(path.join(root, SERVER_BUNDLE)),
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

/** One run directory for the sandboxed steps; its settings files are outside the child's write access. */
async function withSandboxRun<T>(
  run: EngineRun,
  root: string,
  body: (steps: SandboxSteps) => Promise<T>,
): Promise<T> {
  const { context, options } = run;
  const runDir = runDirOf(
    options.tmpDir ?? os.tmpdir(),
    options.tmpDir ?? SHORT_TMP,
    randomBytes(8).toString('hex'),
  );
  const paths = runPaths(runDir);
  const userHome = options.userHome ?? context.deps.homeDir;
  const spec: FullTestSpec = {
    runId: path.basename(runDir),
    cwd: root,
    command: '',
    maxWorkers: 1,
    timeoutMs: DEFAULT_TIMEOUTS.install,
    sandbox: fullTestSandbox({
      checkout: root,
      userHome,
      appHome: run.paths.engineHome,
      closedTmpRoots: sharedTmpRoots(options.baseEnv ?? process.env),
    }),
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
    const offline = { ...closed, network: { ...closed.network, allowLocalBinding: false } };
    const write = (file: string, value: unknown) =>
      fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    const buildSettings = path.join(runDir, 'build-settings.json');
    write(paths.settings, offline);
    write(paths.installerSettings, installerSettings(spec, paths, installInputs(root).nodeModules));
    write(buildSettings, {
      ...offline,
      filesystem: {
        ...offline.filesystem,
        allowWrite: [paths.sandbox, path.join(root, path.dirname(SERVER_BUNDLE))],
      },
    });
    const env = fullTestEnv(paths, 1, options.baseEnv ?? process.env);
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
    });
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

interface SandboxSteps {
  paths: ReturnType<typeof runPaths>;
  config: string;
  probe(): Promise<void>;
  install(): Promise<SandboxedEnd>;
  build(): Promise<SandboxedEnd>;
  check(command: string): Promise<SandboxedEnd>;
}

/** Native modules load and work, and the engine's entry points load far enough to ask for the missing configuration. */
async function importabilityChecks(steps: SandboxSteps): Promise<void> {
  const database = path.join(steps.paths.tmp, 'engine-probe.sqlite');
  const fixtureHome = path.join(steps.paths.home, 'engine-fixture');
  await steps.check(
    `node -e 'const D = require("better-sqlite3"); const db = new D(process.argv[1]); db.exec("create table p (v text)"); db.prepare("insert into p values (?)").run("ok"); if (db.prepare("select count(*) as c from p").get().c !== 1) process.exit(3); db.close(); require("@lydell/node-pty"); console.log("native runtime ok")' ${quoteShellWord(database)}`,
  );
  // Both entry points stop on the missing engine configuration in a fixture home: all their static imports,
  // the native ones too, have loaded by then, and no machine key, home or cloud link exists to be touched.
  for (const entry of ['--import tsx apps/server/src/index.ts', 'apps/server/dist/index.js'])
    await steps.check(
      `out="$(env PROJECTMAN_MODE=engine PROJECTMAN_HOME=${quoteShellWord(fixtureHome)} node ${entry} 2>&1)"; status=$?; case "$out" in *${quoteShellWord(NO_CONFIG)}*) [ "$status" -eq 1 ] ;; *) printf '%s\\n' "$out" | tail -n 20; exit 1 ;; esac`,
    );
}

async function verifyReusable(run: EngineRun, root: string): Promise<CandidateMarker> {
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  const marker = stat ? readCandidateMarker(root) : undefined;
  if (!stat?.isDirectory() || stat.isSymbolicLink() || !marker)
    throw refused('the engine candidate directory exists but is not a finished candidate: remove it by hand');
  if (marker.releaseId !== run.releaseId || marker.commit !== run.commit || marker.root !== root)
    throw refused('the engine candidate belongs to another release');
  await assertCleanAt(run.context, root, run.commit, run.signal, 'the engine candidate');
  const now = { ...installInputs(root), ...fingerprints(root) };
  if (
    now.lockfileSha256 !== marker.lockfileSha256 ||
    now.installedTreeSha256 !== marker.installedTreeSha256 ||
    now.serverBundleSha256 !== marker.serverBundleSha256
  )
    throw refused('the engine candidate differs from its marker');
  return marker;
}

/**
 * Builds (or, when a complete identical candidate already stands there, re-verifies) the engine candidate.
 * A foreign or partial directory is never reused and never overwritten.
 */
export async function prepareEngineCandidate(run: EngineRun): Promise<EngineCandidate> {
  const root = path.join(run.paths.engineReleasesDir, `${run.releaseId}-${run.commit}`);
  const known =
    fs.lstatSync(root, { throwIfNoEntry: false }) ??
    fs.lstatSync(candidateMarkerFile(root), { throwIfNoEntry: false });
  if (known) {
    const marker = await verifyReusable(run, root);
    await withSandboxRun(run, root, async (steps) => {
      await steps.probe();
      await importabilityChecks(steps);
    });
    return { root, lockfileSha256: marker.lockfileSha256 };
  }
  if (!fs.existsSync(run.paths.engineReleasesDir)) fs.mkdirSync(run.paths.engineReleasesDir, { mode: 0o700 });
  await checkoutExactCommit(run.context, root, run.commit, run.signal);
  const inputs = installInputs(root);
  await withSandboxRun(run, root, async (steps) => {
    await steps.probe();
    await steps.install();
    await steps.build();
    await importabilityChecks(steps);
  });
  // The sandbox cannot write the checkout except the package trees and the bundle: HEAD and the lockfile stay.
  await assertCleanAt(run.context, root, run.commit, run.signal, 'the engine candidate');
  if (installInputs(root).lockfileSha256 !== inputs.lockfileSha256)
    throw refused('the engine candidate lockfile changed during the preparation');
  writeCandidateMarker({
    version: 1,
    releaseId: run.releaseId,
    commit: run.commit,
    root,
    lockfileSha256: inputs.lockfileSha256,
    ...fingerprints(root),
    preparedAt: run.context.deps.now().toISOString(),
  });
  return { root, lockfileSha256: inputs.lockfileSha256 };
}

/** The last look before the receipt: the candidate still is what the marker says, at the commit, clean. */
export async function reverifyEngineCandidate(run: EngineRun, expected: EngineCandidate): Promise<void> {
  const marker = await verifyReusable(run, expected.root);
  if (marker.lockfileSha256 !== expected.lockfileSha256)
    throw refused('the engine candidate lockfile differs from the prepared one');
}
