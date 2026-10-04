import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { FullTestErrorReason } from '@projectman/shared';
import type { FullTestExecutor, FullTestResult, FullTestSpec } from '../contracts';
import { failedFiles, outputTail, OutputTail } from './output';
import {
  FULL_TEST_GIT_CONFIG,
  fullTestEnv,
  niceSrtCommand,
  runDirOf,
  runPaths,
  sandboxedCommand,
  srtSettings,
} from './sandbox';
import type { RunPaths } from './sandbox';

export { failedFiles, outputTail, stripAnsi } from './output';
export { fullTestEnv, niceSrtCommand, runDirOf, runPaths, sandboxedCommand, srtSettings } from './sandbox';

/** A short temporary root for when `tmpDir` is too deep for the sandbox's socket (macOS: `/tmp` is a link to this). */
const SHORT_ROOT = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
/** How long a stopped run gets to end on its own before the process group is killed. */
const KILL_GRACE_MS = 10_000;
/** The probes (a sandbox start each) must be quick. */
const PROBE_TIMEOUT_MS = 60_000;

export interface FullTestExecutorOptions {
  logger: FastifyBaseLogger;
  /** Where the run directories are made; default `os.tmpdir()`. */
  tmpDir?: string;
  /** The environment the run's allowed variables are taken from; default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

interface Ended {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
  timedOut: boolean;
  aborted: boolean;
  output: string;
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

  const srtCli = (): string => {
    const manifest = createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json');
    return path.join(path.dirname(manifest), 'dist', 'cli.js');
  };

  /** One sandboxed command; the process group is stopped on abort and after `timeoutMs`. */
  async function execute(
    paths: RunPaths,
    spec: FullTestSpec,
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Ended> {
    return await new Promise<Ended>((resolve) => {
      const tail = new OutputTail();
      let timedOut = false;
      let aborted = false;
      let killTimer: NodeJS.Timeout | undefined;
      let settled = false;
      const start = niceSrtCommand(
        process.execPath,
        srtCli(),
        paths.settings,
        sandboxedCommand(paths, command),
      );
      const child = spawn(start.file, start.args, {
        cwd: spec.cwd,
        env: fullTestEnv(paths, spec.maxWorkers, baseEnv),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const killGroup = (sig: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          // The group is already gone.
        }
      };
      const stop = (): void => {
        killGroup('SIGTERM');
        killTimer ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const onAbort = (): void => {
        aborted = true;
        stop();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      const finish = (ended: Omit<Ended, 'timedOut' | 'aborted' | 'output'>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        // A child that detached itself may outlive the shell; the group is stopped either way.
        killGroup('SIGKILL');
        if (killTimer) clearTimeout(killTimer);
        resolve({ ...ended, timedOut, aborted, output: tail.value() });
      };
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => tail.push(chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => tail.push(chunk));
      child.on('error', (spawnError) => finish({ exitCode: null, signal: null, spawnError }));
      child.on('close', (exitCode, exitSignal) => finish({ exitCode, signal: exitSignal }));
    });
  }

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
    },
  };
}
