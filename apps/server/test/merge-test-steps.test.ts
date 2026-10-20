import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  filesSteps,
  MERGE_TEST_WORKSPACES,
  runSteps,
  testStep,
  typecheckStep,
  workspaceOf,
} from '../../../scripts/merge-test/steps';
import type { MergeTestStep, StepRun } from '../../../scripts/merge-test/steps';

const ok = (output = ''): StepRun => ({ code: 0, signaled: false, output });
const bad = (output: string, code = 1): StepRun => ({ code, signaled: false, output });
const failLines = (...files: string[]) => files.map((file) => ` FAIL  ${file} > suite > test`).join('\n');

function setup(runs: StepRun[], changed: ReadonlySet<string> | null = new Set()) {
  const queue = [...runs];
  const spawn = vi.fn(async (_args: string[]): Promise<StepRun> => queue.shift() ?? ok());
  const lines: string[] = [];
  const run = (steps: MergeTestStep[]) =>
    runSteps(steps, { spawn, changed, log: (line) => lines.push(line) });
  return { spawn, lines, run, calls: () => spawn.mock.calls.map(([args]) => args) };
}

const server = testStep('apps/server');
const markers = (lines: string[]) =>
  lines.filter((line) => line.startsWith('merge-test failed') || line.startsWith('merge-test flaky'));

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
  it('runs green steps without markers', async () => {
    const t = setup([]);
    expect(await t.run([typecheckStep('apps/server'), server])).toBe(0);
    expect(t.calls()).toEqual([
      ['run', 'typecheck', '-w', 'apps/server'],
      ['test', '-w', 'apps/server'],
    ]);
    expect(t.lines).toEqual([]);
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
      .mockResolvedValueOnce(bad(failLines('test/a.test.ts')))
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error('spawn npm ENOENT'));
    await expect(
      runSteps([server, testStep('apps/web')], {
        spawn,
        changed: new Set(),
        log: (line) => lines.push(line),
      }),
    ).rejects.toThrow('ENOENT');
    expect(markers(lines)).toEqual(['merge-test flaky: apps/server/test/a.test.ts']);
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
