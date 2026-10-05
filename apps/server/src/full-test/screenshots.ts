import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import type { ScreenshotExecutor, ScreenshotRunEnded, ScreenshotRunSpec } from '../contracts';
import { acquireHeavyLock, HeavyLockError } from './heavy-lock';
import type { HeavyLock } from './heavy-lock';
import type { FullTestExecutorOptions } from './index';
import { runSandboxed } from './run-sandboxed';
import {
  FULL_TEST_GIT_CONFIG,
  SHORT_ROOT,
  SRT_DEFAULT_TMP,
  quoteShellWord,
  runDirOf,
  runPaths,
} from './sandbox';
import type { RunPaths } from './sandbox';

/**
 * The `srt` settings of a screenshot run: as the full test's (`srtSettings`) with the session's own
 * limits. It reads what the session's sandbox reads, and writes what it writes (its session folder
 * among them) and the run's own `sandbox` directory; nothing outward, local ports open (decision 24).
 */
export function screenshotSettings(spec: ScreenshotRunSpec, paths: RunPaths) {
  return {
    network: { allowedDomains: [] as string[], deniedDomains: [] as string[], allowLocalBinding: true },
    filesystem: {
      denyRead: [...new Set(spec.sandbox.denyRead)],
      allowRead: [...new Set([...spec.sandbox.allowRead, paths.sandbox])],
      allowWrite: [...new Set([...spec.sandbox.allowWrite, paths.sandbox])],
      // srt's own default temporary directory is shared with the members' sandboxes: a run may not write there.
      denyWrite: [...new Set([...spec.sandbox.denyWrite, ...SRT_DEFAULT_TMP])],
    },
    allowPty: true,
  };
}

/**
 * The environment of a screenshot run: an allow list, as the full test's. No other `PROJECTMAN_*`,
 * token, `SSH_AUTH_SOCK` or billing variable gets in.
 */
export function screenshotEnv(
  spec: ScreenshotRunSpec,
  paths: RunPaths,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: base.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: paths.home,
    TMPDIR: paths.tmp,
    CLAUDE_CODE_TMPDIR: paths.tmp,
    npm_config_cache: paths.npmCache,
    npm_config_update_notifier: 'false',
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    PROJECTMAN_SESSION_DIR: spec.sessionDir,
    // The server holds the machine's heavy-run lock for the run: `npm run shots` does not queue again.
    PROJECTMAN_HEAVY_LOCK_HELD: '1',
  };
  if (spec.browsersDir) env.PLAYWRIGHT_BROWSERS_PATH = spec.browsersDir;
  for (const name of ['LANG', 'LC_ALL'] as const) {
    const value = base[name];
    if (value) env[name] = value;
  }
  return env;
}

/** `npm run shots -- <args>`: every argument one quoted word. */
export function screenshotCommand(args: readonly string[]): string {
  return ['npm run shots --', ...args.map(quoteShellWord)].join(' ');
}

const ended = (partial: Partial<ScreenshotRunEnded>): ScreenshotRunEnded => ({
  exitCode: null,
  timedOut: false,
  aborted: false,
  output: '',
  ...partial,
});

/**
 * Runs `npm run shots` of a Codex member's worktree in the Anthropic Sandbox Runtime (PM-351), where
 * Chromium starts (it does not in Codex's own sandbox). The run directory is the full test's
 * (`runDirOf`, `runPaths`): `settings.json` (not writable for the command) and `sandbox/` (home, tmp,
 * npm cache, git configuration). It is removed after every run.
 */
export function createScreenshotExecutor(options: FullTestExecutorOptions): ScreenshotExecutor {
  const { logger } = options;
  const baseEnv = options.env ?? process.env;
  const tmpRoot = options.tmpDir ?? os.tmpdir();

  return {
    async run(spec, signal, onStarted) {
      // Behind the machine's other heavy runs (PM-332): the wait is not part of the run's time.
      let lock: HeavyLock | undefined;
      if (options.heavyLockDir) {
        try {
          lock = await acquireHeavyLock({ dir: options.heavyLockDir, label: spec.label, signal });
        } catch (err) {
          if (signal.aborted) return ended({ aborted: true });
          // Nothing is held back because of the lock: without it the run goes on.
          if (err instanceof HeavyLockError && err.code === 'heavy_lock_unavailable')
            logger.warn({ err, runId: spec.runId }, 'the heavy-run queue is unavailable; running without it');
          else throw err;
        }
      }
      try {
        return await runLocked(spec, signal, onStarted);
      } finally {
        await lock?.release();
      }
    },
  };

  async function runLocked(
    spec: ScreenshotRunSpec,
    signal: AbortSignal,
    onStarted: () => void,
  ): Promise<ScreenshotRunEnded> {
    if (signal.aborted) return ended({ aborted: true });
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
      await writeFile(paths.settings, JSON.stringify(screenshotSettings(spec, paths), null, 2), {
        mode: 0o600,
      });
    } catch (err) {
      logger.warn({ err, runId: spec.runId }, 'could not prepare the screenshot run directory');
      if (created) await rm(paths.runDir, { recursive: true, force: true }).catch(() => undefined);
      return ended({ spawnError: 'could not prepare the run directory' });
    }
    try {
      const run = runSandboxed({
        cwd: spec.cwd,
        env: screenshotEnv(spec, paths, baseEnv),
        settings: paths.settings,
        command: screenshotCommand(spec.args),
        timeoutMs: spec.timeoutMs,
        signal,
      });
      onStarted();
      const result = await run;
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        aborted: result.aborted,
        ...(result.spawnError ? { spawnError: result.spawnError.message } : {}),
        output: result.output,
      };
    } catch (err) {
      logger.warn({ err, runId: spec.runId }, 'the screenshot run failed to start');
      return ended({ spawnError: err instanceof Error ? err.message : String(err) });
    } finally {
      await rm(paths.runDir, { recursive: true, force: true }).catch((err: unknown) =>
        logger.warn({ err, runId: spec.runId }, 'could not remove the screenshot run directory'),
      );
    }
  }
}
