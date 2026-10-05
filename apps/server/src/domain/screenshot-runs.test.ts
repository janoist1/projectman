import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamToolError } from '../contracts';
import type {
  ScreenshotExecutor,
  ScreenshotRunEnded,
  ScreenshotRunSpec,
  ScreenshotScope,
  ToolContext,
} from '../contracts';
import { listImages, ScreenshotRuns, scenarioPath, screenshotArgs } from './screenshot-runs';

/** The screenshot runs of the session members (PM-351), with an executor that does not start anything. */
let base: string;
let cwd: string;
let sessionDir: string;
let scope: ScreenshotScope | undefined;
const warn = vi.fn();
const logger = { warn } as unknown as FastifyBaseLogger;

const ctx: ToolContext = { sessionId: 'ses_1', projectKey: 'PM', member: 'codex', taskKey: 'PM-1' };
const other: ToolContext = { ...ctx, sessionId: 'ses_2' };

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-shot-runs-')));
  cwd = path.join(base, 'work');
  sessionDir = path.join(base, 'session');
  mkdirSync(path.join(cwd, 'shots'), { recursive: true });
  mkdirSync(path.join(sessionDir, 'shots'), { recursive: true });
  writeFileSync(path.join(cwd, 'shots', 'login.mjs'), 'export default {};');
  scope = {
    cwd,
    sessionDir,
    browsersDir: '/app/browsers',
    sandbox: { allowWrite: [sessionDir], denyWrite: [], denyRead: [], allowRead: [cwd] },
  };
  warn.mockClear();
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

interface Started {
  spec: ScreenshotRunSpec;
  signal: AbortSignal;
  started: () => void;
  end: (ended?: Partial<ScreenshotRunEnded>) => void;
}

/** An executor whose runs end when the test says so. */
function fakeExecutor() {
  const calls: Started[] = [];
  const executor: ScreenshotExecutor = {
    run: (spec, signal, started) =>
      new Promise((resolve) => {
        calls.push({
          spec,
          signal,
          started,
          end: (ended) => resolve({ exitCode: 0, timedOut: false, aborted: false, output: 'ok', ...ended }),
        });
        signal.addEventListener('abort', () =>
          resolve({ exitCode: null, timedOut: false, aborted: true, output: '' }),
        );
      }),
  };
  return { executor, calls };
}

function runs(options: { pollMs?: number; platform?: NodeJS.Platform; now?: () => number } = {}) {
  const fake = fakeExecutor();
  const service = new ScreenshotRuns({
    executor: fake.executor,
    sessions: {
      screenshotScope: (sessionId) => (sessionId === 'ses_1' || sessionId === 'ses_2' ? scope : undefined),
    },
    logger,
    platform: options.platform ?? 'darwin',
    pollMs: options.pollMs ?? 5_000,
    ...(options.now ? { now: options.now } : {}),
  });
  return { service, ...fake };
}

const input = { scenario: 'shots/login.mjs' };
const refusal = async (promise: Promise<unknown>): Promise<TeamToolError> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TeamToolError) return err;
    throw err;
  }
  throw new Error('expected a TeamToolError');
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const image = (name: string, atMs?: number) => {
  const file = path.join(sessionDir, 'shots', name);
  writeFileSync(file, 'png');
  if (atMs !== undefined) utimesSync(file, atMs / 1000, atMs / 1000);
  return file;
};

describe('take_screenshots', () => {
  it('starts the run with the validated arguments and the scenario real path, and returns the finished run', async () => {
    const { service, calls } = runs();
    const taking = service.take(ctx, {
      scenario: 'shots/../shots/login.mjs',
      widths: [390, 1280],
      fullPage: true,
      scale: 2,
      timeoutSeconds: 90,
      seed: 'demo',
    });
    await tick();
    expect(calls).toHaveLength(1);
    const { spec } = calls[0]!;
    expect(spec).toMatchObject({
      cwd,
      sessionDir,
      browsersDir: '/app/browsers',
      label: 'shots PM-1 codex',
      args: [
        path.join(cwd, 'shots', 'login.mjs'),
        '--widths',
        '390,1280',
        '--full-page',
        '--scale',
        '2',
        '--timeout',
        '90',
        '--seed',
        'demo',
      ],
    });
    expect(spec.runId).toMatch(/^shr_/);
    const file = image('login-390.png');
    calls[0]!.started();
    calls[0]!.end();
    const run = await taking;
    expect(run).toMatchObject({ runId: spec.runId, status: 'done', exitCode: 0, outputTail: 'ok' });
    expect(run.files).toEqual([file]);
    expect(run.finishedAt).toBeDefined();
  });

  it('answers running when the run is not over within the wait, and the run goes on', async () => {
    const { service, calls } = runs({ pollMs: 30 });
    const run = await service.take(ctx, input);
    expect(run).toMatchObject({ status: 'queued', files: [] });
    calls[0]!.started();
    expect(await service.get(ctx, run.runId)).toMatchObject({ status: 'running' });
    calls[0]!.end();
    expect(await service.get(ctx, run.runId)).toMatchObject({ status: 'done' });
  });

  it('refuses a second run of the session, naming the first, but not one of another session', async () => {
    const { service, calls } = runs({ pollMs: 20 });
    const first = await service.take(ctx, input);
    const err = await refusal(service.take(ctx, input));
    expect(err.code).toBe('invalid');
    expect(err.message).toContain(first.runId);
    await expect(service.take(other, input)).resolves.toMatchObject({ status: 'queued' });
    expect(calls).toHaveLength(2);
    calls[0]!.end();
    await service.get(ctx, first.runId);
    // Over: the session may start another.
    await expect(service.take(ctx, input)).resolves.toBeDefined();
  });

  it('is forbidden without a scope or off macOS, and starts nothing', async () => {
    const noScope = runs();
    scope = undefined;
    expect((await refusal(noScope.service.take(ctx, input))).code).toBe('forbidden');
    scope = { cwd, sessionDir, sandbox: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] } };
    const linux = runs({ platform: 'linux' });
    const err = await refusal(linux.service.take(ctx, input));
    expect(err.code).toBe('forbidden');
    expect(err.message).toContain('macOS');
    expect(noScope.calls.length + linux.calls.length).toBe(0);
  });

  it('refuses a scenario that is missing, outside, or a directory, before any run starts', async () => {
    const { service, calls } = runs();
    writeFileSync(path.join(base, 'outside.mjs'), '');
    for (const scenario of ['shots/none.mjs', '../outside.mjs', path.join(base, 'outside.mjs'), 'shots']) {
      const err = await refusal(service.take(ctx, { scenario }));
      expect(err.code).toBe('invalid');
    }
    expect(calls).toHaveLength(0);
  });

  it('keeps the image of a scenario that lies in the session folder', async () => {
    const { service, calls } = runs();
    writeFileSync(path.join(sessionDir, 'mine.mjs'), '');
    const taking = service.take(ctx, { scenario: path.join(sessionDir, 'mine.mjs') });
    await tick();
    calls[0]!.end();
    await expect(taking).resolves.toMatchObject({ status: 'done' });
  });
});

describe('how a run ends', () => {
  const ends: [string, Partial<ScreenshotRunEnded>, string, number | null][] = [
    ['a scenario that fails', { exitCode: 1 }, 'scenario', 1],
    ['wrong use or no browser', { exitCode: 2 }, 'usage', 2],
    ['the time running out', { exitCode: null, timedOut: true }, 'timeout', null],
    ['a sandbox that did not start', { exitCode: null, spawnError: 'no srt' }, 'sandbox', null],
    ['a process killed from outside', { exitCode: null }, 'sandbox', null],
  ];
  it.each(ends)('%s is %s', async (_name, ended, failure, exitCode) => {
    const { service, calls } = runs();
    const taking = service.take(ctx, input);
    await tick();
    calls[0]!.end({ output: 'the end', ...ended });
    expect(await taking).toMatchObject({ status: 'failed', failure, exitCode });
  });

  it('keeps the output tail short and lists no images that were written before the run', async () => {
    const { service, calls } = runs();
    const taking = service.take(ctx, input);
    await tick();
    image('old.png', Date.now() - 60_000);
    const fresh = image('new.png');
    image('notes.txt');
    calls[0]!.end({ output: 'x'.repeat(10_000) });
    const run = await taking;
    expect(run.files).toEqual([fresh]);
    expect(run.outputTail!.length).toBeLessThanOrEqual(4_100);
  });

  it('stops the running run when its session ends: the signal aborts and the run is stopped', async () => {
    const { service, calls } = runs({ pollMs: 20 });
    const run = await service.take(ctx, input);
    calls[0]!.started();
    service.stopSession('ses_1');
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(await service.get(ctx, run.runId)).toMatchObject({
      status: 'failed',
      failure: 'stopped',
      files: [],
    });
    // Another session's run is left alone.
    const second = await service.take(other, input);
    service.stopSession('ses_1');
    expect(calls[1]!.signal.aborted).toBe(false);
    expect(second.status).toBe('queued');
  });

  it('stops every run when the server stops', async () => {
    const { service, calls } = runs({ pollMs: 20 });
    await service.take(ctx, input);
    await service.take(other, input);
    service.stop();
    expect(calls.map((call) => call.signal.aborted)).toEqual([true, true]);
  });

  it('logs and ends as a sandbox failure when the executor throws', async () => {
    const service = new ScreenshotRuns({
      executor: { run: () => Promise.reject(new Error('boom')) },
      sessions: { screenshotScope: () => scope },
      logger,
      platform: 'darwin',
      pollMs: 1_000,
    });
    expect(await service.take(ctx, input)).toMatchObject({
      status: 'failed',
      failure: 'sandbox',
      outputTail: 'boom',
    });
    expect(warn).toHaveBeenCalled();
  });
});

describe('get_screenshot_run', () => {
  it('knows a run of its own session only', async () => {
    const { service, calls } = runs();
    const taking = service.take(ctx, input);
    await tick();
    calls[0]!.end();
    const run = await taking;
    expect((await refusal(service.get(other, run.runId))).code).toBe('not_found');
    expect((await refusal(service.get(ctx, 'shr_unknown'))).code).toBe('not_found');
    await expect(service.get(ctx, run.runId)).resolves.toMatchObject({ status: 'done' });
  });

  it('keeps an ended run for an hour and the last five of a session', async () => {
    let now = Date.now();
    const { service, calls } = runs({ now: () => now });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const taking = service.take(ctx, input);
      await tick();
      calls[i]!.end();
      const run = await taking;
      ids.push(run.runId);
      now += 1_000;
    }
    expect((await refusal(service.get(ctx, ids[0]!))).code).toBe('not_found');
    expect((await refusal(service.get(ctx, ids[1]!))).code).toBe('not_found');
    await expect(service.get(ctx, ids[2]!)).resolves.toMatchObject({ status: 'done' });
    await expect(service.get(ctx, ids[6]!)).resolves.toMatchObject({ status: 'done' });
    now += 61 * 60_000;
    expect((await refusal(service.get(ctx, ids[6]!))).code).toBe('not_found');
  });
});

describe('screenshotArgs', () => {
  it('builds the arguments from the validated fields only', () => {
    expect(screenshotArgs({})).toEqual([]);
    expect(screenshotArgs({ widths: [200, 4000], seed: 'none', scale: 1 })).toEqual([
      '--widths',
      '200,4000',
      '--scale',
      '1',
      '--seed',
      'none',
    ]);
    const all = screenshotArgs({
      widths: [390],
      fullPage: true,
      scale: 2,
      timeoutSeconds: 600,
      seed: 'demo',
    }).filter((arg) => arg.startsWith('--'));
    expect(all).toEqual(['--widths', '--full-page', '--scale', '--timeout', '--seed']);
    for (const forbidden of ['--out', '--keep-data', '--machine']) expect(all).not.toContain(forbidden);
  });
});

describe('scenarioPath', () => {
  const scopeOf = (): ScreenshotScope => scope!;

  it('resolves a relative path against the worktree and returns the real path', async () => {
    expect(await scenarioPath(scopeOf(), 'shots/login.mjs')).toBe(path.join(cwd, 'shots', 'login.mjs'));
  });

  it('refuses a link that leads out of the worktree and the session folder', async () => {
    writeFileSync(path.join(base, 'secret.mjs'), '');
    symlinkSync(path.join(base, 'secret.mjs'), path.join(cwd, 'shots', 'link.mjs'));
    const err = await refusal(scenarioPath(scopeOf(), 'shots/link.mjs'));
    expect(err.code).toBe('invalid');
    expect(err.message).toContain('outside');
  });

  it('follows a link that stays inside', async () => {
    symlinkSync(path.join(cwd, 'shots', 'login.mjs'), path.join(cwd, 'shots', 'same.mjs'));
    expect(await scenarioPath(scopeOf(), 'shots/same.mjs')).toBe(path.join(cwd, 'shots', 'login.mjs'));
  });

  it('refuses a sibling directory whose name starts like the worktree', async () => {
    mkdirSync(`${cwd}-evil`);
    writeFileSync(path.join(`${cwd}-evil`, 'x.mjs'), '');
    expect((await refusal(scenarioPath(scopeOf(), `${cwd}-evil/x.mjs`))).code).toBe('invalid');
  });
});

describe('listImages', () => {
  it('lists png, jpg and jpeg files, deep, newest-or-equal to the floor, sorted, at most 100, skipping links', async () => {
    const dir = path.join(sessionDir, 'shots');
    mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    const floor = Date.now() - 1_000;
    const wanted = [
      path.join(dir, 'a', 'b', 'z.JPG'),
      path.join(dir, 'a', 'one.png'),
      path.join(dir, 'two.jpeg'),
    ];
    for (const file of wanted) writeFileSync(file, 'x');
    writeFileSync(path.join(dir, 'a', 'readme.md'), 'x');
    writeFileSync(path.join(dir, 'stale.png'), 'x');
    utimesSync(path.join(dir, 'stale.png'), (floor - 10_000) / 1000, (floor - 10_000) / 1000);
    writeFileSync(path.join(base, 'target.png'), 'x');
    symlinkSync(path.join(base, 'target.png'), path.join(dir, 'link.png'));
    expect(await listImages(dir, floor)).toEqual([...wanted].sort());

    for (let i = 0; i < 120; i++)
      writeFileSync(path.join(dir, `many-${String(i).padStart(3, '0')}.png`), 'x');
    expect(await listImages(dir, floor)).toHaveLength(100);
  });

  it('gives an empty list for a folder that is not there', async () => {
    expect(await listImages(path.join(base, 'nothing'), 0)).toEqual([]);
  });
});
