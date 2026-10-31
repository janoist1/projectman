import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberConfig } from '@projectman/shared';
import type { Actor, ProjectConfig } from '@projectman/shared';
import { EngineLinkLostError } from '../src/contracts';
import type { BranchMerger, FullTestExecutor, FullTestResult, FullTestSpec } from '../src/contracts';
import { COMPUTE_JOBS_MAX } from '../src/services/compute-jobs';
import { OWNER_ACTOR, createDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

const COMMIT = 'a'.repeat(40);
const DEVOPS: Actor = { kind: 'ai', handle: 'devops' };
const RUN_URL = 'https://github.com/acme/web/actions/runs/9';

/** A repository that has the commit on the remote default branch (or not, or fails). */
function fakeMerger(prepare?: BranchMerger['prepare']) {
  return {
    prepare: vi.fn<BranchMerger['prepare']>(
      prepare ??
        (async () => ({
          local: COMMIT,
          remote: { name: 'origin/main', commit: COMMIT },
          relation: 'same',
          contains: { local: true, remote: true },
          checkout: null,
        })),
    ),
  } as unknown as BranchMerger;
}

/** An executor whose runs end when the test says so. */
function fakeExecutor() {
  const pending: {
    spec: FullTestSpec;
    signal: AbortSignal;
    started(): void;
    finish(result: FullTestResult): void;
    fail(err: Error): void;
  }[] = [];
  const executor: FullTestExecutor = {
    available: async () => ({ ok: true }),
    run: (spec, signal, onStarted) =>
      new Promise((resolve, reject) => {
        pending.push({ spec, signal, started: () => onStarted?.(), finish: resolve, fail: reject });
        signal.addEventListener('abort', () =>
          resolve({
            outcome: 'error',
            reason: 'killed',
            exitCode: null,
            durationMs: 0,
            failedFiles: [],
            outputTail: '',
          }),
        );
      }),
  };
  return { executor, pending };
}

const passed = (runId: string, expiresAt: string): FullTestResult => ({
  outcome: 'passed',
  exitCode: 0,
  durationMs: 61_000,
  failedFiles: [],
  outputTail: 'built',
  externalUrl: RUN_URL,
  outputs: [{ path: 'image.tar', sha256: 'b'.repeat(64), bytes: 10 }],
  artifact: { name: `projectman-job-${runId}`, expiresAt },
  cost: { queuedMs: 4_000, billableMs: 120_000 },
});

describe('compute jobs', () => {
  let h: DomainHarness;
  let jobs: ReturnType<typeof fakeExecutor>;
  let git: BranchMerger;

  async function setup(opts: { merger?: BranchMerger | null } = {}) {
    jobs = fakeExecutor();
    git = opts.merger === undefined ? fakeMerger() : (opts.merger as BranchMerger);
    h = await createDomainHarness({
      merger: opts.merger === null ? null : git,
      fullTestExecutor: jobs.executor,
      adjust(config: ProjectConfig) {
        const repo = config.project.repos[0]!;
        repo.github = 'acme/web';
        repo.computeJobs = [
          {
            id: 'cloud-image',
            command: 'npm run build',
            runsOn: 'ubuntu-24.04-arm',
            outputs: ['image.tar'],
            node: '24',
            timeoutMinutes: 30,
          },
          {
            id: 'cloud-deploy',
            workflow: 'projectman-deploy.yml',
            command: 'npm run deploy',
            runsOn: 'ubuntu-24.04',
            outputs: ['deploy.json'],
            timeoutMinutes: 30,
          },
        ];
        config.team.members.push(
          MemberConfig.parse({
            kind: 'ai',
            handle: 'devops',
            displayName: 'Devops',
            role: 'devops',
            sponsor: 'owner',
          }),
        );
      },
    });
    await h.domain.tasks.create('AR', { title: 'Image' }, OWNER_ACTOR);
  }

  const start = (
    over: { job?: string; commit?: string; force?: boolean; taskKey?: string; by?: Actor } = {},
  ) =>
    h.domain.computeJobs.start(over.by ?? DEVOPS, {
      projectKey: 'AR',
      job: over.job ?? 'cloud-image',
      commit: over.commit ?? COMMIT,
      ...(over.force ? { force: true } : {}),
      ...(over.taskKey ? { taskKey: over.taskKey } : {}),
    });
  const statusOf = (id: string) => h.repos.computeJobRuns.get(id)?.status;
  const running = () => vi.waitFor(() => expect(jobs.pending.length).toBeGreaterThan(0));

  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.cleanup();
  });

  it('runs the job through the engine and records the result and a note on the card', async () => {
    await setup();

    const queued = await start({ taskKey: 'AR-1' });
    expect(queued).toMatchObject({ status: 'queued', runner: 'github_actions', requestedBy: 'devops' });
    await running();
    const [call] = jobs.pending;
    expect(call!.spec).toMatchObject({
      runId: queued.id,
      timeoutMs: 60 * 60_000,
      githubJob: {
        ref: { projectKey: 'AR', repo: 'web' },
        repo: 'acme/web',
        base: 'main',
        job: 'cloud-image',
        commit: COMMIT,
        command: 'npm run build',
        runsOn: 'ubuntu-24.04-arm',
        outputs: ['image.tar'],
        node: '24',
        timeoutMinutes: 30,
      },
    });
    call!.started();
    expect(statusOf(queued.id)).toBe('running');
    call!.finish(passed(queued.id, '2099-01-01T00:00:00.000Z'));
    await vi.waitFor(() => expect(statusOf(queued.id)).toBe('succeeded'));

    expect(h.domain.computeJobs.get('AR', queued.id)).toMatchObject({
      durationMs: 61_000,
      queuedMs: 4_000,
      billableMs: 120_000,
      externalUrl: RUN_URL,
      outputTail: 'built',
      outputs: [{ path: 'image.tar', bytes: 10 }],
      artifact: { name: `projectman-job-${queued.id}` },
    });
    expect(h.domain.timeline.latest('AR', 'AR-1', 'task_note')?.data).toMatchObject({
      text: expect.stringContaining(RUN_URL),
    });
  });

  it('dispatches a registered dedicated workflow, and the general one when none is registered (PM-1196)', async () => {
    await setup();

    await start({ job: 'cloud-deploy' });
    await start();
    await running();

    expect(jobs.pending.map((call) => call.spec.githubJob?.workflow)).toEqual([
      'projectman-deploy.yml',
      'projectman-job.yml',
    ]);
  });

  it.each([
    ['failed', { outcome: 'failed' as const, exitCode: 1 }, { status: 'failed', reason: null }],
    [
      'error',
      { outcome: 'error' as const, exitCode: null, reason: 'github_run_error' as const },
      { status: 'error', reason: 'github_run_error' },
    ],
  ])('records a %s run', async (_name, result, expected) => {
    await setup();

    const queued = await start();
    await running();
    jobs.pending[0]!.finish({ durationMs: 5, failedFiles: [], outputTail: 'boom', ...result });

    await vi.waitFor(() => expect(statusOf(queued.id)).toBe(expected.status));
    expect(h.repos.computeJobRuns.get(queued.id)).toMatchObject({
      reason: expected.reason,
      outputTail: 'boom',
    });
  });

  it('records an engine refusal as an error', async () => {
    await setup();

    const queued = await start();
    await running();
    jobs.pending[0]!.fail(new Error('engine said no'));

    await vi.waitFor(() => expect(statusOf(queued.id)).toBe('error'));
    expect(h.repos.computeJobRuns.get(queued.id)).toMatchObject({
      reason: 'engine_refused',
      outputTail: 'engine said no',
    });
  });

  it('returns the run that goes on for the same commit', async () => {
    await setup();

    const first = await start();
    const again = await start();

    expect(again.id).toBe(first.id);
    await running();
    expect(jobs.pending).toHaveLength(1);
  });

  it('returns a succeeded run while its artifact lives, and starts a new one after it expired', async () => {
    await setup();
    const first = await start();
    await running();
    jobs.pending[0]!.finish(passed(first.id, '2099-01-01T00:00:00.000Z'));
    await vi.waitFor(() => expect(statusOf(first.id)).toBe('succeeded'));

    expect((await start()).id).toBe(first.id);

    h.repos.db.prepare("UPDATE compute_job_runs SET artifact_expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await start()).id).not.toBe(first.id);
  });

  it('starts a new run with force although the commit has a live one', async () => {
    await setup();
    const first = await start();

    const forced = await start({ force: true });

    expect(forced.id).not.toBe(first.id);
  });

  it('refuses a third run while two are going', async () => {
    await setup();
    for (let index = 0; index < COMPUTE_JOBS_MAX; index += 1)
      await start({ commit: String(index).repeat(40) });

    await expect(start({ commit: 'c'.repeat(40) })).rejects.toMatchObject({ code: 'compute_job_busy' });
  });

  it('refuses a job the repository does not define', async () => {
    await setup();

    await expect(start({ job: 'nope' })).rejects.toMatchObject({ code: 'compute_job_unknown' });
  });

  it('refuses a card that is not in the project', async () => {
    await setup();

    await expect(start({ taskKey: 'AR-99' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a member without the deployment duty', async () => {
    await setup();

    await expect(start({ by: { kind: 'ai', handle: 'nobody' } })).rejects.toMatchObject({
      code: 'insufficient_access',
    });
    expect(jobs.pending).toHaveLength(0);
  });

  it.each([
    [
      'the remote branch does not have it',
      async () => ({
        local: COMMIT,
        remote: null,
        relation: 'same' as const,
        contains: { local: true, remote: false },
        checkout: null,
      }),
      'compute_job_commit_unpublished',
    ],
    [
      'the engine does not know it',
      async () => {
        throw new Error('unknown commit');
      },
      'compute_job_commit_unpublished',
    ],
    [
      'the engine link is lost',
      async () => {
        throw new EngineLinkLostError('link lost');
      },
      'engine_offline',
    ],
  ])('refuses a commit when %s', async (_name, prepare, code) => {
    await setup({ merger: fakeMerger(prepare) });

    await expect(start()).rejects.toMatchObject({ code });
    expect(h.repos.computeJobRuns.countActive()).toBe(0);
  });

  it('refuses when the project engine cannot merge', async () => {
    await setup({ merger: null });

    await expect(start()).rejects.toMatchObject({ code: 'engine_offline' });
  });

  it('ends the runs a restart left as cancelled', async () => {
    await setup();
    const queued = await start();

    h.domain.computeJobs.init();

    expect(h.repos.computeJobRuns.get(queued.id)).toMatchObject({
      status: 'cancelled',
      reason: 'interrupted',
    });
  });

  it('stops the running runs as cancelled', async () => {
    await setup();
    const queued = await start();
    await running();

    h.domain.computeJobs.stop();

    await vi.waitFor(() => expect(statusOf(queued.id)).toBe('cancelled'));
    expect(h.repos.computeJobRuns.get(queued.id)?.reason).toBe('shutdown');
    expect(jobs.pending[0]!.signal.aborted).toBe(true);
  });

  describe('reading runs', () => {
    let seq = 0;
    /** A run row of a project, made `seq` seconds after the epoch so the order is known. */
    function seed(projectKey: string, repo: string, job: string) {
      seq += 1;
      const id = `job_seed${seq}`;
      h.repos.computeJobRuns.insert({
        id,
        projectKey,
        repo,
        job,
        commit: COMMIT,
        runner: 'github_actions',
        requestedBy: 'devops',
        taskKey: null,
        createdAt: new Date(seq * 1000).toISOString(),
      });
      return id;
    }

    async function setupWithRuns() {
      await setup();
      h.repos.projects.insert({
        key: 'OTHER',
        name: 'Other',
        templateId: null,
        configVersion: 'v1',
        createdAt: '2026-09-29T10:00:00.000Z',
        updatedAt: '2026-09-29T10:00:00.000Z',
      });
      return {
        webImage: seed('AR', 'web', 'cloud-image'),
        webDocs: seed('AR', 'web', 'docs'),
        apiImage: seed('AR', 'api', 'cloud-image'),
        foreign: seed('OTHER', 'web', 'cloud-image'),
      };
    }

    it('gets a run of the project and refuses one of another project or none', async () => {
      const runs = await setupWithRuns();

      expect(h.domain.computeJobs.get('AR', runs.webImage).id).toBe(runs.webImage);
      expect(() => h.domain.computeJobs.get('AR', runs.foreign)).toThrowError(/not found/);
      expect(() => h.domain.computeJobs.get('AR', 'job_missing')).toThrowError(/not found/);
    });

    it('lists the runs of the project only, newest first', async () => {
      const runs = await setupWithRuns();

      expect(h.domain.computeJobs.list('AR').map((run) => run.id)).toEqual([
        runs.apiImage,
        runs.webDocs,
        runs.webImage,
      ]);
    });

    it.each([
      ['the repository', { repo: 'web' }, ['webDocs', 'webImage']],
      ['the job', { job: 'cloud-image' }, ['apiImage', 'webImage']],
      ['the repository and the job', { repo: 'web', job: 'cloud-image' }, ['webImage']],
      ['the limit', { limit: 1 }, ['apiImage']],
    ] as const)('filters the list by %s', async (_name, filter, expected) => {
      const runs = await setupWithRuns();

      expect(h.domain.computeJobs.list('AR', filter).map((run) => run.id)).toEqual(
        expected.map((name) => runs[name]),
      );
    });
  });
});
