import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenshotRunSpec } from '../contracts';
import { acquireHeavyLock, readHeavyQueue } from './heavy-lock';
import type { HeavyLock } from './heavy-lock';
import {
  createScreenshotExecutor,
  screenshotCommand,
  screenshotEnv,
  screenshotSettings,
} from './screenshots';
import { quoteShellWord, runPaths, SRT_DEFAULT_TMP } from './sandbox';

/** The sandbox of the screenshot runs (PM-351): its settings, environment and command, and its queue. */
const NO_TMP = '/pm-no-such-root';

const spec: ScreenshotRunSpec = {
  runId: 'shr_abcdef12345678',
  cwd: '/work/PM-1-checkout',
  sessionDir: '/sessions/ses_1.0123456789abcdef',
  browsersDir: '/app/browsers',
  args: ['/work/PM-1-checkout/shots/login.mjs', '--widths', '390,1280'],
  sandbox: {
    allowWrite: ['/sessions/ses_1.0123456789abcdef', '/work/PM-1-checkout'],
    denyWrite: ['/work/PM-1-checkout/.git/hooks'],
    denyRead: ['/Users/me'],
    allowRead: ['/work/PM-1-checkout', '/app/browsers'],
  },
  label: 'shots PM-1 codex',
  timeoutMs: 100,
};

const paths = runPaths('/private/tmp/pmft-12345678');

describe('screenshotSettings', () => {
  it('keeps the session limits, adds the own directory, closes the shared temporary directory and the net', () => {
    const settings = screenshotSettings(spec, paths);
    expect(settings.network).toEqual({ allowedDomains: [], deniedDomains: [], allowLocalBinding: true });
    expect(settings.filesystem.denyRead).toEqual(['/Users/me']);
    expect(settings.filesystem.allowRead).toEqual([...spec.sandbox.allowRead, paths.sandbox]);
    expect(settings.filesystem.allowWrite).toEqual([...spec.sandbox.allowWrite, paths.sandbox]);
    expect(settings.filesystem.denyWrite).toEqual([...spec.sandbox.denyWrite, ...SRT_DEFAULT_TMP]);
    // Not the run directory itself: `settings.json` stays unwritable for the command.
    expect(settings.filesystem.allowWrite).not.toContain(paths.runDir);
    expect(settings.allowPty).toBe(true);
  });
});

describe('screenshotEnv', () => {
  const base = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    HOME: '/Users/me',
    PROJECTMAN_HOME: '/Users/me/.projectman',
    PROJECTMAN_AUTH_SECRET: 'secret',
    GH_TOKEN: 'token',
    ANTHROPIC_API_KEY: 'key',
    OPENAI_API_KEY: 'key',
    SSH_AUTH_SOCK: '/tmp/agent',
  };

  it('has the allow list only: the session folder, the browsers, its own home and temporary directory', () => {
    const env = screenshotEnv(spec, paths, base);
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
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
      PROJECTMAN_HEAVY_LOCK_HELD: '1',
      PLAYWRIGHT_BROWSERS_PATH: '/app/browsers',
      LANG: 'en_US.UTF-8',
    });
  });

  it('leaves the browsers variable out when the server has none, and falls back to a plain PATH', () => {
    const { browsersDir: _browsers, ...withoutBrowsers } = spec;
    const env = screenshotEnv(withoutBrowsers, paths, {});
    expect(env).not.toHaveProperty('PLAYWRIGHT_BROWSERS_PATH');
    expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });
});

describe('screenshotCommand', () => {
  it('quotes every argument as one word', () => {
    expect(quoteShellWord("it's")).toBe(`'it'\\''s'`);
    expect(screenshotCommand(['/w/a b.mjs', '--widths', '390', `x'; rm -rf /`])).toBe(
      `npm run shots -- '/w/a b.mjs' '--widths' '390' 'x'\\''; rm -rf /'`,
    );
  });
});

describe('the screenshot executor', () => {
  let root: string;
  let dir: string;
  const locks: HeavyLock[] = [];
  const warn = vi.fn();
  const logger = { warn } as unknown as FastifyBaseLogger;
  const started = vi.fn();

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'pm-shots-exec-'));
    dir = path.join(root, 'heavy');
    warn.mockClear();
    started.mockClear();
  });
  afterEach(async () => {
    await Promise.all(locks.splice(0).map((lock) => lock.release()));
    rmSync(root, { recursive: true, force: true });
  });

  const hold = async (label: string): Promise<HeavyLock> => {
    const lock = await acquireHeavyLock({ dir, label, pollMs: 20 });
    locks.push(lock);
    return lock;
  };

  it('ends with a sandbox error, never started, when its run directory cannot be made', async () => {
    const executor = createScreenshotExecutor({ logger, tmpDir: NO_TMP });
    const result = await executor.run(spec, new AbortController().signal, started);
    expect(result).toMatchObject({ exitCode: null, timedOut: false, aborted: false });
    expect(result.spawnError).toBe('could not prepare the run directory');
    expect(started).not.toHaveBeenCalled();
  });

  it('does not run an already stopped run', async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = createScreenshotExecutor({ logger, tmpDir: NO_TMP });
    expect(await executor.run(spec, controller.signal, started)).toMatchObject({ aborted: true });
    expect(started).not.toHaveBeenCalled();
  });

  it('waits for its turn in the heavy-run queue and gives the lock back', async () => {
    const other = await hold('a member run');
    setTimeout(() => void other.release(), 500);
    const executor = createScreenshotExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: dir });
    const waitStarted = Date.now();
    const result = await executor.run(spec, new AbortController().signal, started);
    expect(Date.now() - waitStarted).toBeGreaterThanOrEqual(400);
    expect(result.spawnError).toBe('could not prepare the run directory');
    expect((await readHeavyQueue(dir)).holder).toBeNull();
  });

  it('names the waiting run by the label the server gave it', async () => {
    const other = await hold('a member run');
    const executor = createScreenshotExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: dir });
    const running = executor.run(spec, new AbortController().signal, started);
    const deadline = Date.now() + 5000;
    let waiting = (await readHeavyQueue(dir)).waiting;
    while (waiting.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      waiting = (await readHeavyQueue(dir)).waiting;
    }
    expect(waiting.map((entry) => entry.label)).toEqual(['shots PM-1 codex']);
    await other.release();
    await running;
  });

  it('ends as stopped when it is stopped while it waits, and leaves the queue', async () => {
    const other = await hold('a member run');
    const controller = new AbortController();
    const executor = createScreenshotExecutor({ logger, tmpDir: NO_TMP, heavyLockDir: dir });
    const running = executor.run(spec, controller.signal, started);
    setTimeout(() => controller.abort(), 150);
    expect(await running).toMatchObject({ aborted: true, exitCode: null });
    expect(started).not.toHaveBeenCalled();
    expect((await readHeavyQueue(dir)).waiting).toEqual([]);
    await other.release();
  });
});
