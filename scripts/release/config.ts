import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonicalJson, EngineId } from '@projectman/shared';
import { loadEngineConfig } from '../../apps/server/src/engine-link/engine-config';
import type { SandboxedEnd, SandboxedRun } from '../../apps/server/src/full-test';
import { parseConfig } from '../cloud/config';
import type { CloudConfig } from '../cloud/config';
import type { CloudContext } from '../cloud/context';
import { badUsage, refused } from '../cloud/errors';
import { noSymlinks, sourceShaSchema } from '../cloud/images';
import { secretFileProblem, secretsDir, secretsDirProblem } from '../cloud/secrets';
import { releaseIdSchema } from './receipt';

/** What the caller names: nothing is implicit, so there is no default branch, tag or output location. */
export const prepareReleaseInputSchema = z.strictObject({
  releaseId: releaseIdSchema,
  commit: sourceShaSchema,
  outputDir: z.string().min(1),
  engineReleasesDir: z.string().min(1),
});
export type PrepareReleaseInput = z.input<typeof prepareReleaseInputSchema>;

export interface HeldLock {
  release(): Promise<void>;
}

/**
 * The seams of the preparation. Production code gives none of them; tests pass fakes. Nothing here can widen
 * what the preparation may touch: a missing sandbox, queue or builder is an error, never a host fallback.
 */
export interface PrepareOptions {
  /** Stops the preparation like an interrupt of the process does. */
  signal?: AbortSignal;
  /** The engine's home (`PROJECTMAN_HOME`), which no build step may read; default `PROJECTMAN_HOME` or `~/.projectman`. */
  engineHome?: string;
  /** The user's home, closed to the sandboxed steps; default `deps.homeDir`. */
  userHome?: string;
  /** The root of the sandbox run directory (`pmft-…`); default `os.tmpdir()`, or `/tmp` when that path is too long. */
  tmpDir?: string;
  /** The environment the sandbox's allow list is taken from; default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Runs one command in the Anthropic Sandbox Runtime; default `runSandboxed` of the full-test facade. */
  sandbox?: (run: SandboxedRun) => Promise<SandboxedEnd>;
  /** Waits for the machine's heavy-run queue; default `acquireHeavyLock`. Rejects when the queue is unusable. */
  heavyLock?: (label: string, signal: AbortSignal) => Promise<HeldLock>;
  timeouts?: Partial<Record<'install' | 'build' | 'check' | 'smoke', number>>;
}

export const DEFAULT_TIMEOUTS = {
  install: 30 * 60_000,
  build: 10 * 60_000,
  check: 2 * 60_000,
  smoke: 10 * 60_000,
};

const forbiddenPathCharacters = /[\0\r\n,]/;

export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** The directory itself or an ancestor/descendant of it: such directories may not overlap. */
const overlap = (a: string, b: string) => isWithin(a, b) || isWithin(b, a);

function absolute(label: string, value: string): string {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.length < 2 ||
    value.endsWith(path.sep) ||
    forbiddenPathCharacters.test(value)
  )
    throw badUsage(`${label} must be a normalized absolute path`);
  return value;
}

function ownPrivateDirectory(label: string, directory: string): void {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw refused(`${label} must be an existing directory`);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw refused(`${label} must be owned by this user and not writable by others`);
}

export interface PreparedPaths {
  outputDir: string;
  engineReleasesDir: string;
  repoRoot: string;
  engineHome: string;
}

/**
 * The checks that need no side effect: absolute, normalized, symlink-free admin directories that overlap
 * neither the source checkout nor the engine's home nor each other. The output directory is new.
 */
export function validatePrepareInput(
  context: CloudContext,
  raw: unknown,
  options: PrepareOptions,
): { input: z.output<typeof prepareReleaseInputSchema>; paths: PreparedPaths } {
  const parsed = prepareReleaseInputSchema.safeParse(raw);
  if (!parsed.success)
    throw badUsage(`invalid release preparation input: ${parsed.error.issues[0]?.path.join('.') || 'input'}`);
  const input = parsed.data;
  const outputDir = absolute('outputDir', input.outputDir);
  const engineReleasesDir = absolute('engineReleasesDir', input.engineReleasesDir);
  let repoRoot: string;
  try {
    repoRoot = fs.realpathSync(context.deps.repoRoot);
  } catch {
    throw refused('the source checkout is missing or inaccessible');
  }
  const homeInput =
    options.engineHome ?? process.env.PROJECTMAN_HOME ?? path.join(context.deps.homeDir, '.projectman');
  const engineHome = fs.existsSync(homeInput) ? fs.realpathSync(homeInput) : path.resolve(homeInput);
  noSymlinks(outputDir);
  noSymlinks(engineReleasesDir);
  if (fs.lstatSync(outputDir, { throwIfNoEntry: false }))
    throw refused('outputDir must be a new directory that does not exist yet');
  ownPrivateDirectory('the parent of outputDir', path.dirname(outputDir));
  if (!fs.lstatSync(engineReleasesDir, { throwIfNoEntry: false })) {
    ownPrivateDirectory('the parent of engineReleasesDir', path.dirname(engineReleasesDir));
  } else ownPrivateDirectory('engineReleasesDir', engineReleasesDir);
  for (const [label, directory] of [
    ['outputDir', outputDir],
    ['engineReleasesDir', engineReleasesDir],
  ] as const) {
    if (overlap(repoRoot, directory)) throw refused(`${label} must be outside the source checkout`);
    if (overlap(engineHome, directory)) throw refused(`${label} must be outside the engine home`);
  }
  if (overlap(outputDir, engineReleasesDir))
    throw refused('outputDir and engineReleasesDir must not contain each other');
  return { input, paths: { outputDir, engineReleasesDir, repoRoot, engineHome } };
}

// ---------------------------------------------------------------------------------------------
// The hybrid coordinator's configuration (PM-751). One strict file under the protected
// `~/.config/projectman/cloud/` tree, next to the cloud configuration it refers to. It holds no secret, no
// credential and no URL with credentials: only identifiers, absolute paths and one HTTPS origin.
// ---------------------------------------------------------------------------------------------

const hybridPath = z
  .string()
  .min(2)
  .refine(
    (value) =>
      path.isAbsolute(value) &&
      path.normalize(value) === value &&
      !value.endsWith(path.sep) &&
      !forbiddenPathCharacters.test(value),
    'a normalized absolute path without a comma, NUL or newline',
  );

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

const hybridReleaseConfigSchema = z.strictObject({
  version: z.literal(1),
  controllerId: z.uuid(),
  cloudConfig: hybridPath,
  stateDir: hybridPath,
  expectedAccountId: z.string().regex(/^\d{12}$/),
  expectedInstanceId: z.string().regex(/^i-[0-9a-f]{8}([0-9a-f]{9})?$/),
  cloudOrigin: z.string().refine(isHttpsOrigin, 'an https origin without path or credentials'),
  engineId: EngineId.refine((id) => id !== 'local', 'a remote engine is needed'),
  engineHome: hybridPath,
  engineReleasesDir: hybridPath,
});
export type HybridReleaseConfig = z.output<typeof hybridReleaseConfigSchema>;

/** What the target hash stands for: where the two targets are, and nothing that could be a secret. */
interface HybridTargetDescription {
  accountId: string;
  instanceId: string;
  region: string;
  cloudOrigin: string;
  projectKey: string;
  repo: string;
  engineId: string;
}

/**
 * The target hash (`PROJECTMAN_RELEASE_TARGET_HASH` of the cloud server, `hybrid.targetHash` of the cloud
 * configuration): the SHA-256 of the canonical JSON of the credential-free target description. The cloud
 * server compares what the coordinator sends with its own copy, so a coordinator for another account,
 * instance, origin, project or engine can never claim this server's release.
 */
function hybridTargetHash(target: HybridTargetDescription): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        version: 1,
        accountId: target.accountId,
        instanceId: target.instanceId,
        region: target.region,
        cloudOrigin: target.cloudOrigin,
        projectKey: target.projectKey,
        repo: target.repo,
        engineId: target.engineId,
      }),
    )
    .digest('hex');
}

export interface LoadedHybridConfig {
  config: HybridReleaseConfig;
  configFile: string;
  /** SHA-256 of the config bytes, a zero byte and the cloud configuration bytes; no credential file is read. */
  configSha256: string;
  cloud: CloudConfig;
  targetHash: string;
  /** `<home>/.config/projectman/cloud`: the protected tree the configuration and the state live in. */
  secretsRoot: string;
}

function strictlyWithin(root: string, target: string): boolean {
  return target !== root && isWithin(root, target);
}

/** The bytes of a private regular file (0600, ours, no symlink in the path) inside the protected tree. */
function readPrivateFile(label: string, file: string, root: string): Buffer {
  if (!path.isAbsolute(file) || path.normalize(file) !== file)
    throw refused(`${label} must be a normalized absolute path`);
  if (!strictlyWithin(root, file)) throw refused(`${label} must be inside ${root}`);
  noSymlinks(file);
  const problem = secretFileProblem(file);
  if (problem) throw refused(problem);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw refused(`${label} cannot be read`);
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw refused(`${label} must be a regular file`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads and cross-checks the coordinator's configuration. Everything that can be proven offline is proven
 * here (the account and the instance id are checked against AWS by the cloud adapter). A bad or missing file
 * is a refusal (exit status 2): nothing arms the automatic watcher on it.
 */
export function loadHybridReleaseConfig(file: string, homeDir: string): LoadedHybridConfig {
  const secretsRoot = secretsDir(homeDir);
  const rootProblem = secretsDirProblem(secretsRoot);
  if (rootProblem) throw refused(rootProblem);
  const configBytes = readPrivateFile('the release configuration', file, secretsRoot);
  let raw: unknown;
  try {
    raw = JSON.parse(configBytes.toString('utf8'));
  } catch {
    throw refused('the release configuration is not valid JSON');
  }
  const parsed = hybridReleaseConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(file)'}: ${issue.message}`,
    );
    throw refused(`the release configuration is not valid:\n${lines.join('\n')}`);
  }
  const config = parsed.data;
  const cloudBytes = readPrivateFile('the cloud configuration', config.cloudConfig, secretsRoot);
  let cloudRaw: unknown;
  try {
    cloudRaw = JSON.parse(cloudBytes.toString('utf8'));
  } catch {
    throw refused('the cloud configuration is not valid JSON');
  }
  const cloud = parseConfig(cloudRaw, homeDir, path.dirname(config.cloudConfig));

  if (!strictlyWithin(secretsRoot, config.stateDir)) throw refused(`stateDir must be inside ${secretsRoot}`);
  if (isWithin(config.stateDir, config.cloudConfig) || isWithin(config.stateDir, file))
    throw refused('stateDir must not contain the configuration files');
  const directories = [
    ['stateDir', config.stateDir],
    ['engineHome', config.engineHome],
    ['engineReleasesDir', config.engineReleasesDir],
  ] as const;
  for (const [index, [labelA, a]] of directories.entries())
    for (const [labelB, b] of directories.slice(index + 1))
      if (overlap(a, b)) throw refused(`${labelA} and ${labelB} must not contain each other`);

  if (!cloud.releaseTarget) throw refused('the cloud configuration has no releaseTarget');
  if (!cloud.hybrid) throw refused('the cloud configuration has no hybrid binding');
  if (cloud.aws.ec2?.architecture !== 'arm64')
    throw refused('the hybrid release needs the EC2 ARM cloud machine');
  if (cloud.hybrid.engineId !== config.engineId)
    throw refused('hybrid.engineId of the cloud configuration differs from engineId');
  if (`https://${cloud.cloudflare.hostname}` !== config.cloudOrigin)
    throw refused('cloudOrigin differs from the cloud configuration hostname');
  const targetHash = hybridTargetHash({
    accountId: config.expectedAccountId,
    instanceId: config.expectedInstanceId,
    region: cloud.aws.region,
    cloudOrigin: config.cloudOrigin,
    projectKey: cloud.releaseTarget.projectKey,
    repo: cloud.releaseTarget.repo,
    engineId: config.engineId,
  });
  if (cloud.hybrid.targetHash !== targetHash)
    throw refused(
      'hybrid.targetHash of the cloud configuration differs from the target of this configuration',
    );

  let engine: ReturnType<typeof loadEngineConfig>;
  try {
    engine = loadEngineConfig(config.engineHome);
  } catch {
    throw refused('the engine home has no valid engine configuration');
  }
  let engineOrigin: string;
  try {
    engineOrigin = new URL(engine.cloudUrl).origin;
  } catch {
    throw refused('the engine configuration has no valid cloud address');
  }
  if (engine.engineId !== config.engineId) throw refused('the engine home belongs to another engine id');
  if (engineOrigin !== config.cloudOrigin) throw refused('the engine home points at another cloud origin');

  return {
    config,
    configFile: file,
    configSha256: createHash('sha256')
      .update(configBytes)
      .update(Buffer.from([0]))
      .update(cloudBytes)
      .digest('hex'),
    cloud,
    targetHash,
    secretsRoot,
  };
}

/** The state directory: created (0700) when it is new, otherwise only accepted when it is ours and private. */
export function ensureStateDir(loaded: Pick<LoadedHybridConfig, 'config' | 'secretsRoot'>): string {
  const { stateDir } = loaded.config;
  noSymlinks(stateDir);
  if (!fs.lstatSync(stateDir, { throwIfNoEntry: false })) {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateDir, 0o700);
  }
  return checkedStateDir(stateDir);
}

/** The state directory for a command that only reads: it is never created, and one that is there must be ours. */
export function existingStateDir(loaded: Pick<LoadedHybridConfig, 'config'>): string {
  const { stateDir } = loaded.config;
  noSymlinks(stateDir);
  return fs.lstatSync(stateDir, { throwIfNoEntry: false }) ? checkedStateDir(stateDir) : stateDir;
}

function checkedStateDir(stateDir: string): string {
  const problem = secretsDirProblem(stateDir);
  if (problem) throw refused(problem);
  if (!fs.lstatSync(stateDir).isDirectory()) throw refused('stateDir must be a directory');
  return stateDir;
}
