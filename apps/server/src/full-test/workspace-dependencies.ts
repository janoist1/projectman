import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type {
  WorkspaceDependenciesResult,
  WorkspaceDependencyFailure,
  WorkspaceDependencyInstaller,
  WorkspaceDependencyRequest,
} from '../contracts';
import { copyDependencyTrees } from '../worktree';
import { acquireHeavyLock, HeavyLockError } from './heavy-lock';
import {
  checkPreparationEnd,
  DependencyPreparationError,
  directories,
  inputs,
  installed,
  npmCiCommand,
  packageTargets,
  readySchema,
  regularFile,
} from './npm-ci';
import { npmDependencyKey } from './npm-dependency-key';
import { runSandboxed, srtCli } from './run-sandboxed';
import type { SandboxedRun } from './run-sandboxed';
import {
  FULL_TEST_GIT_CONFIG,
  fullTestEnv,
  installerSettings,
  quoteShellWord,
  runDirOf,
  runPaths,
  SHORT_ROOT,
} from './sandbox';

export const WORKSPACE_DEPENDENCY_RETRY_MS = 600_000;
let sandboxRuntime: Promise<typeof import('@anthropic-ai/sandbox-runtime')> | undefined;
const MEMOIZED = new Set<WorkspaceDependencyFailure>([
  'invalid_inputs',
  'install_failed',
  'timeout',
  'sandbox_unavailable',
]);
const hash = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const markerSchema = readySchema.extend({ preparedAt: z.iso.datetime() });

class WorkspaceDependencyError extends Error {
  readonly code = 'workspace_dependencies_failed';
  readonly details: { reason: WorkspaceDependencyFailure; exitCode: number | null; key: string | null };
  constructor(reason: WorkspaceDependencyFailure, key: string | null, exitCode: number | null = null) {
    super(`workspace dependency preparation failed: ${reason}`);
    this.details = { reason, exitCode, key };
  }
}

interface Preparation {
  startedAt: string;
  controller: AbortController;
  promise: Promise<WorkspaceDependenciesResult>;
}

export interface WorkspaceDependencyInstallerOptions {
  home: string;
  heavyLockDir: string;
  worktreesRoot: string;
  denyRead: string[];
  setupOf(project: string, repo: string): { kind: 'npm_ci'; timeoutMs: number } | null;
  logger: FastifyBaseLogger;
  /** Tests replace sandbox execution; no real npm, network or agent CLI is needed. */
  execute?: typeof runSandboxed;
  /** Temporary roots, injectable for tests just like the full-test executor's. */
  tmpDir?: string;
}

/** Engine-owned preparation: a caller's wait ending never cancels the installation. */
export function createWorkspaceDependencyInstaller(
  options: WorkspaceDependencyInstallerOptions,
): WorkspaceDependencyInstaller {
  const running = new Map<string, Preparation>();
  const failures = new Map<string, { key: string | null; at: number; error: WorkspaceDependencyError }>();
  let versions: { nodeVersion: string; npmVersion: string } | undefined;
  let closed = false;

  const keyOf = (value: Awaited<ReturnType<typeof inputs>>) =>
    npmDependencyKey({
      ...value,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: versions?.nodeVersion ?? process.version,
      npmVersion: versions?.npmVersion ?? 'unavailable',
    });
  const memo = (repoPath: string, key: string | null) => {
    const failure = failures.get(repoPath);
    if (failure?.key === key && Date.now() - failure.at < WORKSPACE_DEPENDENCY_RETRY_MS) throw failure.error;
  };

  async function run(request: WorkspaceDependencyRequest, timeoutMs: number, signal: AbortSignal) {
    const started = Date.now();
    let key: string | null = null;
    let waitedMs = 0;
    let outcome = 'ready';
    let exitCode: number | null = null;
    const store = path.join(options.home, 'workspace-deps');
    const markerDir = path.join(store, hash([request.project, request.member, request.repo]));
    const marker = path.join(markerDir, 'ready.json');
    const paths = runPaths(
      runDirOf(options.tmpDir ?? os.tmpdir(), SHORT_ROOT, randomBytes(16).toString('hex')),
    );
    let madeRunDir = false;
    let deadline = Date.now() + timeoutMs;
    const remaining = () => {
      if (signal.aborted) throw new WorkspaceDependencyError('aborted', key);
      const left = deadline - Date.now();
      if (left <= 0) throw new WorkspaceDependencyError('timeout', key);
      return left;
    };
    const spec = { sandbox: { denyRead: options.denyRead, allowRead: [request.repoPath] } };
    const readInputs = async () => {
      try {
        return await inputs(request.repoPath);
      } catch {
        throw new WorkspaceDependencyError('invalid_inputs', key);
      }
    };

    async function sandboxFiles(nodeModules: string[]) {
      if (!madeRunDir) {
        if (!options.execute) {
          try {
            const { SandboxManager } = await (sandboxRuntime ??= import('@anthropic-ai/sandbox-runtime'));
            if (process.platform !== 'darwin' || !SandboxManager.isSupportedPlatform())
              throw new Error('unsupported platform');
            const check = await SandboxManager.checkDependenciesAsync();
            if (check.errors.length) throw new Error('sandbox dependencies unavailable');
            srtCli();
          } catch {
            throw new WorkspaceDependencyError('sandbox_unavailable', key);
          }
        }
        await mkdir(paths.runDir, { mode: 0o700 });
        madeRunDir = true;
        for (const dir of [paths.home, paths.tmp, paths.npmCache]) await mkdir(dir, { recursive: true });
        await writeFile(paths.gitConfig, FULL_TEST_GIT_CONFIG, { mode: 0o600 });
        await writeFile(paths.npmUserConfig, '', { mode: 0o600, flag: 'wx' });
        await writeFile(paths.npmGlobalConfig, '', { mode: 0o600, flag: 'wx' });
      }
      await writeFile(
        paths.installerSettings,
        JSON.stringify(
          installerSettings(
            spec,
            paths,
            nodeModules.map((entry) => path.join(request.repoPath, entry)),
          ),
        ),
        { mode: 0o600 },
      );
    }

    async function execute(command: string, probe = false) {
      const env = fullTestEnv(paths, 1);
      // Member preparation needs no nested projectman command or heavy-run bypass.
      for (const name of Object.keys(env)) if (name.startsWith('PROJECTMAN_')) delete env[name];
      const run: SandboxedRun = {
        cwd: request.repoPath,
        env,
        settings: paths.installerSettings,
        command,
        timeoutMs: Math.min(probe ? 60_000 : Infinity, remaining()),
        signal,
      };
      const end = await (options.execute ?? runSandboxed)(run);
      if (end.spawnError) throw new WorkspaceDependencyError('sandbox_unavailable', key);
      try {
        checkPreparationEnd(end);
      } catch (err) {
        if (err instanceof DependencyPreparationError)
          throw new WorkspaceDependencyError(
            end.aborted
              ? 'aborted'
              : end.timedOut
                ? 'timeout'
                : end.signal
                  ? 'aborted'
                  : probe
                    ? 'sandbox_unavailable'
                    : 'install_failed',
            key,
            end.exitCode,
          );
        throw err;
      }
      remaining();
      if (!probe) exitCode = end.exitCode;
      return end.output;
    }

    try {
      for (;;) {
        signal.throwIfAborted();
        let before: Awaited<ReturnType<typeof inputs>>;
        try {
          before = await readInputs();
          key = keyOf(before);
          await packageTargets(request.repoPath, before.nodeModules);
        } catch {
          throw new WorkspaceDependencyError('invalid_inputs', key);
        }
        memo(request.repoPath, key);
        if (!versions) {
          await sandboxFiles(before.nodeModules);
          const version = (output: string, pattern: RegExp) => {
            const lines = output.split(/\r?\n/).filter((line) => pattern.test(line));
            if (lines.length !== 1) throw new WorkspaceDependencyError('sandbox_unavailable', key);
            return lines[0]!;
          };
          const nodeVersion = version(
            await execute('node --version', true),
            /^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/,
          );
          const config = `--userconfig=${quoteShellWord(paths.npmUserConfig)} --globalconfig=${quoteShellWord(paths.npmGlobalConfig)}`;
          const npmVersion = version(
            await execute(`npm --version ${config}`, true),
            /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/,
          );
          versions = { nodeVersion, npmVersion };
          key = keyOf(before);
          memo(request.repoPath, key);
        }
        await mkdir(store, { recursive: true, mode: 0o700 });
        await directories(store);
        await directories(store, path.basename(markerDir), true);
        try {
          const cached = markerSchema.parse(
            JSON.parse((await regularFile(markerDir, 'ready.json')).toString('utf8')),
          );
          if (cached.key === key) {
            await installed(request.repoPath, cached.nodeModules, before.nodeModules);
            remaining();
            return { status: 'ready' as const, key, changed: false };
          }
        } catch (err) {
          if (err instanceof WorkspaceDependencyError) throw err;
          // A missing or incomplete marker is a cache miss.
        }

        const queued = Date.now();
        const lock = await acquireHeavyLock({
          dir: options.heavyLockDir,
          label: `workspace-deps ${request.project}/${request.member}/${request.repo}`,
          cwd: request.repoPath,
          maxWaitMs: 1_800_000,
          signal,
        }).catch((err: unknown) => {
          waitedMs += Date.now() - queued;
          throw err;
        });
        waitedMs += Date.now() - queued;
        deadline = Date.now() + timeoutMs;
        try {
          remaining();
          // A branch or lockfile may have changed while this operation waited in the queue.
          if (keyOf(await readInputs()) !== key) continue;
          await packageTargets(request.repoPath, before.nodeModules);
          await rm(marker, { force: true });
          await sandboxFiles(before.nodeModules);
          // A tracked package tree must never be removed by the engine.
          const tracked = await execute(
            `git -c core.fsmonitor=false -c core.hooksPath=/dev/null --literal-pathspecs ls-files -z --format=PROJECTMAN_TRACKED_NODE_MODULES -- ${before.nodeModules.map(quoteShellWord).join(' ')}`,
            true,
          );
          if (tracked.includes('PROJECTMAN_TRACKED_NODE_MODULES\0'))
            throw new WorkspaceDependencyError('invalid_inputs', key);
          const relativeStore = `_merge-deps/${hash([request.project, request.repo])}/current`;
          let source: { path: string; nodeModules: string[] } | undefined;
          try {
            const root = await directories(options.worktreesRoot, relativeStore);
            const ready = readySchema.parse(
              JSON.parse((await regularFile(root, 'ready.json')).toString('utf8')),
            );
            if (ready.key === key) {
              await installed(root, ready.nodeModules, before.nodeModules);
              source = { path: root, nodeModules: ready.nodeModules };
            }
          } catch {
            /* Only a complete merge generation with the identical key can be reused. */
          }
          if (source) {
            for (const entry of before.nodeModules) {
              await packageTargets(request.repoPath, before.nodeModules);
              await rm(path.join(request.repoPath, entry), { recursive: true, force: true });
            }
            const copied = await copyDependencyTrees({
              source: source.path,
              target: request.repoPath,
              platform: process.platform,
              timeoutMs: remaining(),
              signal,
            });
            await installed(request.repoPath, copied, before.nodeModules);
          } else {
            await execute(npmCiCommand(paths));
          }
          remaining();
          const after = await readInputs();
          if (keyOf(after) !== key) continue;
          await packageTargets(request.repoPath, after.nodeModules);
          const nodeModules: string[] = [];
          for (const relative of after.nodeModules) {
            if ((await lstat(path.join(request.repoPath, relative)).catch(() => null))?.isDirectory())
              nodeModules.push(relative);
          }
          await installed(request.repoPath, nodeModules, after.nodeModules);
          remaining();
          await directories(store, path.basename(markerDir));
          const temp = path.join(markerDir, `ready-${randomBytes(8).toString('hex')}.tmp`);
          try {
            await writeFile(
              temp,
              JSON.stringify({ version: 1, key, nodeModules, preparedAt: new Date().toISOString() }),
              { mode: 0o600, flag: 'wx' },
            );
            remaining();
            await rename(temp, marker);
            try {
              remaining();
            } catch (err) {
              await rm(marker, { force: true });
              throw err;
            }
          } finally {
            await rm(temp, { force: true });
          }
          failures.delete(request.repoPath);
          return { status: 'ready' as const, key, changed: true };
        } finally {
          await lock.release();
        }
      }
    } catch (err) {
      let failure = signal.aborted
        ? new WorkspaceDependencyError('aborted', key)
        : err instanceof WorkspaceDependencyError
          ? err
          : err instanceof HeavyLockError
            ? new WorkspaceDependencyError(err.code, key)
            : new WorkspaceDependencyError(
                err instanceof DependencyPreparationError ? 'invalid_inputs' : 'install_failed',
                key,
              );
      outcome = failure.details.reason;
      exitCode = failure.details.exitCode;
      if (MEMOIZED.has(failure.details.reason)) {
        const previous = failures.get(request.repoPath);
        if (
          previous?.key === key &&
          previous.error.details.reason === failure.details.reason &&
          Date.now() - previous.at < WORKSPACE_DEPENDENCY_RETRY_MS
        )
          failure = previous.error;
        // Reading a memo never extends its retry deadline.
        if (previous?.error !== failure)
          failures.set(request.repoPath, { key, at: Date.now(), error: failure });
      }
      throw failure;
    } finally {
      if (madeRunDir) await rm(paths.runDir, { recursive: true, force: true }).catch(() => undefined);
      options.logger.info(
        {
          project: request.project,
          member: request.member,
          repo: request.repo,
          key,
          outcome,
          durationMs: Date.now() - started,
          exitCode,
          waitedMs,
        },
        'workspace dependency preparation ended',
      );
    }
  }

  return {
    async prepare(request, { waitMs }) {
      const setup = options.setupOf(request.project, request.repo);
      if (!setup) return { status: 'skipped', reason: 'not_configured' };
      if (closed) throw new WorkspaceDependencyError('aborted', null);
      let preparation = running.get(request.repoPath);
      if (!preparation) {
        const controller = new AbortController();
        const promise = run(request, setup.timeoutMs, controller.signal).finally(() =>
          running.delete(request.repoPath),
        );
        preparation = { startedAt: new Date().toISOString(), controller, promise };
        running.set(request.repoPath, preparation);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          preparation.promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(new Error('workspace dependency preparation is still running'), {
                    code: 'workspace_dependencies_pending',
                    details: { startedAt: preparation.startedAt },
                  }),
                ),
              Math.max(0, waitMs),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    busy: (repoPath) => running.has(repoPath),
    async close() {
      closed = true;
      for (const preparation of running.values()) preparation.controller.abort();
      await Promise.allSettled([...running.values()].map((preparation) => preparation.promise));
    },
  };
}
