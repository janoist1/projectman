import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FullTestExecutor, FullTestResult, FullTestSpec } from '../src/contracts';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/*
 * PM-217: a task entering review gets the server's full test of its pinned commit first. The executor
 * is fake here (the sandboxed one has its own tests); the harness's fake worktree manager tells the
 * checkout's head.
 */

const TASK = { type: 'task', taskKey: 'AR-1' } as const;

const passed: FullTestResult = {
  outcome: 'passed',
  exitCode: 0,
  durationMs: 1200,
  failedFiles: [],
  outputTail: '',
};
const failed: FullTestResult = {
  outcome: 'failed',
  exitCode: 1,
  durationMs: 3400,
  failedFiles: ['apps/server/test/a.integration.test.ts'],
  outputTail: '⎯⎯ Failed Tests 1 ⎯⎯\n FAIL a.integration.test.ts > it works',
};

/** An executor whose runs end when the test says so. */
class FakeExecutor implements FullTestExecutor {
  available_: { ok: true } | { ok: false; reason: string } = { ok: true };
  readonly specs: FullTestSpec[] = [];
  readonly signals: AbortSignal[] = [];
  private readonly open: ((result: FullTestResult) => void)[] = [];

  available() {
    return Promise.resolve(this.available_);
  }

  run(spec: FullTestSpec, signal: AbortSignal): Promise<FullTestResult> {
    this.specs.push(spec);
    this.signals.push(signal);
    return new Promise((resolve) => {
      this.open.push(resolve);
      signal.addEventListener('abort', () => {
        this.open.splice(this.open.indexOf(resolve), 1);
        resolve({
          outcome: 'error',
          reason: 'killed',
          exitCode: null,
          durationMs: 1,
          failedFiles: [],
          outputTail: '',
        });
      });
    });
  }

  /** The oldest run that is still going ends with `result`. */
  finish(result: FullTestResult): void {
    this.open.shift()!(result);
  }
}

const REVIEW_TEST = { command: 'npm run typecheck && npm test', maxWorkers: 2, timeoutMinutes: 15 };

describe('the full test before review', () => {
  let h: DomainHarness;
  let executor: FakeExecutor;
  const head = (commit: string, dirty = false) => ({
    commit,
    branch: 'task/AR-1',
    dirty,
    changes: dirty ? 3 : 0,
    path: '/fake/worktree',
    committedAt: null,
  });
  const task = () => h.domain.tasks.get('AR', 'AR-1');
  const runs = () => h.repos.fullTestRuns.forTask('AR-1');
  const events = () =>
    h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.type === 'task_full_test');
  const reviewerStarted = () => h.runner.started.some((s) => s.member === 'cr');
  const heldFor = (handle: string) => h.domain.messages.waiting('AR', handle, TASK).map((m) => m.body);

  async function setup(opts: { reviewTest?: boolean; executor?: FakeExecutor } = {}) {
    executor = opts.executor ?? new FakeExecutor();
    h = await createDomainHarness({
      fullTestExecutor: executor,
      adjust: (config) => {
        if (opts.reviewTest !== false) config.project.repos[0]!.reviewTest = REVIEW_TEST;
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    const worktree = h.worktrees.existing.get('AR/AR-1/web')!.path;
    h.worktrees.heads.set(worktree, head('c1'));
    return worktree;
  }

  async function handOver() {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
  }

  afterEach(async () => {
    await h.cleanup();
  });

  it('queues a run for the pin, holds the reviewer, and starts it when the run passes', async () => {
    await setup();
    await handOver();
    await vi.waitFor(() => expect(executor.specs).toHaveLength(1));
    expect(executor.specs[0]).toMatchObject({
      command: REVIEW_TEST.command,
      maxWorkers: 2,
      timeoutMs: 15 * 60_000,
      cwd: '/fake/worktree',
    });
    expect(runs()).toMatchObject([{ status: 'running', commit: 'c1', branch: 'task/AR-1' }]);
    expect(task().reviewPin).toMatchObject({ commit: 'c1', fullTest: { status: 'running' } });
    await h.domain.reviewWatch.check();
    expect(reviewerStarted()).toBe(false);

    executor.finish(passed);
    await vi.waitFor(() => expect(reviewerStarted()).toBe(true));
    expect(runs()).toMatchObject([{ status: 'passed', exitCode: 0 }]);
    expect(task()).toMatchObject({ stageId: 'code_review', reviewPin: { fullTest: { status: 'passed' } } });
    expect(events().map((e) => e.data)).toMatchObject([
      { outcome: 'passed', commit: 'c1', runId: runs()[0]!.id },
    ]);
  });

  it('keeps the developer messages to the reviewer until the run passes', async () => {
    await setup();
    await handOver();
    await vi.waitFor(() => expect(executor.specs).toHaveLength(1));
    await h.domain.messaging.send('AR', 'dev-1', { to: ['cr'], taskKey: 'AR-1', text: 'Ready for review' });
    expect(heldFor('cr')).toEqual(['Ready for review']);
    expect(reviewerStarted()).toBe(false);

    executor.finish(passed);
    await vi.waitFor(() => expect(heldFor('cr')).toEqual([]));
    await vi.waitFor(() => expect(reviewerStarted()).toBe(true));
  });

  it('sends the task back to the work stage when the run fails, as a fix round', async () => {
    await setup();
    await handOver();
    await vi.waitFor(() => expect(executor.specs).toHaveLength(1));
    await h.domain.messaging.send('AR', 'dev-1', { to: ['cr'], taskKey: 'AR-1', text: 'Ready for review' });
    const before = h.runner.messages.length;

    executor.finish(failed);
    await vi.waitFor(() => expect(task().stageId).toBe('development'));
    expect(runs()).toMatchObject([{ status: 'failed', failedFiles: failed.failedFiles }]);
    const move = h.domain.timeline
      .list('AR', { taskKey: 'AR-1' })
      .filter((e) => e.type === 'task_stage_changed')
      .at(-1);
    expect(move?.data).toMatchObject({
      testsFailed: { runId: runs()[0]!.id, branch: 'task/AR-1', commit: 'c1' },
    });
    expect(reviewerStarted()).toBe(false);
    expect(events().map((e) => e.data)).toMatchObject([
      { outcome: 'failed', failedFiles: failed.failedFiles, outputTail: failed.outputTail },
    ]);

    // The developer is told, with the failure.
    await vi.waitFor(() => {
      const texts = [
        ...h.runner.started.filter((s) => s.member === 'dev-1').map((s) => s.initialMessage ?? ''),
        ...h.runner.messages.slice(before).map((m) => m.text),
      ];
      expect(texts.some((text) => text.includes('a.integration.test.ts') && text.includes('came back'))).toBe(
        true,
      );
    });
    const config = await h.domain.projects.config('AR');
    expect(h.domain.fixLimit.fixRounds(task(), config).rounds).toBe(1);
  });

  it('runs again for a new round of the same task, and the result is for the new commit only', async () => {
    const worktree = await setup();
    await handOver();
    await vi.waitFor(() => expect(executor.specs).toHaveLength(1));

    // The developer asks for a re-review on a new commit while the first run goes: it is dropped.
    h.worktrees.heads.set(worktree, head('c2'));
    await h.domain.messaging.send('AR', 'dev-1', { to: ['cr'], taskKey: 'AR-1', text: 'Fixed' });
    await vi.waitFor(() => expect(executor.signals[0]!.aborted).toBe(true));
    await vi.waitFor(() => expect(executor.specs).toHaveLength(2));
    expect(runs().map((r) => [r.commit, r.status])).toEqual(
      expect.arrayContaining([
        ['c1', 'cancelled'],
        ['c2', 'running'],
      ]),
    );
    expect(runs().find((r) => r.commit === 'c1')?.reason).toBe('repinned');
    expect(task().stageId).toBe('code_review');

    executor.finish(passed);
    await vi.waitFor(() => expect(reviewerStarted()).toBe(true));
    expect(task().reviewPin).toMatchObject({ commit: 'c2', fullTest: { status: 'passed' } });
  });

  it('lets the reviewer start with the fact that the run could not run, and sends nothing back', async () => {
    await setup();
    await handOver();
    await vi.waitFor(() => expect(executor.specs).toHaveLength(1));
    executor.finish({
      outcome: 'error',
      reason: 'timeout',
      exitCode: null,
      durationMs: 900_000,
      failedFiles: [],
      outputTail: 'still running',
    });
    await vi.waitFor(() => expect(reviewerStarted()).toBe(true));
    expect(task()).toMatchObject({
      stageId: 'code_review',
      reviewPin: { fullTest: { status: 'error', reason: 'timeout' } },
    });
    expect(events().map((e) => e.data)).toMatchObject([{ outcome: 'error', reason: 'timeout' }]);
  });

  it('turns an executor that throws into an error result', async () => {
    await setup();
    executor.run = () => Promise.reject(new Error('srt is gone'));
    await handOver();
    await vi.waitFor(() => expect(reviewerStarted()).toBe(true));
    expect(task().reviewPin).toMatchObject({ fullTest: { status: 'error', reason: 'spawn_failed' } });
    expect(h.log.errors).toEqual([]);
  });

  it('ends a run that threw before it ran as an error with its event, and lets the reviewer start', async () => {
    await setup();
    vi.spyOn(h.repos.fullTestRuns, 'start').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    await handOver();
    await vi.waitFor(() => expect(reviewerStarted()).toBe(true));
    expect(executor.specs).toHaveLength(0);
    expect(runs()).toMatchObject([{ status: 'error', reason: 'spawn_failed' }]);
    expect(events().map((e) => e.data)).toMatchObject([{ outcome: 'error', reason: 'spawn_failed' }]);
  });

  describe('a checkout that changed while the run waited in the queue', () => {
    async function queuedSecond() {
      await setup();
      await h.domain.tasks.create('AR', { title: 'Second' }, OWNER_ACTOR);
      await h.domain.taskStarts.start('AR', 'AR-2', { assignee: 'dev-2', actor: OWNER_ACTOR, author: OWNER });
      const second = h.worktrees.existing.get('AR/AR-2/web')!.path;
      const secondHead = (commit: string, dirty = false) => ({
        ...head(commit, dirty),
        branch: 'task/AR-2',
        path: second,
      });
      h.worktrees.heads.set(second, secondHead('d1'));
      await handOver();
      await h.domain.tasks.moveToStage('AR', 'AR-2', 'code_review', aiActor('dev-2'));
      await vi.waitFor(() => expect(executor.specs).toHaveLength(1));
      return { second, secondHead };
    }

    it('drops the run when the branch moved: nothing runs for the old commit', async () => {
      const { second, secondHead } = await queuedSecond();
      h.worktrees.heads.set(second, secondHead('d2'));
      executor.finish(passed);
      await vi.waitFor(() =>
        expect(h.repos.fullTestRuns.forTask('AR-2')).toMatchObject([
          { status: 'cancelled', reason: 'branch_moved' },
        ]),
      );
      expect(executor.specs).toHaveLength(1);
    });

    it('ends the run as an error when the checkout is dirty: the reviewer is not held for it', async () => {
      const { second, secondHead } = await queuedSecond();
      h.worktrees.heads.set(second, secondHead('d1', true));
      executor.finish(passed);
      await vi.waitFor(() =>
        expect(h.repos.fullTestRuns.forTask('AR-2')).toMatchObject([
          { status: 'error', reason: 'checkout_dirty' },
        ]),
      );
      expect(executor.specs).toHaveLength(1);
      expect(h.domain.tasks.get('AR', 'AR-2').reviewPin?.fullTest).toMatchObject({
        status: 'error',
        reason: 'checkout_dirty',
      });
    });
  });

  it('runs one test at a time, in the order the cards entered review', async () => {
    await setup();
    await h.domain.tasks.create('AR', { title: 'Second' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-2', { assignee: 'dev-2', actor: OWNER_ACTOR, author: OWNER });
    const second = h.worktrees.existing.get('AR/AR-2/web')!.path;
    h.worktrees.heads.set(second, { ...head('d1'), branch: 'task/AR-2', path: second });

    await handOver();
    await h.domain.tasks.moveToStage('AR', 'AR-2', 'code_review', aiActor('dev-2'));
    await vi.waitFor(() => expect(executor.specs).toHaveLength(1));
    expect(h.repos.fullTestRuns.forTask('AR-2')).toMatchObject([{ status: 'queued' }]);
    expect(executor.specs).toHaveLength(1);

    executor.finish(passed);
    await vi.waitFor(() => expect(executor.specs).toHaveLength(2));
    expect(h.repos.fullTestRuns.forTask('AR-2')).toMatchObject([{ status: 'running' }]);
    executor.finish(passed);
    await vi.waitFor(() =>
      expect(h.repos.fullTestRuns.forTask('AR-2')).toMatchObject([{ status: 'passed' }]),
    );
  });

  it('drops a run when the task leaves review', async () => {
    await setup();
    await handOver();
    await vi.waitFor(() => expect(executor.specs).toHaveLength(1));
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await vi.waitFor(() => expect(executor.signals[0]!.aborted).toBe(true));
    await vi.waitFor(() => expect(runs()).toMatchObject([{ status: 'cancelled', reason: 'stage_left' }]));
    expect(reviewerStarted()).toBe(false);
  });

  it('stops the running run with the server, and queues the pin again after a restart', async () => {
    executor = new FakeExecutor();
    h = await createDomainHarness({
      persistent: true,
      fullTestExecutor: executor,
      adjust: (config) => {
        config.project.repos[0]!.reviewTest = REVIEW_TEST;
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    h.worktrees.heads.set(h.worktrees.existing.get('AR/AR-1/web')!.path, head('c1'));
    await handOver();
    await vi.waitFor(() => expect(executor.specs).toHaveLength(1));
    const first = runs()[0]!;

    h = await restartDomainHarness(h, { fullTestExecutor: executor });
    expect(h.repos.fullTestRuns.get(first.id)).toMatchObject({ status: 'cancelled', reason: 'shutdown' });
    // The pin is still there: it has a new run (the fake worktree manager of the new harness has no
    // checkout, so that run ends as an error and the reviewer is released).
    await vi.waitFor(() => expect(runs().filter((r) => r.id !== first.id)).toHaveLength(1));
  });

  it('ends the runs a crashed server left as interrupted', async () => {
    await setup();
    const at = new Date().toISOString();
    h.repos.fullTestRuns.queue({
      id: 'ftr_old',
      projectKey: 'AR',
      taskKey: 'AR-1',
      repo: 'web',
      branch: 'task/AR-1',
      commit: 'c0',
      createdAt: at,
    });
    h.repos.fullTestRuns.start('ftr_old', at);
    await h.domain.fullTests.init();
    expect(h.repos.fullTestRuns.get('ftr_old')).toMatchObject({ status: 'cancelled', reason: 'interrupted' });
  });

  it('changes nothing for a repository without a review test', async () => {
    await setup({ reviewTest: false });
    await handOver();
    await vi.waitFor(() => expect(reviewerStarted()).toBe(true));
    expect(executor.specs).toHaveLength(0);
    expect(runs()).toEqual([]);
    expect(task().reviewPin?.fullTest).toBeUndefined();
  });

  it('is off when the sandbox cannot run here', async () => {
    const off = new FakeExecutor();
    off.available_ = { ok: false, reason: 'no srt' };
    await setup({ executor: off });
    await handOver();
    await vi.waitFor(() => expect(reviewerStarted()).toBe(true));
    expect(off.specs).toHaveLength(0);
    expect(runs()).toEqual([]);
  });
});
