import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EnginePackageManifest } from '../../apps/server/src/contracts';
import { ENGINE_PACKAGE_FILE } from '../../apps/server/src/engine-link/engine-package';
import type { SandboxedEnd, SandboxedRun } from '../../apps/server/src/full-test';
import { RELEASE_TAG_PATTERN } from '@projectman/shared';
import type { CloudDeps } from '../cloud/deps';
import { CloudError, badUsage, refused } from '../cloud/errors';
import { checkoutExactCommit } from '../release/checkout';
import type { HeldLock, PrepareOptions } from '../release/config';
import { importabilityChecks, withSandboxRun } from '../release/engine';
import type { SandboxRunInput, SandboxSteps } from '../release/engine';
import { assertSatisfiesEngines, readNodePin } from './node-pin';
import type { NodePin } from './node-pin';

/**
 * The self-contained engine package (PM-1104, PM-1121): one commit built into a directory that runs without a
 * checkout, tsx or development dependencies. Layout (the contract the packaged service and the app build on):
 *
 *   engine-package.json  bin/node  package.json  package-lock.json  node_modules/  packages/
 *   apps/server/package.json  apps/server/dist/  scripts/engine/cli.js  deploy/mac/com.projectman.engine*.plist
 *
 * Everything that executes code of the commit (`npm ci` with its lifecycle scripts, the builds, the checks) runs in
 * the Anthropic Sandbox Runtime like the engine candidate of a release (`scripts/release/engine.ts`), with the
 * pinned Node first on the PATH so the native modules are built for the ABI the package ships. The Node itself is
 * downloaded here, outside the sandbox, and trusted only by its pinned sha256.
 */

const NODE_PIN_FILE = 'deploy/mac/app/node.json';
const REQUIRED_PATHS = [
  'package.json',
  'package-lock.json',
  'node_modules',
  'packages',
  'apps/server/package.json',
  'apps/server/dist/index.js',
  'scripts/engine/cli.js',
];
const OPTIONAL_PATHS = ['apps/server/node_modules'];
const SERVICE_TEMPLATE = /^com\.projectman\.engine.*\.plist$/;
/** Where the build steps may write inside the checkout, besides the package trees. */
const BUILD_OUTPUTS = ['apps/server/dist', 'scripts/engine'];

export interface EnginePackageDeps {
  run: CloudDeps['run'];
  fetch: typeof fetch;
  now(): Date;
  homeDir: string;
  platform: NodeJS.Platform;
  arch: string;
  /** Runs one command in the Anthropic Sandbox Runtime. */
  sandbox: (run: SandboxedRun) => Promise<SandboxedEnd>;
  /** Waits for the machine's heavy-run queue; rejects when the queue is unusable. */
  heavyLock: (label: string, signal: AbortSignal) => Promise<HeldLock>;
  out(line: string): void;
}

export interface EnginePackageRequest {
  commit: string;
  /** The directory the package is built into: `<outDir>/<commit>`. */
  outDir: string;
  /** The https remote the commit is fetched from. */
  repositoryUrl: string;
  /** The checkout the command runs from: its tags name the release tag of the commit. */
  sourceRepo: string;
}

type BuildOptions = Pick<
  PrepareOptions,
  'signal' | 'engineHome' | 'userHome' | 'tmpDir' | 'baseEnv' | 'timeouts'
>;

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function assertTargetFree(target: string): void {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(target).length > 0)
    throw refused(`the package directory ${target} already exists and is not empty`);
}

/** The pinned Node, downloaded and extracted to `<nodeDir>/bin/node`; an archive that differs from its hash is refused. */
async function fetchNode(
  deps: EnginePackageDeps,
  pin: NodePin,
  work: string,
  nodeDir: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await deps.fetch(pin.darwinArm64.url, { signal });
  if (!response.ok)
    throw new CloudError(`downloading Node ${pin.version} failed (status ${response.status})`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (sha256(archive) !== pin.darwinArm64.sha256)
    throw refused(`the downloaded Node ${pin.version} archive does not match its pinned sha256`);
  const archiveFile = path.join(work, 'node.tar.gz');
  fs.writeFileSync(archiveFile, archive, { mode: 0o600 });
  fs.mkdirSync(nodeDir, { mode: 0o700 });
  const extracted = await deps.run(
    'tar',
    [
      '-xzf',
      archiveFile,
      '-C',
      nodeDir,
      '--strip-components=1',
      `node-v${pin.version}-darwin-arm64/bin/node`,
    ],
    { signal },
  );
  if (extracted.code !== 0)
    throw new CloudError(`unpacking Node ${pin.version} failed (status ${extracted.code})`);
  const binary = path.join(nodeDir, 'bin/node');
  if (!fs.lstatSync(binary, { throwIfNoEntry: false })?.isFile())
    throw new CloudError('the Node archive holds no bin/node');
  fs.chmodSync(binary, 0o755);
}

/** The commit's release tag in the source repository (the shallow checkout fetched none); null when it has none. */
async function releaseTag(deps: EnginePackageDeps, request: EnginePackageRequest, signal: AbortSignal) {
  const result = await deps.run('git', ['-C', request.sourceRepo, 'tag', '--points-at', request.commit], {
    signal,
  });
  if (result.code !== 0) return null;
  return (
    result.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => RELEASE_TAG_PATTERN.test(line)) ?? null
  );
}

/** The modules the packaged engine needs load under the pinned Node, and its server stops on the missing configuration. */
async function packageChecks(steps: SandboxSteps): Promise<void> {
  await importabilityChecks(steps, ['apps/server/dist/index.js']);
  await steps.check(
    `node -e 'const D = require("better-sqlite3"); const db = new D(":memory:"); require("sqlite-vec").load(db); if (!db.prepare("select vec_version() as v").get().v) process.exit(3); db.close(); console.log("sqlite-vec ok")'`,
  );
}

async function buildInSandbox(
  deps: EnginePackageDeps,
  options: BuildOptions,
  signal: AbortSignal,
  checkout: string,
  nodeDir: string,
  pin: NodePin,
): Promise<void> {
  const run: SandboxRunInput = {
    context: { deps: { homeDir: deps.homeDir } },
    paths: {
      engineHome: options.engineHome ?? process.env.PROJECTMAN_HOME ?? path.join(deps.homeDir, '.projectman'),
    },
    options,
    signal,
    sandbox: deps.sandbox,
  };
  await withSandboxRun(
    run,
    checkout,
    async (steps) => {
      await steps.probe();
      const version = await steps.check('node --version');
      if (!version.output.split('\n').some((line) => line.trim() === `v${pin.version}`))
        throw refused('the sandbox does not run the pinned Node first');
      await steps.install();
      await steps.build();
      await steps.buildCommand('node scripts/engine-app/bundle-cli.mjs');
      await steps.installerCommand(`npm prune --omit=dev --no-save ${steps.config}`);
      await packageChecks(steps);
    },
    { pathPrefix: path.join(nodeDir, 'bin'), extraRead: [nodeDir], buildWrite: BUILD_OUTPUTS },
  );
}

function copyTree(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/** The package's files from the built checkout, the bundled node and the manifest. */
function assemble(checkout: string, nodeDir: string, stage: string, manifest: EnginePackageManifest): void {
  for (const relative of REQUIRED_PATHS)
    if (!fs.lstatSync(path.join(checkout, relative), { throwIfNoEntry: false }))
      throw new CloudError(`the build produced no ${relative}`);
  // `dist/index.js` is the proof the build ran; the whole directory ships (the history worker, the control relay).
  const copied = [
    ...REQUIRED_PATHS.map((relative) =>
      relative === 'apps/server/dist/index.js' ? 'apps/server/dist' : relative,
    ),
    ...OPTIONAL_PATHS.filter((relative) => fs.existsSync(path.join(checkout, relative))),
  ];
  for (const relative of copied) copyTree(path.join(checkout, relative), path.join(stage, relative));
  const templates = fs
    .readdirSync(path.join(checkout, 'deploy/mac'))
    .filter((name) => SERVICE_TEMPLATE.test(name));
  if (templates.length === 0) throw new CloudError('the checkout holds no engine service template');
  for (const name of templates)
    copyTree(path.join(checkout, 'deploy/mac', name), path.join(stage, 'deploy/mac', name));
  copyTree(path.join(nodeDir, 'bin/node'), path.join(stage, 'bin/node'));
  fs.writeFileSync(path.join(stage, ENGINE_PACKAGE_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Builds the engine package of one commit into `<outDir>/<commit>`, which must not exist or be empty. Nothing is
 * reused: the checkout, the sandbox run and the unfinished package are removed at the end, successful or not.
 */
export async function buildEnginePackage(
  deps: EnginePackageDeps,
  request: EnginePackageRequest,
  options: BuildOptions = {},
): Promise<{ root: string; manifest: EnginePackageManifest }> {
  const { commit } = request;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw badUsage('--commit must be a full 40-character commit id');
  if (deps.platform !== 'darwin' || deps.arch !== 'arm64')
    throw refused('the engine package is built on macOS arm64 only');
  const outDir = path.resolve(request.outDir);
  const target = path.join(outDir, commit);
  assertTargetFree(target);
  const signal = options.signal ?? new AbortController().signal;
  let lock: HeldLock;
  try {
    lock = await deps.heavyLock('engine app package', signal);
  } catch {
    signal.throwIfAborted();
    throw refused("the machine's heavy-run queue is unavailable: the package does not build without it");
  }
  const work = fs.mkdtempSync(path.join(fs.realpathSync(options.tmpDir ?? os.tmpdir()), 'pm-engine-app-'));
  let staging: string | undefined;
  try {
    const checkout = path.join(work, 'checkout');
    const nodeDir = path.join(work, 'node');
    deps.out(`checking out ${commit}`);
    await checkoutExactCommit(
      { deps: { run: deps.run }, config: { repository: { url: request.repositoryUrl } } },
      checkout,
      commit,
      signal,
    );
    const pin = readNodePin(path.join(checkout, NODE_PIN_FILE));
    const rootManifest = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')) as {
      engines?: { node?: string };
    };
    assertSatisfiesEngines(pin, rootManifest.engines?.node ?? '');
    deps.out(`downloading Node ${pin.version}`);
    await fetchNode(deps, pin, work, nodeDir, signal);
    deps.out('installing, building and checking in the sandbox');
    await buildInSandbox(deps, options, signal, checkout, nodeDir, pin);
    const manifest = EnginePackageManifest.parse({
      schemaVersion: 1,
      version: commit,
      tag: await releaseTag(deps, request, signal),
      node: pin.version,
      arch: 'arm64',
      builtAt: deps.now().toISOString(),
    });
    fs.mkdirSync(outDir, { recursive: true });
    staging = fs.mkdtempSync(path.join(outDir, `.${commit}.${randomBytes(4).toString('hex')}-`));
    assemble(checkout, nodeDir, staging, manifest);
    fs.chmodSync(staging, 0o755);
    assertTargetFree(target);
    if (fs.existsSync(target)) fs.rmdirSync(target);
    fs.renameSync(staging, target);
    staging = undefined;
    deps.out(`built ${target}`);
    return { root: target, manifest };
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    await lock.release();
  }
}
