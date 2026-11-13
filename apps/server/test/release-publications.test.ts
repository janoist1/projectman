import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_ENGINE_ID, MemberConfig, RepoConfig } from '@projectman/shared';
import type { Actor, EngineView, ProjectConfig } from '@projectman/shared';
import { MergeError } from '../src/contracts';
import type { BranchMerger, FullTestExecutor, FullTestSpec, MergeBaseState } from '../src/contracts';
import { LocalEngineDirectory } from '../src/runtime/sessions';
import { releaseStatusOf } from '../src/services/releases';
import { createSuperExecution } from '../src/services/super';
import { OWNER, OWNER_ACTOR, createDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { connectedClaude, inIntegratorExecution } from './helpers/integrator-scope';

const DEVOPS: Actor = { kind: 'ai', handle: 'devops' };

/** A commit id as the repository would print it. */
const sha = (n: number) => n.toString(16).padStart(40, '0');

/** Cards merged one after the other: AR-1 landed as sha(1), AR-2 as sha(2), AR-3 as sha(3). */
const MERGED = [
  { key: 'AR-1', commit: sha(1) },
  { key: 'AR-2', commit: sha(2) },
  { key: 'AR-3', commit: sha(3) },
];

/** A repository that is one line of history, with a remote that keeps the tags it is sent. */
function fakeMerger(head: string, onRemote = false) {
  const base: MergeBaseState = {
    local: head,
    remote: null,
    relation: 'same',
    contains: { local: false, remote: onRemote ? true : null },
    checkout: null,
  };
  const remote = new Map<string, string>();
  const merger = {
    prepare: vi.fn<BranchMerger['prepare']>(async () => structuredClone(base)),
    isAncestor: vi.fn<BranchMerger['isAncestor']>(async (_ref, { ancestor, commit }) => ancestor <= commit),
    remoteTags: vi.fn<BranchMerger['remoteTags']>(async () =>
      [...remote].map(([name, commit]) => ({ name, commit })),
    ),
    pushTag: vi.fn<BranchMerger['pushTag']>(async (_ref, { tag, commit }) => {
      remote.set(tag, commit);
      return { ok: true };
    }),
  } as unknown as BranchMerger;
  return { merger, remote };
}

/** An executor that only records the compute jobs it is asked to run; they end when the harness is stopped. */
function recordingExecutor() {
  const specs: FullTestSpec[] = [];
  const executor: FullTestExecutor = {
    available: async () => ({ ok: true }),
    run: (spec, signal) =>
      new Promise((resolve) => {
        specs.push(spec);
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
  return { executor, specs };
}

describe('publish_release', () => {
  let h: DomainHarness;
  let git: ReturnType<typeof fakeMerger>;
  let jobs: ReturnType<typeof recordingExecutor>;

  async function setup(
    opts: { extraRepo?: boolean; merged?: typeof MERGED; engineRelease?: 'registered' | 'unpublished' } = {},
  ) {
    const merged = opts.merged ?? MERGED;
    git = fakeMerger(merged.at(-1)!.commit, opts.engineRelease === 'registered');
    jobs = recordingExecutor();
    h = await createDomainHarness({
      merger: git.merger,
      fullTestExecutor: jobs.executor,
      adjust(config: ProjectConfig) {
        config.project.repos[0]!.github = 'acme/web';
        if (opts.engineRelease)
          config.project.repos[0]!.computeJobs = [
            {
              id: 'engine-release',
              workflow: 'projectman-engine-release.yml',
              command: 'engine-release',
              runsOn: 'macos-15',
              outputs: ['app/projectman-motor.json'],
              node: '22',
              timeoutMinutes: 60,
            },
          ];
        if (opts.extraRepo) config.project.repos.push(RepoConfig.parse({ name: 'notes', path: 'notes' }));
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
    for (const [index, { key, commit }] of merged.entries()) {
      await h.domain.tasks.create('AR', { title: `Card ${key}`, repo: 'web' }, OWNER_ACTOR);
      h.repos.taskMerges.save({
        id: `mrg_${index + 1}`,
        projectKey: 'AR',
        taskKey: key,
        repo: 'web',
        base: 'main',
        commit: `branch-${key}`,
        branch: `pm/${key}`,
        fromStageId: 'code_review',
        toStageId: 'done',
        merger: 'dev-1',
        requestedAt: '2026-01-01T00:00:00.000Z',
        startedBy: 'dev-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        mergeCommit: commit,
        landed: 'nowhere',
        state: 'merged',
        step: 'finishing',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      });
    }
  }

  function recordLiveRelease(commit: string) {
    const at = '2026-01-05T00:00:00.000Z';
    h.repos.releases.insert(
      {
        id: 'rel_1',
        projectKey: 'AR',
        repo: 'web',
        taskKey: 'AR-1',
        state: 'live',
        commit,
        baseCommit: null,
        tasks: ['AR-1'],
        summary: 'Summary',
        proposedBy: 'dev-1',
        proposedAt: at,
        decidedBy: null,
        decidedAt: null,
        deployStartedAt: null,
        previousCommit: null,
        liveAt: at,
        tag: null,
        url: null,
        publishedAt: null,
        failure: null,
        publishError: null,
      },
      at,
    );
  }

  const publish = (over: { commit?: string; tag?: string; by?: Actor } = {}) =>
    h.domain.releasePublications.publish('AR', over.by ?? OWNER_ACTOR, {
      summary: '- Things changed',
      ...(over.commit ? { commit: over.commit } : {}),
      ...(over.tag ? { tag: over.tag } : {}),
    });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.cleanup();
  });

  it('tags the head and makes the GitHub release with the cards in the notes', async () => {
    await setup();

    const result = await publish();

    expect(result).toMatchObject({ repo: 'web', commit: sha(3), baseCommit: null, url: expect.any(String) });
    expect(result.tasks.map((task) => task.key)).toEqual(['AR-1', 'AR-2', 'AR-3']);
    expect(git.merger.pushTag).toHaveBeenCalledWith(
      { projectKey: 'AR', repo: 'web' },
      { base: 'main', tag: result.tag, commit: sha(3) },
    );
    expect(h.github.published).toHaveLength(1);
    expect(h.github.published[0]).toMatchObject({ repo: 'acme/web', tag: result.tag, title: result.tag });
    expect(h.github.published[0]!.notes).toContain('- AR-2 Card AR-2');
    expect(h.repos.releasePublications.byCommit('AR', 'web', sha(3))?.url).toBe(result.url);
  });

  describe('the engine app build (PM-1424)', () => {
    it('starts the registered engine-release job on the release commit', async () => {
      await setup({ engineRelease: 'registered' });

      const result = await publish();

      expect(result.appBuild).toMatchObject({ state: 'started', job: 'engine-release' });
      await vi.waitFor(() => expect(jobs.specs).toHaveLength(1));
      expect(jobs.specs[0]!.githubJob).toMatchObject({
        job: 'engine-release',
        workflow: 'projectman-engine-release.yml',
        commit: sha(3),
      });
      expect(
        h.repos.computeJobRuns.latestFor({
          projectKey: 'AR',
          repo: 'web',
          job: 'engine-release',
          commit: sha(3),
        }),
      ).toMatchObject({ requestedBy: 'owner', taskKey: null });
    });

    it('reuses the live run of the same commit instead of starting another', async () => {
      await setup({ engineRelease: 'registered' });
      const first = await publish();
      await vi.waitFor(() => expect(jobs.specs).toHaveLength(1));

      const again = await h.domain.computeJobs.startAppBuild(OWNER_ACTOR, {
        projectKey: 'AR',
        repo: 'web',
        commit: sha(3),
      });

      expect(first.appBuild).toMatchObject({ state: 'started' });
      expect(again).toMatchObject({
        state: 'reused',
        job: 'engine-release',
        runId: (first.appBuild as { runId: string }).runId,
      });
      expect(jobs.specs).toHaveLength(1);
    });

    it('reports not_configured when the repository registers no engine-release job', async () => {
      await setup();

      const result = await publish();

      expect(result.appBuild).toEqual({ state: 'not_configured' });
      expect(jobs.specs).toEqual([]);
    });

    it('keeps the release published when the build cannot start', async () => {
      await setup({ engineRelease: 'unpublished' });

      const result = await publish();

      expect(result.appBuild).toMatchObject({ state: 'failed', job: 'engine-release' });
      expect(result.url).toEqual(expect.any(String));
      expect(h.repos.releasePublications.byCommit('AR', 'web', sha(3))?.url).toBe(result.url);
    });

    it('starts nothing in a preview', async () => {
      await setup({ engineRelease: 'registered' });

      const result = await h.domain.releasePublications.preview('AR', DEVOPS, { summary: 'x' });

      expect(result.appBuild).toBeNull();
      expect(jobs.specs).toEqual([]);
      expect(
        h.repos.computeJobRuns.latestFor({
          projectKey: 'AR',
          repo: 'web',
          job: 'engine-release',
          commit: sha(3),
        }),
      ).toBeNull();
    });
  });

  it('records and sends nothing in a preview', async () => {
    await setup();

    const result = await h.domain.releasePublications.preview('AR', DEVOPS, { summary: 'x' });

    expect(result.url).toBeNull();
    expect(result.tasks).toHaveLength(3);
    expect(git.merger.pushTag).not.toHaveBeenCalled();
    expect(h.github.published).toEqual([]);
    expect(h.repos.releasePublications.byCommit('AR', 'web', sha(3))).toBeNull();
  });

  describe('the production gate (PM-1238)', () => {
    const refusedWithNothingWritten = () => {
      expect(git.merger.pushTag).not.toHaveBeenCalled();
      expect(h.github.published).toEqual([]);
      expect(h.repos.releasePublications.byCommit('AR', 'web', sha(3))).toBeNull();
    };

    it.each([
      ['the devops', DEVOPS],
      ['an AI member without the duty', { kind: 'ai', handle: 'nobody' } as Actor],
    ])('refuses %s a publication', async (_name, by) => {
      await setup();

      await expect(publish({ by })).rejects.toMatchObject({ code: 'release_owner_only' });
      refusedWithNothingWritten();
    });

    it('refuses a preview to an AI member without the deployment duty', async () => {
      await setup();

      await expect(
        h.domain.releasePublications.preview('AR', { kind: 'ai', handle: 'nobody' }, { summary: 'x' }),
      ).rejects.toMatchObject({ code: 'release_owner_only' });
    });

    it('refuses the connected Claude on a queue item an AI member issued', async () => {
      await setup();

      await expect(
        inIntegratorExecution(connectedClaude('owner', 'devops'), () =>
          publish({ by: connectedClaude('owner', 'devops') }),
        ),
      ).rejects.toMatchObject({ code: 'release_owner_only' });
      refusedWithNothingWritten();
    });

    it('lets the connected Claude publish in person, the owner being the publisher', async () => {
      await setup();
      const claude = connectedClaude();

      const result = await inIntegratorExecution(claude, () => publish({ by: claude }));

      expect(result.url).toEqual(expect.any(String));
      expect(h.repos.releasePublications.byCommit('AR', 'web', sha(3))).toMatchObject({
        publishedBy: 'owner',
      });
    });

    it('refuses a further owner’s live scope even when the actor owns the project', async () => {
      await setup();
      const claude = connectedClaude();
      await expect(
        inIntegratorExecution(claude, () => publish({ by: claude }), { hostOwner: false }),
      ).rejects.toMatchObject({ code: 'host_only' });
      refusedWithNothingWritten();
    });

    it('refuses publication when host ownership changes during an engine call', async () => {
      await setup();
      const claude = connectedClaude();
      let hostOwner = 'user-1';
      const execution = createSuperExecution({
        projects: h.domain.projects,
        audit: h.domain.superAudit,
        credentials: {
          assertActive: () => {},
          user: () => OWNER,
          keyCoversProject: () => true,
          isHostOwner: (userId) => userId === hostOwner,
        },
      });
      vi.mocked(git.merger.remoteTags).mockImplementationOnce(async () => {
        hostOwner = 'user-2';
        return [];
      });

      await expect(
        execution.run(
          {
            principal: {
              kind: 'integrator',
              userId: 'user-1',
              keyId: 'ikey_test_1',
              prefix: 'pmi_aaaaaaaa',
              mode: 'super',
            },
            email: OWNER.email,
            projectKey: 'AR',
            requestId: 'req-host-transfer',
          },
          () => publish({ by: claude }),
        ),
      ).rejects.toMatchObject({ code: 'host_only' });
      expect(git.merger.remoteTags).toHaveBeenCalledOnce();
      refusedWithNothingWritten();
    });

    it('refuses a bound actor outside an authenticated execution', async () => {
      await setup();

      await expect(publish({ by: connectedClaude() })).rejects.toMatchObject({
        code: 'insufficient_access',
      });
      refusedWithNothingWritten();
    });

    it('stops before the tag is pushed when the owner right is gone by the write', async () => {
      await setup();
      const claude = connectedClaude();

      await expect(
        inIntegratorExecution(claude, () => publish({ by: claude }), { accessChecks: 1 }),
      ).rejects.toMatchObject({ code: 'insufficient_access' });
      refusedWithNothingWritten();
    });
  });

  it('refuses a repository without a GitHub repository', async () => {
    await setup({ extraRepo: true });

    await expect(
      h.domain.releasePublications.publish('AR', OWNER_ACTOR, { summary: 'x', repo: 'notes' }),
    ).rejects.toMatchObject({ code: 'release_no_github' });
  });

  it('refuses a commit that is no recorded merge', async () => {
    await setup();

    await expect(publish({ commit: sha(9) })).rejects.toMatchObject({ code: 'release_commit_unknown' });
  });

  it('refuses a tag that is on another commit on the remote', async () => {
    await setup();
    git.remote.set('v1.0', sha(1));

    await expect(publish({ tag: 'v1.0' })).rejects.toMatchObject({ code: 'release_tag_taken' });
    expect(git.merger.pushTag).not.toHaveBeenCalled();
  });

  it('refuses a commit that is published already, with its tag and URL', async () => {
    await setup();
    const first = await publish();

    await expect(publish()).rejects.toMatchObject({
      code: 'release_already_published',
      details: { tag: first.tag, url: first.url },
    });
  });

  it('lists only the cards since the previous publication, under the next tag of the day', async () => {
    await setup();
    const first = await publish({ commit: sha(2) });

    const second = await publish();

    expect(second.baseCommit).toBe(sha(2));
    expect(second.tasks.map((task) => task.key)).toEqual(['AR-3']);
    expect(second.tag).toBe(`${first.tag}.2`);
  });

  it('starts from the latest live release of the instance when nothing was published yet', async () => {
    await setup();
    recordLiveRelease(sha(1));

    const result = await publish();

    expect(result.baseCommit).toBe(sha(1));
    expect(result.tasks.map((task) => task.key)).toEqual(['AR-2', 'AR-3']);
  });

  it('asks git nothing when the base is a recorded merge', async () => {
    await setup();
    await publish({ commit: sha(1) });
    vi.mocked(git.merger.isAncestor).mockClear();

    const result = await h.domain.releasePublications.preview('AR', DEVOPS, { summary: 'x' });

    expect(result.tasks.map((task) => task.key)).toEqual(['AR-2', 'AR-3']);
    expect(git.merger.isAncestor).not.toHaveBeenCalled();
  });

  it('asks git once per unreleased merge and once more when the base is not a recorded merge', async () => {
    await setup({
      merged: [
        { key: 'AR-1', commit: sha(1) },
        { key: 'AR-2', commit: sha(3) },
        { key: 'AR-3', commit: sha(5) },
        { key: 'AR-4', commit: sha(7) },
      ],
    });
    recordLiveRelease(sha(2));

    const result = await h.domain.releasePublications.preview('AR', DEVOPS, { summary: 'x' });

    expect(result.tasks.map((task) => task.key)).toEqual(['AR-2', 'AR-3', 'AR-4']);
    expect(vi.mocked(git.merger.isAncestor).mock.calls.map(([, input]) => input)).toEqual([
      { ancestor: sha(7), commit: sha(2) },
      { ancestor: sha(5), commit: sha(2) },
      { ancestor: sha(3), commit: sha(2) },
      { ancestor: sha(1), commit: sha(2) },
    ]);
  });

  describe('unreleased (PM-1201)', () => {
    it('counts the cards merged after the base of the previous release, from the records alone', async () => {
      await setup();
      await publish({ commit: sha(1) });
      vi.mocked(git.merger.prepare).mockClear();

      expect(h.domain.releasePublications.unreleased('AR')).toEqual([
        {
          repo: 'web',
          base: sha(1),
          count: 2,
          oldestAt: '2026-01-02T00:00:00.000Z',
          taskKeys: ['AR-2', 'AR-3'],
        },
      ]);
      expect(git.merger.prepare).not.toHaveBeenCalled();
      expect(git.merger.isAncestor).not.toHaveBeenCalled();
    });

    it('is empty while the base is unknown: no release yet, or one that is no recorded merge', async () => {
      await setup();
      expect(h.domain.releasePublications.unreleased('AR')).toEqual([]);

      recordLiveRelease(sha(9));
      expect(h.domain.releasePublications.unreleased('AR')).toEqual([]);
    });

    it('is empty when the previous release already holds every merge', async () => {
      await setup();
      await publish({ commit: sha(3) });
      expect(h.domain.releasePublications.unreleased('AR')).toEqual([]);
    });
  });

  it('uses the project’s registered engine instead of the local engine', async () => {
    await setup();
    const engineId = 'eng_aaaaaaaaaaaa';
    const get = LocalEngineDirectory.prototype.get;
    vi.spyOn(LocalEngineDirectory.prototype, 'projectEngine').mockReturnValue(engineId);
    vi.spyOn(LocalEngineDirectory.prototype, 'get').mockImplementation(function (
      this: LocalEngineDirectory,
      id: string,
    ) {
      return id === engineId ? get.call(this, LOCAL_ENGINE_ID) : null;
    });

    const result = await h.domain.releasePublications.preview('AR', DEVOPS, { summary: 'x' });

    expect(result.tasks).toHaveLength(3);
    expect(LocalEngineDirectory.prototype.projectEngine).toHaveBeenCalledWith('AR');
    expect(git.merger.prepare).toHaveBeenCalled();
  });

  it('reuses a date tag that the remote already has on this commit', async () => {
    await setup();
    git.remote.set('v2026.1.1', sha(3));

    const result = await publish();

    expect(result.tag).toBe('v2026.1.1');
    expect(git.merger.pushTag).not.toHaveBeenCalled();
    expect(h.github.published[0]).toMatchObject({ tag: 'v2026.1.1' });
  });

  it('finishes an interrupted publication on a repeated call, without pushing the tag again', async () => {
    await setup();
    h.github.releaseFailure = new Error('gh is down');

    await expect(publish()).rejects.toMatchObject({
      code: 'release_publish_failed',
      details: { step: 'github' },
    });
    const pending = h.repos.releasePublications.byCommit('AR', 'web', sha(3))!;
    expect(pending.url).toBeNull();
    h.github.releaseFailure = null;

    const result = await publish();

    expect(result.tag).toBe(pending.tag);
    expect(git.merger.pushTag).toHaveBeenCalledTimes(1);
    expect(h.repos.releasePublications.byCommit('AR', 'web', sha(3))?.url).toBe(result.url);
  });

  it('reports a tag the remote refused as a failed publication and records nothing', async () => {
    await setup();
    vi.mocked(git.merger.pushTag).mockResolvedValueOnce({ ok: false, reason: 'rejected', message: 'denied' });

    await expect(publish()).rejects.toMatchObject({
      code: 'release_publish_failed',
      details: { step: 'tag' },
    });
    expect(h.repos.releasePublications.byCommit('AR', 'web', sha(3))).toBeNull();
    expect(h.github.published).toEqual([]);
  });

  it('reports a git failure of the engine as a failed publication', async () => {
    await setup();
    vi.mocked(git.merger.remoteTags).mockRejectedValueOnce(new MergeError('no_remote', 'no upstream'));

    await expect(publish()).rejects.toMatchObject({ code: 'release_publish_failed' });
  });
});

describe('get_release_status (PM-1201)', () => {
  const engine = (over: Partial<EngineView>): EngineView => ({
    id: 'eng_1',
    name: 'Mac',
    isDefault: true,
    online: true,
    lastSeenAt: '2026-10-30T10:00:00.000Z',
    keyPrefix: 'pm_',
    createdAt: '2026-10-01T10:00:00.000Z',
    createdBy: 'Owner',
    revokedAt: null,
    lastSeenIp: null,
    hostname: null,
    platform: 'darwin',
    version: '1.2.3',
    versionMismatch: false,
    providers: [],
    runningSessions: 0,
    waitingStarts: 0,
    waitingMessages: 0,
    ...over,
  });

  it('shows the hub version and each engine’s connection, version and mismatch, without a revoked engine', () => {
    const status = releaseStatusOf('1.2.4', [
      engine({}),
      engine({ id: 'eng_2', name: 'Old', online: false, version: '1.2.3', versionMismatch: true }),
      engine({ id: 'eng_3', name: 'Gone', revokedAt: '2026-10-02T10:00:00.000Z' }),
    ]);
    expect(status).toEqual({
      hub: { version: '1.2.4' },
      engines: [
        {
          id: 'eng_1',
          name: 'Mac',
          connected: true,
          version: '1.2.3',
          versionMismatch: false,
          lastSeenAt: '2026-10-30T10:00:00.000Z',
        },
        {
          id: 'eng_2',
          name: 'Old',
          connected: false,
          version: '1.2.3',
          versionMismatch: true,
          lastSeenAt: '2026-10-30T10:00:00.000Z',
        },
      ],
    });
  });
});
