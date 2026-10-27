import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isMergeId, isRepoFilePath } from '@projectman/shared';
import type { FullTestErrorReason } from '@projectman/shared';
import type { FullTestSpec } from '../contracts';
import { copyDependencyTrees } from '../worktree';
import { npmDependencyKey } from './npm-dependency-key';
import type { SandboxedEnd } from './run-sandboxed';
import { installerSettings, quoteShellWord } from './sandbox';
import type { RunPaths } from './sandbox';

export class DependencyPreparationError extends Error {
  readonly reason: FullTestErrorReason;
  readonly exitCode: number | null;
  constructor(
    message: string,
    reason: FullTestErrorReason = 'dependency_install_failed',
    exitCode: number | null = null,
  ) {
    super(message);
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

const info = (file: string) =>
  lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });

/** Every component below the engine-owned canonical root must remain a real directory. */
export async function directories(root: string, relative = '', create = false): Promise<string> {
  let current = root;
  for (const component of ['', ...relative.split('/').filter(Boolean)]) {
    if (component) current = path.join(current, component);
    let known = await info(current);
    if (!known && create) {
      await mkdir(current, { mode: 0o700 });
      known = await lstat(current);
    }
    if (!known?.isDirectory() || known.isSymbolicLink())
      throw new DependencyPreparationError('dependency preparation needs real directories');
  }
  return current;
}

/** Used both by the engine limit and the local executor, before granting installer write access. */
export async function assertNpmCiCheckout(
  worktreesRoot: string | null | undefined,
  spec: FullTestSpec,
): Promise<string> {
  if (!worktreesRoot || !spec.npmCi || spec.requireHeavyLock !== true || !isMergeId(spec.npmCi.mergeId))
    throw new DependencyPreparationError(
      'dependency preparation needs a worktrees root, merge id and required heavy lock',
    );
  return canonicalMergeCheckout(worktreesRoot, spec.npmCi.mergeId, spec.cwd);
}

/**
 * Used by the engine limit and the local executor before the regenerating run (PM-1050) gets its
 * writable directories: `cwd` is the canonical merge checkout of the run's own merge id.
 */
export async function assertRegenerateCheckout(
  worktreesRoot: string | null | undefined,
  spec: FullTestSpec,
): Promise<string> {
  if (!worktreesRoot || !spec.regenerate || !isMergeId(spec.regenerate.mergeId))
    throw new DependencyPreparationError('the regeneration needs a worktrees root and a merge id');
  return canonicalMergeCheckout(worktreesRoot, spec.regenerate.mergeId, spec.cwd);
}

async function canonicalMergeCheckout(worktreesRoot: string, mergeId: string, cwd: string): Promise<string> {
  await directories(path.resolve(worktreesRoot));
  const root = await realpath(worktreesRoot);
  const target = await directories(root, `_merge/${mergeId}`);
  // Do not accept an alias, even when it currently resolves back into the allowed tree.
  if (cwd !== target || (await realpath(cwd)) !== target)
    throw new DependencyPreparationError('the run is restricted to the canonical merge checkout');
  return root;
}

export async function regularFile(root: string, relative: string): Promise<Buffer> {
  await directories(root, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
  const file = path.join(root, relative);
  const known = await lstat(file);
  if (!known.isFile() || known.isSymbolicLink())
    throw new DependencyPreparationError('dependency input must be a regular file');
  return readFile(file);
}

const lockSchema = z.object({ packages: z.record(z.string(), z.unknown()) });
const manifestSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() });
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
export const readySchema = z
  .object({
    version: z.literal(1),
    key: z.string().regex(/^[a-f0-9]{64}$/),
    nodeModules: z.array(z.string()).min(1),
  })
  .strict();

export async function inputs(root: string) {
  // These override the keyed lock/configuration, so their mere presence makes a shared install unsafe.
  for (const name of ['.npmrc', 'npm-shrinkwrap.json']) {
    if (await info(path.join(root, name)))
      throw new DependencyPreparationError(`dependency preparation does not support ${name}`);
  }
  const lock = await regularFile(root, 'package-lock.json');
  const parsed = lockSchema.parse(JSON.parse(lock.toString('utf8')));
  const workspaces = Object.keys(parsed.packages).filter(
    (entry) => entry !== '' && !entry.split('/').includes('node_modules'),
  );
  for (const workspace of workspaces) {
    if (
      !isRepoFilePath(workspace) ||
      workspace.split('/').length > 2 ||
      /[*?\[\]{}]/.test(workspace) ||
      workspace.split('/').some((part) => part === '.git')
    )
      throw new DependencyPreparationError('unsupported local workspace path');
  }
  const parents = ['', ...workspaces.sort()];
  const manifests = [];
  for (const parent of parents) {
    const file = path.posix.join(parent, 'package.json');
    const content = await regularFile(root, file);
    const manifest = manifestSchema.parse(JSON.parse(content.toString('utf8')));
    for (const hook of LOCAL_INSTALL_HOOKS) {
      if (Object.hasOwn(manifest.scripts ?? {}, hook))
        throw new DependencyPreparationError(
          `dependency preparation does not support local ${hook} in ${file}`,
        );
    }
    // npm can implicitly run node-gyp even when the manifest has no explicit install script.
    if (await info(path.join(root, parent, 'binding.gyp')))
      throw new DependencyPreparationError(
        `dependency preparation does not support local binding.gyp in ${parent || '.'}`,
      );
    manifests.push({ path: file, content });
  }
  return {
    lock,
    manifests,
    parents,
    nodeModules: parents.map((parent) => path.posix.join(parent, 'node_modules')),
  };
}

/** Check package targets before npm gets any write access, including targets absent from the index checkout. */
export async function packageTargets(root: string, nodeModules: string[]) {
  for (const relative of nodeModules) {
    await directories(root, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
    const known = await info(path.join(root, relative));
    if (known && (!known.isDirectory() || known.isSymbolicLink()))
      throw new DependencyPreparationError('node_modules must be a real package directory');
  }
}

export async function installed(root: string, listed: string[], allowed: string[]) {
  if (
    !listed.includes('node_modules') ||
    new Set(listed).size !== listed.length ||
    listed.some((entry) => !allowed.includes(entry))
  )
    throw new DependencyPreparationError('invalid dependency tree list');
  const actual: string[] = [];
  for (const relative of allowed) {
    await directories(root, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative));
    if (await info(path.join(root, relative))) {
      await directories(root, relative);
      actual.push(relative);
    }
  }
  if (actual.length !== listed.length || actual.some((relative) => !listed.includes(relative)))
    throw new DependencyPreparationError('incomplete dependency tree list');
  await regularFile(root, 'node_modules/.package-lock.json');
}

export function checkPreparationEnd(end: SandboxedEnd): void {
  if (end.aborted) throw new DependencyPreparationError(end.output, 'killed');
  if (end.spawnError) throw new DependencyPreparationError(end.output, 'spawn_failed');
  if (end.timedOut) throw new DependencyPreparationError(end.output, 'timeout');
  if (end.signal) throw new DependencyPreparationError(end.output, 'killed');
  if (end.exitCode !== 0)
    throw new DependencyPreparationError(end.output, 'dependency_install_failed', end.exitCode);
}

/** Fixed engine-owned command; callers never supply shell text. */
export function npmCiCommand(paths: RunPaths): string {
  return `npm ci --include=dev --include=optional --no-audit --no-fund --registry=https://registry.npmjs.org --userconfig=${quoteShellWord(paths.npmUserConfig)} --globalconfig=${quoteShellWord(paths.npmGlobalConfig)}`;
}

/** The supervisor owns the store; the installer can only write its check checkout's package trees. */
export async function prepareNpmCi(input: {
  spec: FullTestSpec;
  paths: RunPaths;
  worktreesRoot: string;
  nodeVersion: string;
  remaining: () => number;
  signal: AbortSignal;
  execute: (command: string, settings: string, timeoutMs: number) => Promise<SandboxedEnd>;
  copy?: typeof copyDependencyTrees;
}): Promise<void> {
  const { spec, paths, signal, remaining } = input;
  const copy = input.copy ?? copyDependencyTrees;
  const root = await assertNpmCiCheckout(input.worktreesRoot, spec);
  const before = await inputs(spec.cwd);
  await packageTargets(spec.cwd, before.nodeModules);
  const probe = async (command: string, settings: string) => {
    const ended = await input.execute(command, settings, Math.min(60_000, remaining()));
    checkPreparationEnd(ended);
    return ended.output.trim();
  };
  const tracked = await probe(
    `git --literal-pathspecs ls-files -z --format=PROJECTMAN_TRACKED_NODE_MODULES -- ${before.nodeModules.map(quoteShellWord).join(' ')}`,
    paths.settings,
  );
  // A fixed NUL-terminated record survives diagnostics on the merged stdout/stderr stream.
  if (tracked.includes('PROJECTMAN_TRACKED_NODE_MODULES\0'))
    throw new DependencyPreparationError('the checkout tracks a node_modules path');
  await writeFile(paths.npmUserConfig, '', { mode: 0o600, flag: 'wx' });
  await writeFile(paths.npmGlobalConfig, '', { mode: 0o600, flag: 'wx' });
  await writeFile(
    paths.installerSettings,
    JSON.stringify(
      installerSettings(
        spec,
        paths,
        before.nodeModules.map((entry) => path.join(spec.cwd, entry)),
      ),
    ),
    { mode: 0o600, flag: 'wx' },
  );
  const config = `--userconfig=${quoteShellWord(paths.npmUserConfig)} --globalconfig=${quoteShellWord(paths.npmGlobalConfig)}`;
  // srt/Node diagnostics share the captured output; identify the complete version line only.
  const version = (output: string, pattern: RegExp) => {
    const lines = output.split(/\r?\n/).filter((line) => pattern.test(line));
    return lines.length === 1 ? lines[0] : undefined;
  };
  const npmVersion = version(
    await probe(`npm --version ${config}`, paths.installerSettings),
    /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/,
  );
  const nodeVersion = version(input.nodeVersion, /^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
  if (!npmVersion || !nodeVersion)
    throw new DependencyPreparationError('could not identify the Node and npm runtime');
  const keyOf = (value: Awaited<ReturnType<typeof inputs>>) =>
    npmDependencyKey({
      ...value,
      platform: process.platform,
      arch: process.arch,
      nodeVersion,
      npmVersion,
    });
  const key = keyOf(before);
  const repoKey = createHash('sha256')
    .update(JSON.stringify([spec.npmCi!.ref.projectKey, spec.npmCi!.ref.repo]))
    .digest('hex');
  const relativeStore = `_merge-deps/${repoKey}`;
  const store = await directories(root, relativeStore, true);
  const current = path.join(store, 'current');
  const previous = path.join(store, 'previous');
  const removeGeneration = async (name: string) => {
    await directories(root, relativeStore);
    if (await info(path.join(store, name))) {
      await directories(root, `${relativeStore}/${name}`);
      await rm(path.join(store, name), { recursive: true });
    }
  };
  // A supervisor crash may leave one unpublished or retired generation. Reap it before making another.
  for (const entry of await readdir(store)) {
    if (entry === 'previous' || /^staging-[a-f0-9]{16}$/.test(entry)) {
      remaining();
      await removeGeneration(entry);
    }
  }
  const currentInfo = await info(current);
  if (currentInfo && (!currentInfo.isDirectory() || currentInfo.isSymbolicLink()))
    throw new DependencyPreparationError('the dependency store is not a real directory');
  let cached: z.infer<typeof readySchema> | undefined;
  if (currentInfo) {
    try {
      const marker = readySchema.parse(
        JSON.parse((await regularFile(current, 'ready.json')).toString('utf8')),
      );
      if (marker.key === key) {
        await installed(current, marker.nodeModules, before.nodeModules);
        cached = marker;
      }
    } catch {
      // An incomplete, incompatible or malformed generation is a cache miss.
    }
  }
  const copyTrees = async (source: string, target: string) => {
    signal.throwIfAborted();
    const copied = await copy({ source, target, platform: process.platform, timeoutMs: remaining(), signal });
    remaining();
    return copied;
  };
  const sameTrees = (a: string[], b: string[]) => [...a].sort().join('\0') === [...b].sort().join('\0');
  if (cached) {
    await directories(root, `${relativeStore}/current`);
    if (!sameTrees(await copyTrees(current, spec.cwd), cached.nodeModules))
      throw new DependencyPreparationError('the cached dependency trees could not all be copied');
    await installed(spec.cwd, cached.nodeModules, before.nodeModules);
    if (keyOf(await inputs(spec.cwd)) !== key)
      throw new DependencyPreparationError('dependency inputs changed while copying');
    return;
  }

  const end = await input.execute(npmCiCommand(paths), paths.installerSettings, remaining());
  checkPreparationEnd(end);
  remaining();
  if (keyOf(await inputs(spec.cwd)) !== key)
    throw new DependencyPreparationError('dependency inputs changed during installation');
  await packageTargets(spec.cwd, before.nodeModules);
  const stagingName = `staging-${randomBytes(8).toString('hex')}`;
  const staging = path.join(store, stagingName);
  await directories(root, relativeStore);
  await mkdir(staging, { mode: 0o700 });
  let retired = false;
  let published = false;
  try {
    for (const parent of before.parents) await directories(staging, parent, true);
    const copied = await copyTrees(spec.cwd, staging);
    await installed(staging, copied, before.nodeModules);
    for (const relative of copied) {
      await directories(root, `${relativeStore}/${stagingName}/${relative}`);
      await chmod(path.join(staging, relative), 0o700);
    }
    if (keyOf(await inputs(spec.cwd)) !== key)
      throw new DependencyPreparationError('dependency inputs changed while publishing');
    signal.throwIfAborted();
    remaining();
    await directories(root, `${relativeStore}/${stagingName}`);
    await writeFile(
      path.join(staging, 'ready.json'),
      JSON.stringify({ version: 1, key, nodeModules: copied }),
      { mode: 0o600, flag: 'wx' },
    );
    // Readers hold this same lock: only complete generations can be observed as current.
    await directories(root, relativeStore);
    if (await info(current)) {
      await directories(root, `${relativeStore}/current`);
      await rename(current, previous);
      retired = true;
    }
    await directories(root, `${relativeStore}/${stagingName}`);
    remaining();
    await rename(staging, current);
    published = true;
    await removeGeneration('previous');
    remaining();
  } catch (err) {
    if (published) {
      // Even a failed retirement must not leave a newly issued valid marker behind.
      await directories(root, `${relativeStore}/current`);
      await unlink(path.join(current, 'ready.json'));
    } else if (retired) {
      await directories(root, `${relativeStore}/previous`);
      await rename(previous, current);
    }
    throw err;
  } finally {
    // Never follow a parent that was replaced while a copying child was running.
    if (!published) await removeGeneration(stagingName);
  }
}
