import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { mergeTestReport } from '@projectman/shared';
import type { FullTestErrorReason } from '@projectman/shared';
import type { FullTestExecutor, FullTestResult, FullTestSpec } from '../contracts';
import { acquireHeavyLock, HeavyLockError } from './heavy-lock';
import type { HeavyLock } from './heavy-lock';
import { failedFiles, failureReport, passedOutputTail } from './output';
import { runSandboxed, srtCli } from './run-sandboxed';
import type { SandboxedEnd } from './run-sandboxed';
import {
  canonicalRoot,
  FULL_TEST_GIT_CONFIG,
  fullTestEnv,
  runDirOf,
  runPaths,
  srtSettings,
  SHORT_ROOT,
} from './sandbox';
import type { RunPaths } from './sandbox';
import { assertNpmCiCheckout, DependencyPreparationError, prepareNpmCi } from './npm-ci';
import { prepareStepCache } from './step-cache';
export { assertNpmCiCheckout } from './npm-ci';
export { createWorkspaceDependencyInstaller, WORKSPACE_DEPENDENCY_RETRY_MS } from './workspace-dependencies';
export type { WorkspaceDependencyInstallerOptions } from './workspace-dependencies';

export { failedFiles, failureReport, outputTail, stripAnsi } from './output';
export { acquireHeavyLock, HeavyLockError, readHeavyQueue, readHeavyRunSessions } from './heavy-lock';
export { defaultHeavyLockDir } from './heavy-lock-dir';
export type { HeavyLock, HeavyLockEntry, HeavyLockOptions } from './heavy-lock';
export { runSandboxed, srtCli } from './run-sandboxed';
export type { SandboxedEnd, SandboxedRun } from './run-sandboxed';
export { createScreenshotExecutor, screenshotEnv, screenshotSettings } from './screenshots';
export {
  canonicalRoot,
  closedStdin,
  fullTestEnv,
  installerSettings,
  niceSrtCommand,
  quoteShellWord,
  runDirOf,
  runPaths,
  srtSettings,
} from './sandbox';

/** The probes (a sandbox start each) must be quick. */
const PROBE_TIMEOUT_MS = 60_000;
let sandboxRuntime: Promise<typeof import('@anthropic-ai/sandbox-runtime')> | undefined;

export interface FullTestExecutorOptions {
  logger: FastifyBaseLogger;
  /** Where the run directories are made; default `os.tmpdir()`. */
  tmpDir?: string;
  /** The environment the run's allowed variables are taken from; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * The machine's heavy-run queue (`heavy-lock.ts`, PM-332): given, a run waits for its turn behind
   * the members' full tests, and the wait does not count against `timeoutMs`.
   */
  heavyLockDir?: string;
  /** Engine-local root of merge checkouts and the dependency store. */
  worktreesRoot?: string;
  /** Engine-local passed merge-test steps; absent disables the cache. */
  stepCacheFile?: string;
}

/**
 * Runs the full test in the Anthropic Sandbox Runtime (`srt`, pinned in package.json) as a child
 * process (PM-217): macOS (Seatbelt) only. The run directory (`<tmp>/pmft-<end of the run id>`)
 * holds `settings.json`, which the command cannot write, and `sandbox/` (home, tmp, npm cache, git
 * configuration), the only place it writes. It is removed after every run.
 */
export function createFullTestExecutor(options: FullTestExecutorOptions): FullTestExecutor {
  const { logger } = options;
  const baseEnv = options.env ?? process.env;
  const tmpRoot = options.tmpDir ?? os.tmpdir();

  /** One sandboxed command; the process group is stopped on abort and after `timeoutMs`. */
  const execute = (
    paths: RunPaths,
    spec: FullTestSpec,
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    settings = paths.settings,
    passedKeysFile?: string,
  ): Promise<SandboxedEnd> =>
    runSandboxed({
      cwd: spec.cwd,
      env: fullTestEnv(paths, spec.maxWorkers, baseEnv, passedKeysFile),
      settings,
      command,
      timeoutMs,
      signal,
    });

  const failure = (
    reason: FullTestErrorReason,
    started: number,
    output = '',
    exitCode: number | null = null,
  ): FullTestResult => ({
    outcome: 'error',
    reason,
    exitCode,
    durationMs: Date.now() - started,
    failedFiles: [],
    outputTail: failureReport(output),
  });

  return {
    async available() {
      if (process.platform !== 'darwin')
        return { ok: false, reason: `the sandbox needs macOS (this is ${process.platform})` };
      try {
        const { SandboxManager } = await (sandboxRuntime ??= import('@anthropic-ai/sandbox-runtime'));
        if (!SandboxManager.isSupportedPlatform())
          return { ok: false, reason: 'the sandbox runtime does not support this platform' };
        const check = await SandboxManager.checkDependenciesAsync();
        if (check.errors.length > 0) return { ok: false, reason: check.errors.join('; ') };
        srtCli();
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async run(spec, signal, onStarted) {
      // The GitHub Actions merge check (PM-900) is orchestrated by the engine's own executor, not here.
      if (spec.githubActions)
        return {
          outcome: 'error',
          reason: 'github_unavailable',
          exitCode: null,
          durationMs: 0,
          failedFiles: [],
          outputTail: 'This engine runs no GitHub Actions check.',
        };
      if (spec.npmCi) {
        try {
          await assertNpmCiCheckout(options.worktreesRoot, spec);
        } catch (err) {
          return {
            ...failure('dependency_install_failed', Date.now(), err instanceof Error ? err.message : ''),
            durationMs: 0,
          };
        }
      }
      // Behind the machine's other heavy runs (PM-332): the wait is not part of the run, so `started`
      // (the duration and the timeout) begins when the lock is held.
      let lock: HeavyLock | undefined;
      // A run that requires the queue (the merge check, PM-658) never goes on without it.
      const unavailable = (cause?: unknown): FullTestResult => ({
        outcome: 'error',
        reason: 'heavy_lock_unavailable',
        exitCode: null,
        durationMs: 0,
        failedFiles: [],
        outputTail: failureReport(
          `the machine's heavy-run queue is unavailable${cause instanceof Error ? `: ${cause.message}` : ''}`,
        ),
      });
      if (!options.heavyLockDir) {
        if (spec.requireHeavyLock) return signal.aborted ? failure('killed', Date.now()) : unavailable();
      } else {
        try {
          lock = await acquireHeavyLock({
            dir: options.heavyLockDir,
            label: `server full test ${path.basename(spec.cwd)}`,
            signal,
          });
        } catch (err) {
          if (signal.aborted) return failure('killed', Date.now());
          if (spec.requireHeavyLock) {
            logger.warn({ err, runId: spec.runId }, 'the heavy-run queue is required but unavailable');
            return unavailable(err);
          }
          // Nothing is held back because of the lock: without it the run goes on.
          if (err instanceof HeavyLockError && err.code === 'heavy_lock_unavailable')
            logger.warn({ err, runId: spec.runId }, 'the heavy-run queue is unavailable; running without it');
          else throw err;
        }
      }
      try {
        // The run's turn has come (or it needs none): a run stopped while it waited never starts.
        if (!signal.aborted) onStarted?.();
        return await runLocked(spec, signal);
      } finally {
        await lock?.release();
      }
    },
  };

  /** One run, with the machine's lock held (or without the queue). */
  async function runLocked(spec: FullTestSpec, signal: AbortSignal): Promise<FullTestResult> {
    const started = Date.now();
    let paths: RunPaths;
    try {
      paths = runPaths(runDirOf(canonicalRoot(tmpRoot), canonicalRoot(SHORT_ROOT), spec.runId));
    } catch (err) {
      logger.warn({ err, runId: spec.runId }, 'no run directory root leaves room for the sandbox sockets');
      return failure('sandbox_unavailable', started);
    }
    const remaining = () => {
      if (signal.aborted) throw new DependencyPreparationError('', 'killed');
      const ms = spec.timeoutMs - (Date.now() - started);
      if (ms <= 0) throw new DependencyPreparationError('', 'timeout');
      return ms;
    };
    const budget = (probe = false) =>
      spec.npmCi
        ? Math.min(probe ? PROBE_TIMEOUT_MS : Infinity, remaining())
        : probe
          ? PROBE_TIMEOUT_MS
          : spec.timeoutMs;
    // Not recursive: a directory or a link someone made at that name beforehand is an error, never
    // reused, and never removed below.
    let created = false;
    try {
      await mkdir(paths.runDir, { mode: 0o700 });
      created = true;
      await mkdir(paths.home, { recursive: true });
      await mkdir(paths.tmp, { recursive: true });
      await mkdir(paths.npmCache, { recursive: true });
      await writeFile(paths.gitConfig, FULL_TEST_GIT_CONFIG);
      await writeFile(paths.settings, JSON.stringify(srtSettings(spec, paths), null, 2), { mode: 0o600 });
    } catch (err) {
      logger.warn({ err, runId: spec.runId }, 'could not prepare the full test run directory');
      if (created) await rm(paths.runDir, { recursive: true, force: true }).catch(() => undefined);
      return failure('sandbox_unavailable', started);
    }
    try {
      // The sandbox works, and runs node, before the real command: a broken sandbox is an error, not
      // a failing test.
      const base = await execute(paths, spec, "/bin/sh -c 'node --version'", budget(true), signal);
      if (base.aborted) return failure('killed', started);
      if (base.spawnError) return failure('spawn_failed', started, base.output);
      if (spec.npmCi && base.timedOut) return failure('timeout', started, base.output);
      if (spec.npmCi && base.signal) return failure('killed', started, base.output);
      if (base.exitCode !== 0 || base.timedOut)
        return failure('sandbox_unavailable', started, base.output, base.exitCode);
      // A PTY can be opened in it (the vitest configuration of the server fails without): so a
      // run that cannot open one never sends a card back.
      const pty = await execute(
        paths,
        spec,
        '/usr/bin/script -q /dev/null /usr/bin/true',
        budget(true),
        signal,
      );
      if (pty.aborted) return failure('killed', started);
      if (spec.npmCi && pty.spawnError) return failure('spawn_failed', started, pty.output);
      if (spec.npmCi && pty.timedOut) return failure('timeout', started, pty.output);
      if (spec.npmCi && pty.signal) return failure('killed', started, pty.output);
      if (pty.exitCode !== 0 || pty.timedOut)
        return failure('pty_unavailable', started, pty.output, pty.exitCode);

      if (spec.npmCi)
        await prepareNpmCi({
          spec,
          paths,
          worktreesRoot: options.worktreesRoot!,
          nodeVersion: base.output.trim(),
          remaining,
          signal,
          execute: (command, settings, timeoutMs) =>
            execute(paths, spec, command, timeoutMs, signal, settings),
        });
      const cache = await prepareStepCache(
        options.stepCacheFile,
        path.join(paths.sandbox, 'merge-test-passed-keys'),
        spec.runId,
        logger,
      );
      const commandStarted = Date.now();
      const ended = await execute(
        paths,
        spec,
        spec.command,
        budget(),
        signal,
        paths.settings,
        cache?.passedKeysFile,
      );
      const commandMs = Date.now() - commandStarted;
      await cache?.record(ended.output);
      const durationMs = Date.now() - started;
      // The command ran: what it measured stays, even when it was stopped (PM-876).
      const report = mergeTestReport(ended.output, commandMs);
      if (ended.aborted) return { ...failure('killed', started, ended.output), report };
      if (ended.spawnError) return failure('spawn_failed', started, ended.output);
      if (ended.timedOut) return { ...failure('timeout', started, ended.output), report };
      if (ended.signal) return { ...failure('killed', started, ended.output), report };
      if (ended.exitCode === 0)
        return {
          outcome: 'passed',
          exitCode: 0,
          durationMs,
          failedFiles: [],
          outputTail: passedOutputTail(ended.output),
          report,
        };
      return {
        outcome: 'failed',
        exitCode: ended.exitCode,
        durationMs,
        failedFiles: failedFiles(ended.output),
        outputTail: failureReport(ended.output),
        report,
      };
    } catch (err) {
      logger.warn({ err, runId: spec.runId }, 'the full test run failed to start');
      if (signal.aborted) return failure('killed', started);
      if (spec.npmCi && Date.now() - started >= spec.timeoutMs) return failure('timeout', started);
      if (err instanceof DependencyPreparationError)
        return failure(err.reason, started, err.message, err.exitCode);
      return failure(
        spec.npmCi ? 'dependency_install_failed' : 'spawn_failed',
        started,
        spec.npmCi && err instanceof Error ? err.message : '',
      );
    } finally {
      await rm(paths.runDir, { recursive: true, force: true }).catch((err: unknown) =>
        logger.warn({ err, runId: spec.runId }, 'could not remove the full test run directory'),
      );
    }
  }
}
