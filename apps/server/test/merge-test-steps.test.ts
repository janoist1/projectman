import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeTestPassedSteps } from '@projectman/shared';
import {
  filesSteps,
  MERGE_TEST_WORKSPACES,
  mergeTestStepKey,
  runSteps,
  shardSteps,
  testStep,
  typecheckStep,
  workspaceOf,
} from '../../../scripts/merge-test/steps';
import type { MergeTestStep, StepRun } from '../../../scripts/merge-test/steps';

const ok = (output = ''): StepRun => ({ code: 0, signaled: false, output });
const bad = (output: string, code = 1): StepRun => ({ code, signaled: false, output });
const failLines = (...files: string[]) => files.map((file) => ` FAIL  ${file} > suite > test`).join('\n');

function setup(runs: StepRun[], changed: ReadonlySet<string> | null = new Set(), now?: () => number) {
  const queue = [...runs];
  const spawn = vi.fn(async (_args: string[]): Promise<StepRun> => queue.shift() ?? ok());
  const lines: string[] = [];
  const run = (steps: MergeTestStep[]) =>
    runSteps(steps, { spawn, changed, tree: 'candidate-tree', now, log: (line) => lines.push(line) });
  return { spawn, lines, run, calls: () => spawn.mock.calls.map(([args]) => args) };
}

/** A clock that reads the given instants in order. */
const clockOf = (instants: number[]) => {
  const queue = [...instants];
  return () => queue.shift() ?? 0;
};

const server = testStep('apps/server');
const markers = (lines: string[]) =>
  lines.filter((line) => line.startsWith('merge-test failed') || line.startsWith('merge-test flaky'));
const TIMING = 'merge-test timing: ';
const withoutTimings = (lines: string[]) => lines.filter((line) => !line.startsWith(TIMING));
/** The step timings the run printed, each once (the run prints them again at its end). */
const timings = (lines: string[]) => {
  const all = lines
    .filter((line) => line.startsWith(TIMING))
    .map((line) => JSON.parse(line.slice(TIMING.length)));
  return all.slice(0, all.length / 2);
};

describe('the full run steps', () => {
  it('splits the workspaces: every type check, then every test', () => {
    const steps = [
      ...MERGE_TEST_WORKSPACES.map((ws) => typecheckStep(ws, true)),
      ...MERGE_TEST_WORKSPACES.map((ws) => testStep(ws, undefined, true)),
    ];
    expect(steps.map((step) => step.args)).toEqual([
      ...MERGE_TEST_WORKSPACES.map((ws) => ['run', 'typecheck', '-w', ws, '--if-present']),
      ...MERGE_TEST_WORKSPACES.map((ws) => ['test', '-w', ws, '--if-present']),
    ]);
    expect(MERGE_TEST_WORKSPACES).toEqual([
      'packages/shared',
      'packages/templates',
      'apps/feedback-widget',
      'apps/server',
      'apps/web',
    ]);
  });
});

describe('runSteps', () => {
  it('marks green steps immediately and repeats their keys at the end', async () => {
    const t = setup([]);
    expect(await t.run([typecheckStep('apps/server'), server])).toBe(0);
    expect(t.calls()).toEqual([
      ['run', 'typecheck', '-w', 'apps/server'],
      ['test', '-w', 'apps/server'],
    ]);
    const keys = [typecheckStep('apps/server'), server].map(
      (step) => `merge-test step passed: ${mergeTestStepKey('candidate-tree', step.args)}`,
    );
    expect(withoutTimings(t.lines)).toEqual([...keys, ...keys]);
  });

  it('times each step: passed, cached (not a zero), failed, and a rerun with its own time', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'merge-test-timing-'));
    try {
      const cachedStep = typecheckStep('apps/web');
      const cachedKey = mergeTestStepKey('candidate-tree', cachedStep.args);
      const passedKeysFile = resolve(dir, 'passed.txt');
      writeFileSync(passedKeysFile, `${cachedKey}\n`);
      const lines: string[] = [];
      const queue = [ok(), bad(failLines('test/a.test.ts')), ok()];
      const spawn = vi.fn(async (): Promise<StepRun> => queue.shift() ?? ok());
      const code = await runSteps([typecheckStep('apps/server'), cachedStep, server], {
        spawn,
        changed: new Set(),
        tree: 'candidate-tree',
        passedKeysFile,
        now: clockOf([0, 41_200, 41_200, 300_000, 300_000, 312_000]),
        log: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(timings(lines)).toEqual([
        { index: 0, kind: 'typecheck', workspace: 'apps/server', result: 'passed', durationMs: 41_200 },
        { index: 1, kind: 'typecheck', workspace: 'apps/web', result: 'cached', durationMs: null },
        {
          index: 2,
          kind: 'test',
          workspace: 'apps/server',
          result: 'rerun_passed',
          durationMs: 258_800,
          rerunMs: 12_000,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times a failed step and the steps before it, and a failed rerun', async () => {
    const stops = setup([ok(), bad('boom')], new Set(), clockOf([0, 1000, 1000, 2500]));
    expect(await stops.run([typecheckStep('apps/server'), typecheckStep('apps/web')])).toBe(1);
    expect(timings(stops.lines).map((step) => [step.result, step.durationMs])).toEqual([
      ['passed', 1000],
      ['failed', 1500],
    ]);
    const rerun = setup(
      [bad(failLines('test/a.test.ts')), bad(failLines('test/a.test.ts'))],
      new Set(),
      clockOf([0, 5000, 5000, 7000]),
    );
    expect(await rerun.run([server])).toBe(1);
    expect(timings(rerun.lines)).toEqual([
      expect.objectContaining({ result: 'rerun_failed', durationMs: 5000, rerunMs: 2000 }),
    ]);
  });

  it('reruns the failed files once; a green rerun makes the step green and the files flaky', async () => {
    const t = setup([bad(failLines('test/a.test.ts', 'test/b.test.ts')), ok(), ok()]);
    expect(await t.run([server, testStep('apps/web')])).toBe(0);
    expect(t.calls()).toEqual([
      ['test', '-w', 'apps/server'],
      [
        'test',
        '-w',
        'apps/server',
        '--',
        resolve('apps/server/test/a.test.ts'),
        resolve('apps/server/test/b.test.ts'),
      ],
      ['test', '-w', 'apps/web'],
    ]);
    expect(markers(t.lines)).toEqual([
      'merge-test flaky: apps/server/test/a.test.ts',
      'merge-test flaky: apps/server/test/b.test.ts',
    ]);
  });

  it('puts the marker lines last', async () => {
    const t = setup([bad(failLines('test/a.test.ts')), ok()]);
    await t.run([server]);
    expect(t.lines.at(-1)).toBe('merge-test flaky: apps/server/test/a.test.ts');
  });

  it('reads vitest project names and unifies repeated files', async () => {
    const t = setup([bad(` FAIL  |server| test/a.test.ts > x\n FAIL  test/a.test.ts > y\n`), ok()]);
    expect(await t.run([server])).toBe(0);
    expect(markers(t.lines)).toEqual(['merge-test flaky: apps/server/test/a.test.ts']);
  });

  it('reruns the failed files of both server test projects with one absolute filter each (PM-865)', async () => {
    const t = setup([
      bad(
        ' FAIL  |pooled| test/a.test.ts > suite > x\n FAIL  |isolated| src/b/b.test.ts > y\n FAIL  |pooled| test/a.test.ts > z\n',
      ),
      ok(),
    ]);
    expect(await t.run([server])).toBe(0);
    expect(t.calls()[1]).toEqual([
      'test',
      '-w',
      'apps/server',
      '--',
      resolve('apps/server/test/a.test.ts'),
      resolve('apps/server/src/b/b.test.ts'),
    ]);
    expect(markers(t.lines)).toEqual([
      'merge-test flaky: apps/server/test/a.test.ts',
      'merge-test flaky: apps/server/src/b/b.test.ts',
    ]);
  });

  it('writes failed lines and returns the rerun code when the rerun fails', async () => {
    const t = setup([
      bad(failLines('test/a.test.ts', 'test/b.test.ts')),
      bad(failLines('test/b.test.ts'), 3),
      ok(),
    ]);
    expect(await t.run([server, testStep('apps/web')])).toBe(3);
    expect(t.calls()).toHaveLength(2);
    expect(markers(t.lines)).toEqual(['merge-test failed: apps/server/test/b.test.ts']);
  });

  it('names the first failed files when the rerun says none', async () => {
    const t = setup([bad(failLines('test/a.test.ts')), bad('crash')]);
    expect(await t.run([server])).toBe(1);
    expect(markers(t.lines)).toEqual(['merge-test failed: apps/server/test/a.test.ts']);
  });

  it('keeps the flaky files of an earlier step when a later step fails', async () => {
    const t = setup([
      bad(failLines('test/a.test.ts')),
      ok(),
      bad(failLines('src/b.test.ts')),
      bad(failLines('src/b.test.ts')),
    ]);
    expect(await t.run([server, testStep('apps/web')])).toBe(1);
    expect(markers(t.lines)).toEqual([
      'merge-test failed: apps/web/src/b.test.ts',
      'merge-test flaky: apps/server/test/a.test.ts',
    ]);
  });

  it.each([
    ['more than five files', failLines(...Array.from({ length: 6 }, (_, i) => `test/${i}.test.ts`))],
    ['an unhandled error', `${failLines('test/a.test.ts')}\n⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯\n`],
    ['a path outside the workspace', failLines('../other/a.test.ts')],
    ['an absolute path', failLines('/tmp/a.test.ts')],
  ])('does not rerun %s', async (_name, output) => {
    const t = setup([bad(output)]);
    expect(await t.run([server])).toBe(1);
    expect(t.calls()).toEqual([['test', '-w', 'apps/server']]);
  });

  it('marks the first run failed files when there is no rerun', async () => {
    const six = Array.from({ length: 6 }, (_, i) => `test/${i}.test.ts`);
    const t = setup([bad(failLines(...six))]);
    await t.run([server]);
    expect(markers(t.lines)).toEqual(six.map((file) => `merge-test failed: apps/server/${file}`));
  });

  it('does not rerun a run a signal stopped, and marks nothing', async () => {
    const t = setup([{ code: 143, signaled: true, output: failLines('test/a.test.ts') }]);
    expect(await t.run([server])).toBe(143);
    expect(t.calls()).toHaveLength(1);
    expect(markers(t.lines)).toEqual([]);
  });

  it('does not rerun a file the merge changed, however few failed', async () => {
    const t = setup(
      [bad(failLines('test/a.test.ts', 'test/b.test.ts'))],
      new Set(['apps/server/test/b.test.ts']),
    );
    expect(await t.run([server])).toBe(1);
    expect(t.calls()).toHaveLength(1);
    expect(markers(t.lines)).toEqual([
      'merge-test failed: apps/server/test/a.test.ts',
      'merge-test failed: apps/server/test/b.test.ts',
    ]);
  });

  it('does not rerun when it is unknown what the merge changed', async () => {
    const t = setup([bad(failLines('test/a.test.ts'))], null);
    expect(await t.run([server])).toBe(1);
    expect(t.calls()).toHaveLength(1);
  });

  it('does not rerun a type check, nor a failure with no file', async () => {
    const check = setup([bad(failLines('test/a.test.ts'))]);
    expect(await check.run([typecheckStep('apps/server')])).toBe(1);
    expect(check.calls()).toHaveLength(1);
    expect(markers(check.lines)).toEqual([]);
    const none = setup([bad('Error: something')]);
    expect(await none.run([server])).toBe(1);
    expect(none.calls()).toHaveLength(1);
    expect(markers(none.lines)).toEqual([]);
  });

  it('stops at the first failed step', async () => {
    const t = setup([bad('error TS1', 2)]);
    expect(await t.run([typecheckStep('apps/server'), server])).toBe(2);
    expect(t.calls()).toHaveLength(1);
  });

  it('writes the markers when npm cannot start', async () => {
    const lines: string[] = [];
    const spawn = vi
      .fn<(args: string[]) => Promise<StepRun>>()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(bad(failLines('test/a.test.ts')))
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error('spawn npm ENOENT'));
    await expect(
      runSteps([typecheckStep('apps/server'), server, testStep('apps/web')], {
        spawn,
        changed: new Set(),
        tree: 'candidate-tree',
        log: (line) => lines.push(line),
      }),
    ).rejects.toThrow('ENOENT');
    expect(markers(lines)).toEqual(['merge-test flaky: apps/server/test/a.test.ts']);
    expect(mergeTestPassedSteps(lines.join('\n'))).toEqual([
      mergeTestStepKey('candidate-tree', typecheckStep('apps/server').args),
    ]);
  });
});

describe('step cache keys', () => {
  const runtime = { node: 'v22.12.0', platform: 'darwin' as const, arch: 'arm64' as const, maxWorkers: '4' };
  const args = ['test', '-w', 'apps/server', '--', 'apps/server/test/a.test.ts'];

  it('hashes the versioned tree, normalized args and runtime in the specified order', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify({ v: 1, tree: 'tree', args, ...runtime }))
      .digest('hex');
    expect(
      mergeTestStepKey(
        'tree',
        ['test', '-w', 'apps/server', '--', '/one/apps/server/test/a.test.ts'],
        '/one',
        runtime,
      ),
    ).toBe(expected);
    expect(
      mergeTestStepKey(
        'tree',
        ['test', '-w', 'apps/server', '--', '/two/apps/server/test/a.test.ts'],
        '/two',
        runtime,
      ),
    ).toBe(expected);
  });

  it('separates every tree, argument and runtime change', () => {
    const key = mergeTestStepKey('tree', args, '/repo', runtime);
    expect(mergeTestStepKey('other-tree', args, '/repo', runtime)).not.toBe(key);
    expect(mergeTestStepKey('tree', [...args, '--if-present'], '/repo', runtime)).not.toBe(key);
    for (const change of [
      { node: 'v24.0.0' },
      { platform: 'linux' as const },
      { arch: 'x64' as const },
      { maxWorkers: '2' },
    ]) {
      expect(mergeTestStepKey('tree', args, '/repo', { ...runtime, ...change })).not.toBe(key);
    }
  });
});

describe('passed step reuse', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function cachedRun(options: { noCache?: boolean; tree?: string; unreadable?: boolean } = {}) {
    root = mkdtempSync(resolve(tmpdir(), 'pm-step-'));
    const key = mergeTestStepKey('tree', server.args);
    const passedKeysFile = resolve(root, 'passed');
    if (!options.unreadable) writeFileSync(passedKeysFile, `${key}\ninvalid\n`);
    const spawn = vi.fn(async () => ok());
    const lines: string[] = [];
    const code = await runSteps([server], {
      tree: options.tree ?? 'tree',
      passedKeysFile,
      noCache: options.noCache,
      changed: new Set(),
      spawn,
      log: (line) => lines.push(line),
    });
    return { spawn, lines, key, code };
  }

  it('skips a matching step and reports the cached command and passed key', async () => {
    const result = await cachedRun();
    expect(result.code).toBe(0);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.lines).toContain('merge-test cached: npm test -w apps/server');
    expect(mergeTestPassedSteps(result.lines.join('\n'))).toEqual([result.key]);
  });

  it.each([{ noCache: true }, { tree: 'other' }, { unreadable: true }])(
    'runs instead of reusing with %j',
    async (options) => {
      const result = await cachedRun(options);
      expect(result.code).toBe(0);
      expect(result.spawn).toHaveBeenCalledOnce();
      expect(result.lines.some((line) => line.startsWith('merge-test cached:'))).toBe(false);
      expect(mergeTestPassedSteps(result.lines.join('\n'))).toHaveLength(1);
    },
  );

  it.each([bad('crash'), { code: 143, signaled: true, output: '' }])(
    'retains earlier passed keys without marking a failed or signaled step (%j)',
    async (end) => {
      const t = setup([ok(), end]);
      expect(await t.run([typecheckStep('apps/server'), server])).toBe(end.code);
      expect(mergeTestPassedSteps(t.lines.join('\n'))).toEqual([
        mergeTestStepKey('candidate-tree', typecheckStep('apps/server').args),
      ]);
    },
  );

  it('never marks a step whose failed-file rerun also fails', async () => {
    const t = setup([bad(failLines('test/a.test.ts')), bad(failLines('test/a.test.ts'))]);
    expect(await t.run([server])).toBe(1);
    expect(mergeTestPassedSteps(t.lines.join('\n'))).toEqual([]);
  });

  it('reports a green failed-file rerun as flaky without caching the original step', async () => {
    const t = setup([bad(failLines('test/a.test.ts')), ok()]);
    expect(await t.run([server])).toBe(0);
    expect(mergeTestPassedSteps(t.lines.join('\n'))).toEqual([]);
    expect(markers(t.lines)).toEqual(['merge-test flaky: apps/server/test/a.test.ts']);
  });

  it.each([false, true])(
    'retries flaky steps on the same tree and respects a changed rerun condition (%s)',
    async (changed) => {
      root = mkdtempSync(resolve(tmpdir(), 'pm-flaky-cache-'));
      const passedKeysFile = resolve(root, 'passed');
      const check = typecheckStep('apps/server');
      const steps = [check, server];
      const first = setup([ok(), bad(failLines('test/a.test.ts')), ok()]);
      expect(await first.run(steps)).toBe(0);
      const keys = mergeTestPassedSteps(first.lines.join('\n'));
      expect(keys).toEqual([mergeTestStepKey('candidate-tree', check.args)]);
      writeFileSync(passedKeysFile, keys.join('\n'));

      const lines: string[] = [];
      const spawn = vi
        .fn<(args: string[]) => Promise<StepRun>>()
        .mockResolvedValueOnce(bad(failLines('test/a.test.ts')))
        .mockResolvedValue(ok());
      expect(
        await runSteps(steps, {
          tree: 'candidate-tree',
          changed: new Set(changed ? ['apps/server/test/a.test.ts'] : []),
          passedKeysFile,
          spawn,
          log: (line) => lines.push(line),
        }),
      ).toBe(changed ? 1 : 0);
      expect(spawn).toHaveBeenCalledTimes(changed ? 1 : 2);
      expect(spawn.mock.calls[0]?.[0]).toEqual(server.args);
      expect(lines).toContain('merge-test cached: npm run typecheck -w apps/server');
      expect(mergeTestPassedSteps(lines.join('\n'))).toEqual(keys);
      expect(markers(lines)).toEqual([
        `merge-test ${changed ? 'failed' : 'flaky'}: apps/server/test/a.test.ts`,
      ]);
    },
  );
});

describe('shardSteps', () => {
  const full = [
    ...MERGE_TEST_WORKSPACES.map((ws) => typecheckStep(ws, true)),
    ...MERGE_TEST_WORKSPACES.map((ws) => testStep(ws, undefined, true)),
  ];
  it('deals the type checks round-robin and keeps every step’s place in the whole list', () => {
    const steps = shardSteps(full, { index: 2, count: 3 });
    expect(
      steps.filter((step) => step.kind === 'typecheck').map((step) => [step.index, step.workspace]),
    ).toEqual([
      [1, 'packages/templates'],
      [4, 'apps/web'],
    ]);
    expect(steps.filter((step) => step.kind === 'test').map((step) => step.index)).toEqual([5, 6, 7, 8, 9]);
  });

  it('gives every type check to exactly one shard', () => {
    const owners = [1, 2, 3, 4].flatMap((index) =>
      shardSteps(full, { index, count: 4 })
        .filter((step) => step.kind === 'typecheck')
        .map((step) => step.index),
    );
    expect(owners.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('adds the vitest shard to every test step, with a separator only when it has none', () => {
    const steps = shardSteps(
      [testStep('apps/web', undefined, true), testStep('apps/server', ['apps/server/test/a.test.ts'])],
      { index: 3, count: 4 },
    );
    expect(steps.map((step) => step.args)).toEqual([
      ['test', '-w', 'apps/web', '--if-present', '--', '--shard=3/4', '--passWithNoTests'],
      [
        'test',
        '-w',
        'apps/server',
        '--',
        resolve('apps/server/test/a.test.ts'),
        '--shard=3/4',
        '--passWithNoTests',
      ],
    ]);
  });

  it('times a shard’s step with its original index', async () => {
    const t = setup([]);
    expect(await t.run(shardSteps(full, { index: 2, count: 4 }).slice(0, 2))).toBe(0);
    expect(timings(t.lines).map((step) => [step.index, step.kind])).toEqual([
      [1, 'typecheck'],
      [5, 'test'],
    ]);
  });
});

describe('filesSteps', () => {
  const all = () => true;
  it('groups the files by workspace in the run order and has no type check', () => {
    const { steps, absent } = filesSteps(
      [
        'apps/web/src/a.test.tsx',
        'apps/server/test/b.test.ts',
        'packages/shared/src/c.test.ts',
        'apps/server/test/d.test.ts',
      ],
      all,
    );
    expect(steps.map((step) => step.args)).toEqual([
      ['test', '-w', 'packages/shared', '--', resolve('packages/shared/src/c.test.ts')],
      [
        'test',
        '-w',
        'apps/server',
        '--',
        resolve('apps/server/test/b.test.ts'),
        resolve('apps/server/test/d.test.ts'),
      ],
      ['test', '-w', 'apps/web', '--', resolve('apps/web/src/a.test.tsx')],
    ]);
    expect(steps.every((step) => step.kind === 'test')).toBe(true);
    expect(absent).toEqual([]);
  });

  it('leaves out the files that are absent', () => {
    const { steps, absent } = filesSteps(
      ['apps/server/test/new.test.ts', 'apps/server/test/old.test.ts'],
      (file) => file.endsWith('old.test.ts'),
    );
    expect(absent).toEqual(['apps/server/test/new.test.ts']);
    expect(steps.map((step) => step.args)).toEqual([
      ['test', '-w', 'apps/server', '--', resolve('apps/server/test/old.test.ts')],
    ]);
  });

  it('has no step when every file is absent', () => {
    expect(filesSteps(['apps/server/test/new.test.ts'], () => false)).toEqual({
      steps: [],
      absent: ['apps/server/test/new.test.ts'],
    });
  });

  it('tells the workspace of a path', () => {
    expect(workspaceOf('apps/server/test/a.test.ts')).toBe('apps/server');
    expect(workspaceOf('apps/serverless/a.test.ts')).toBeUndefined();
    expect(workspaceOf('scripts/a.test.ts')).toBeUndefined();
  });
});
