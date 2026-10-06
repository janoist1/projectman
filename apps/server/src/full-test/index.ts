import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { FullTestErrorReason } from '@projectman/shared';
import type { FullTestExecutor, FullTestResult, FullTestSpec } from '../contracts';
import { acquireHeavyLock, HeavyLockError } from './heavy-lock';
import type { HeavyLock } from './heavy-lock';
import { failedFiles, outputTail } from './output';
import { runSandboxed, srtCli } from './run-sandboxed';
import type { SandboxedEnd } from './run-sandboxed';
import { FULL_TEST_GIT_CONFIG, fullTestEnv, runDirOf, runPaths, srtSettings, SHORT_ROOT } from './sandbox';
import type { RunPaths } from './sandbox';

export { failedFiles, outputTail, stripAnsi } from './output';
export { acquireHeavyLock, defaultHeavyLockDir, HeavyLockError, readHeavyQueue } from './heavy-lock';
export type { HeavyLock, HeavyLockEntry, HeavyLockOptions } from './heavy-lock';
export { runSandboxed, srtCli } from './run-sandboxed';
export type { SandboxedEnd, SandboxedRun } from './run-sandboxed';
export { createScreenshotExecutor, screenshotEnv, screenshotSettings } from './screenshots';
export {
  closedStdin,
  fullTestEnv,
  niceSrtCommand,
  quoteShellWord,
  runDirOf,
  runPaths,
  srtSettings,
} from './sandbox';

/** The probes (a sandbox start each) must be quick. */
const PROBE_TIMEOUT_MS = 60_000;

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
  ): Promise<SandboxedEnd> =>
    runSandboxed({
      cwd: spec.cwd,
      env: fullTestEnv(paths, spec.maxWorkers, baseEnv),
      settings: paths.settings,
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
    outputTail: outputTail(output),
  });

  return {
    async available() {
      if (process.platform !== 'darwin')
        return { ok: false, reason: `the sandbox needs macOS (this is ${process.platform})` };
      try {
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

    async run(spec, signal) {
      // Behind the machine's other heavy runs (PM-332): the wait is not part of the run, so `started`
      // (the duration and the timeout) begins when the lock is held.
      let lock: HeavyLock | undefined;
      if (options.heavyLockDir) {
        try {
          lock = await acquireHeavyLock({
            dir: options.heavyLockDir,
            label: `server full test ${path.basename(spec.cwd)}`,
            signal,
          });
        } catch (err) {
          if (signal.aborted) return failure('killed', Date.now());
          // Nothing is held back because of the lock: without it the run goes on.
          if (err instanceof HeavyLockError && err.code === 'heavy_lock_unavailable')
            logger.warn({ err, runId: spec.runId }, 'the heavy-run queue is unavailable; running without it');
          else throw err;
        }
      }
      try {
        return await runLocked(spec, signal);
      } finally {
        await lock?.release();
      }
    },
  };

  /** One run, with the machine's lock held (or without the queue). */
  async function runLocked(spec: FullTestSpec, signal: AbortSignal): Promise<FullTestResult> {
    const started = Date.now();
    const paths = runPaths(runDirOf(tmpRoot, SHORT_ROOT, spec.runId));
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
      const base = await execute(paths, spec, "/bin/sh -c 'node --version'", PROBE_TIMEOUT_MS, signal);
      if (base.aborted) return failure('killed', started);
      if (base.spawnError) return failure('spawn_failed', started, base.output);
      if (base.exitCode !== 0 || base.timedOut)
        return failure('sandbox_unavailable', started, base.output, base.exitCode);
      // A PTY can be opened in it (the vitest configuration of the server fails without): so a
      // run that cannot open one never sends a card back.
      const pty = await execute(
        paths,
        spec,
        '/usr/bin/script -q /dev/null /usr/bin/true',
        PROBE_TIMEOUT_MS,
        signal,
      );
      if (pty.aborted) return failure('killed', started);
      if (pty.exitCode !== 0 || pty.timedOut)
        return failure('pty_unavailable', started, pty.output, pty.exitCode);

      const ended = await execute(paths, spec, spec.command, spec.timeoutMs, signal);
      const durationMs = Date.now() - started;
      if (ended.aborted) return failure('killed', started, ended.output);
      if (ended.spawnError) return failure('spawn_failed', started, ended.output);
      if (ended.timedOut) return failure('timeout', started, ended.output);
      if (ended.signal) return failure('killed', started, ended.output);
      if (ended.exitCode === 0)
        return { outcome: 'passed', exitCode: 0, durationMs, failedFiles: [], outputTail: '' };
      return {
        outcome: 'failed',
        exitCode: ended.exitCode,
        durationMs,
        failedFiles: failedFiles(ended.output),
        outputTail: outputTail(ended.output),
      };
    } catch (err) {
      logger.warn({ err, runId: spec.runId }, 'the full test run failed to start');
      return failure('spawn_failed', started);
    } finally {
      await rm(paths.runDir, { recursive: true, force: true }).catch((err: unknown) =>
        logger.warn({ err, runId: spec.runId }, 'could not remove the full test run directory'),
      );
    }
  }
}
