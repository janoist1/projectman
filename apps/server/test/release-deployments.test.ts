import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberConfig } from '@projectman/shared';
import { sendControlRequest } from '../../../scripts/control/client';
import { serveControlConnection } from '../src/control';
import type { ControlRelease } from '../src/control';
import { recordingLog, ScriptedPause } from './helpers/control';
import type {
  HybridDeployment,
  ProjectConfig,
  ReleaseDeploymentChange,
  ReleaseEngineStatus,
  ReleaseImageRef,
} from '@projectman/shared';
import type { BranchMerger, MergeBaseState } from '../src/contracts';
import { createDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const TARGET = { projectKey: 'AR', repo: 'web' };
const ENGINE_ID = 'eng_abcdefghijkl';
const HASH = 'a'.repeat(64);
const OWNER = { handle: 'owner', access: 'owner' as const };
const PREVIOUS = sha(1);
const NEW = sha(2);
const image = (commit: string): ReleaseImageRef => ({
  commit,
  imageId: `sha256:${commit.padStart(64, '0')}`,
  platform: 'linux/arm64',
});
const artifact = (commit: string) => ({
  ...image(commit),
  manifestSha256: 'b'.repeat(64),
  archiveSha256: 'c'.repeat(64),
  archiveBytes: 1024,
});

describe('the hybrid release deployment (PM-752)', () => {
  let h: DomainHarness;
  /** What the cloud registry says about the engine; a test moves it like the real engine would. */
  let engine: ReleaseEngineStatus;

  async function setup(hybrid = true) {
    engine = { id: ENGINE_ID, online: true, version: PREVIOUS, lastSeenAt: null };
    const base: MergeBaseState = {
      local: NEW,
      remote: null,
      relation: 'same',
      contains: { local: false, remote: null },
      checkout: null,
    };
    const merger = {
      prepare: vi.fn(async () => structuredClone(base)),
      // The repository is one line of history: a commit is an ancestor of every later one.
      isAncestor: vi.fn(
        async (_ref: unknown, { ancestor, commit }: { ancestor: string; commit: string }) =>
          ancestor <= commit,
      ),
    } as unknown as BranchMerger;
    h = await createDomainHarness({
      merger,
      releaseTarget: TARGET,
      appVersion: PREVIOUS,
      ...(hybrid
        ? { releaseHybrid: { binding: { engineId: ENGINE_ID, targetHash: HASH }, engines: () => [engine] } }
        : {}),
      adjust(config: ProjectConfig) {
        config.project.repos[0]!.docs = { roadmap: 'docs/ROADMAP.md' };
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
    await h.domain.tasks.create('AR', { title: 'Card one', repo: 'web' }, { kind: 'human', handle: 'owner' });
    h.repos.taskMerges.save({
      id: 'mrg_1',
      projectKey: 'AR',
      taskKey: 'AR-1',
      repo: 'web',
      base: 'main',
      commit: 'branch-AR-1',
      branch: 'pm/AR-1',
      fromStageId: 'code_review',
      toStageId: 'done',
      merger: 'dev-1',
      requestedAt: '2026-01-01T00:00:00.000Z',
      startedBy: 'dev-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      mergeCommit: NEW,
      landed: 'nowhere',
      state: 'merged',
      step: 'finishing',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-02T00:00:00.000Z',
    });
  }

  async function approved() {
    const { release } = await h.domain.releases.propose('AR', 'devops', {
      title: 'Release',
      summary: '- AR-1',
    });
    const item = h.domain.inbox.list('AR', { kind: 'release', state: 'open' })[0]!;
    await h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, OWNER);
    return release;
  }

  /** The release_failed alerts the approvers got about one release. */
  const releaseAlerts = (releaseId: string) =>
    h.domain.inbox
      .list('AR', { kind: 'alert', state: 'open' })
      .filter((item) => (item.payload as { releaseId?: string } | null)?.releaseId === releaseId);
  const deployments = () => h.domain.releaseDeployments;
  const beginInput = (releaseId: string, over: Record<string, unknown> = {}) => ({
    releaseId,
    attemptId: randomUUID(),
    controllerId: randomUUID(),
    requestId: randomUUID(),
    targetHash: HASH,
    engineId: ENGINE_ID,
    previousImage: image(PREVIOUS),
    ...over,
  });
  /** An accepted begin; returns the deployment and the attempt. */
  async function begun() {
    const release = await approved();
    const input = beginInput(release.id);
    const view = await deployments().begin(input);
    return { release, attemptId: input.attemptId, view, deployment: view.deployment! };
  }
  /** One change on top of the stored revision. */
  async function change(
    release: { id: string },
    attemptId: string,
    body: ReleaseDeploymentChange,
    over: { expectedRevision?: number; requestId?: string } = {},
  ) {
    const current = h.repos.releaseDeployments.get(release.id)!;
    return deployments().change({
      releaseId: release.id,
      attemptId,
      requestId: over.requestId ?? randomUUID(),
      expectedRevision: over.expectedRevision ?? current.revision,
      change: body,
    });
  }
  /** Up to `switching`: prepared, quiesced and switched, as the coordinator would. */
  async function switching() {
    const attempt = await begun();
    const { release, attemptId } = attempt;
    await change(release, attemptId, { kind: 'prepared', artifact: artifact(release.commit) });
    await change(release, attemptId, { kind: 'quiesce' });
    await change(release, attemptId, { kind: 'switch' });
    return attempt;
  }
  /** The program of both targets as `commit`. */
  function runs(commit: string) {
    h.setAppVersion(commit);
    engine = { ...engine, version: commit };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.cleanup();
  });

  describe('begin', () => {
    it('claims the approved release and records the attempt with the server-observed previous versions', async () => {
      await setup();
      const { release, view } = await begun();
      expect(view.deployment).toMatchObject({
        releaseId: release.id,
        revision: 0,
        phase: 'preparing',
        maintenance: false,
        pauseId: null,
        artifact: null,
        previousImage: image(PREVIOUS),
        previousEngineCommit: PREVIOUS,
        previousSchemaVersion: expect.any(Number),
      });
      expect(view.release).toMatchObject({ state: 'deploying', previousCommit: PREVIOUS });
      expect(view.drain.ready).toBe(true);
    });

    it('answers a repeated request from the stored attempt, and refuses another payload under its id', async () => {
      await setup();
      const release = await approved();
      const input = beginInput(release.id);
      const first = await deployments().begin(input);
      const again = await deployments().begin(input);
      expect(again.deployment).toEqual(first.deployment);
      await expect(deployments().begin({ ...input, controllerId: randomUUID() })).rejects.toMatchObject({
        code: 'release_deployment_conflict',
      });
      await expect(deployments().begin(beginInput(release.id))).rejects.toMatchObject({
        code: 'release_deployment_conflict',
      });
    });

    it('refuses another engine, another target hash and an image that is not the running one', async () => {
      await setup();
      const release = await approved();
      await expect(
        deployments().begin(beginInput(release.id, { engineId: 'eng_zzzzzzzzzzzz' })),
      ).rejects.toMatchObject({ code: 'release_engine_mismatch' });
      await expect(
        deployments().begin(beginInput(release.id, { targetHash: 'd'.repeat(64) })),
      ).rejects.toMatchObject({ code: 'release_target_mismatch' });
      await expect(
        deployments().begin(beginInput(release.id, { previousImage: image(sha(7)) })),
      ).rejects.toMatchObject({ code: 'release_target_mismatch' });
      expect(h.repos.releaseDeployments.get(release.id)).toBeNull();
      expect(h.domain.releases.get(release.id).state).toBe('approved');
    });

    it('needs an engine that is online and reports a commit', async () => {
      await setup();
      const release = await approved();
      engine = { ...engine, online: false };
      await expect(deployments().begin(beginInput(release.id))).rejects.toMatchObject({
        code: 'engine_offline',
      });
      engine = { ...engine, online: true, version: 'dev' };
      await expect(deployments().begin(beginInput(release.id))).rejects.toMatchObject({
        code: 'release_engine_mismatch',
      });
      expect(h.domain.releases.get(release.id).state).toBe('approved');
    });

    it('needs the engine to run the commit the server runs, not just some commit', async () => {
      await setup();
      const release = await approved();
      engine = { ...engine, version: sha(7) };
      await expect(deployments().begin(beginInput(release.id))).rejects.toMatchObject({
        code: 'release_engine_mismatch',
        details: { version: sha(7), appVersion: PREVIOUS },
      });
      expect(h.repos.releaseDeployments.get(release.id)).toBeNull();
      expect(h.domain.releases.get(release.id).state).toBe('approved');
    });

    it('refuses a new proposal while a deployment still holds the instance, though no release is open', async () => {
      await setup();
      const { release, attemptId } = await switching();
      runs(release.commit);
      const live = await change(release, attemptId, {
        kind: 'report',
        report: { outcome: 'live' },
        image: artifact(release.commit),
      });
      expect(live.release.state).toBe('live');
      const propose = () => h.domain.releases.propose('AR', 'devops', { title: 'Next', summary: '- AR-1' });
      await expect(propose()).rejects.toMatchObject({ code: 'release_deployment_conflict' });
      const refusal = await h.domain.releases.check('AR');
      expect(refusal.refusal).toMatchObject({ code: 'release_deployment_conflict' });
      await change(release, attemptId, { kind: 'resume', pauseId: live.deployment!.pauseId! });
      // The slot is free: whatever the proposal meets now is about its candidate, not the deployment.
      await expect(propose()).rejects.not.toMatchObject({ code: 'release_deployment_conflict' });
    });

    it('holds the slot for one deployment: an active one refuses another release', async () => {
      await setup();
      const { release } = await begun();
      const other = {
        ...h.repos.releaseDeployments.get(release.id)!,
        releaseId: 'rel_other',
        attemptId: randomUUID(),
      };
      expect(() => h.repos.releaseDeployments.insert(other)).toThrow();
    });

    it('is not configured on an instance without a hybrid binding, and the legacy pair is refused on one with it', async () => {
      await setup(false);
      const release = await approved();
      await expect(deployments().begin(beginInput(release.id))).rejects.toMatchObject({
        code: 'release_not_configured',
      });
      expect(() => deployments().refuseLegacy()).not.toThrow();
      await h.cleanup();
      await setup();
      expect(() => deployments().refuseLegacy()).toThrowError(/hybrid/);
      try {
        deployments().refuseLegacy();
      } catch (error) {
        expect(error).toMatchObject({ code: 'release_protocol_unavailable' });
      }
    });
  });

  describe('the way to live', () => {
    it('prepares, quiesces behind the fence, switches when drained, goes live and resumes', async () => {
      await setup();
      const { release, attemptId } = await begun();
      const prepared = await change(release, attemptId, {
        kind: 'prepared',
        artifact: artifact(release.commit),
      });
      expect(prepared.deployment).toMatchObject({ phase: 'prepared', revision: 1 });

      const quiesced = (await change(release, attemptId, { kind: 'quiesce' })).deployment!;
      expect(quiesced).toMatchObject({ phase: 'quiescing', maintenance: true });
      expect(h.repos.releaseDeployments.maintenanceHeld()).toBe(true);
      expect(h.repos.pauses.get(quiesced.pauseId!)).toMatchObject({ scope: 'instance', resumedAt: null });

      const switched = (await change(release, attemptId, { kind: 'switch' })).deployment!;
      expect(switched.phase).toBe('switching');

      runs(release.commit);
      const live = await change(release, attemptId, {
        kind: 'report',
        report: { outcome: 'live' },
        image: artifact(release.commit),
      });
      expect(live.deployment).toMatchObject({ phase: 'live', maintenance: true });
      expect(live.release.state).toBe('live');
      // The fence stays up until the deployment itself ends it.
      expect(h.repos.releaseDeployments.maintenanceHeld()).toBe(true);

      const resumed = (await change(release, attemptId, { kind: 'resume', pauseId: quiesced.pauseId! }))
        .deployment!;
      expect(resumed).toMatchObject({ phase: 'live', maintenance: false });
      expect(h.repos.releaseDeployments.maintenanceHeld()).toBe(false);
      expect(h.repos.releaseDeployments.active()).toBeNull();
      expect(h.repos.pauses.get(quiesced.pauseId!)!.resumedAt).not.toBeNull();

      const published = await change(release, attemptId, {
        kind: 'report',
        report: { outcome: 'published', tag: 'v2026.1.2', url: 'https://example.invalid/r' },
      });
      expect(published.deployment!.phase).toBe('published');
      expect(published.release.state).toBe('published');
    });

    it('binds the artifact once: a different one is refused, the same one changes nothing', async () => {
      await setup();
      const { release, attemptId } = await begun();
      await change(release, attemptId, { kind: 'prepared', artifact: artifact(release.commit) });
      const same = await change(release, attemptId, { kind: 'prepared', artifact: artifact(release.commit) });
      expect(same.deployment!.revision).toBe(1);
      await expect(
        change(release, attemptId, {
          kind: 'prepared',
          artifact: { ...artifact(release.commit), archiveBytes: 2048 },
        }),
      ).rejects.toMatchObject({ code: 'release_artifact_changed' });
    });

    it('refuses an artifact that is not built from the release commit', async () => {
      await setup();
      const { release, attemptId } = await begun();
      await expect(
        change(release, attemptId, { kind: 'prepared', artifact: artifact(sha(55)) }),
      ).rejects.toMatchObject({ code: 'release_target_mismatch' });
    });

    it('is compare-and-swap on the revision and idempotent per request id', async () => {
      await setup();
      const { release, attemptId } = await begun();
      const requestId = randomUUID();
      const body: ReleaseDeploymentChange = { kind: 'prepared', artifact: artifact(release.commit) };
      await change(release, attemptId, body, { requestId, expectedRevision: 0 });
      // The same request again is answered, not applied twice.
      const again = await change(release, attemptId, body, { requestId, expectedRevision: 0 });
      expect(again.deployment!.revision).toBe(1);
      // Another request on the old revision lost the race.
      await expect(
        change(release, attemptId, { kind: 'quiesce' }, { expectedRevision: 0 }),
      ).rejects.toMatchObject({
        code: 'release_deployment_conflict',
        details: { revision: 1 },
      });
      // The same id with another payload is not a repeat.
      await expect(
        change(release, attemptId, { kind: 'quiesce' }, { requestId, expectedRevision: 1 }),
      ).rejects.toMatchObject({
        code: 'release_deployment_conflict',
      });
      await expect(change(release, randomUUID(), { kind: 'quiesce' })).rejects.toMatchObject({
        code: 'release_deployment_conflict',
      });
    });

    it('keeps its state in the database: a new service object sees the fence and the attempt', async () => {
      await setup();
      const { release, attemptId } = await begun();
      await change(release, attemptId, { kind: 'prepared', artifact: artifact(release.commit) });
      await change(release, attemptId, { kind: 'quiesce' });
      const stored = h.repos.releaseDeployments.get(release.id)!;
      expect(stored).toMatchObject({ phase: 'quiescing', maintenance: true, attemptId });
      expect(h.repos.releaseDeployments.active()).toEqual(stored);
      expect(h.domain.releaseDeployments.get(release.id).deployment).toEqual(stored);
    });
  });

  describe('the fence', () => {
    it('drains to ready on an idle instance with the engine online', async () => {
      await setup();
      const { release, attemptId } = await begun();
      await change(release, attemptId, { kind: 'prepared', artifact: artifact(release.commit) });
      await change(release, attemptId, { kind: 'quiesce' });
      expect(h.domain.releaseDeployments.drain()).toMatchObject({
        ready: true,
        uncertain: false,
        engineOnline: true,
        pending: { sessions: 0, merges: 0, documentWrites: 0, fullTests: 0, screenshots: 0 },
      });
    });

    it('refuses the switch while work is pending and says what', async () => {
      await setup();
      const { release, attemptId } = await begun();
      await change(release, attemptId, { kind: 'prepared', artifact: artifact(release.commit) });
      await change(release, attemptId, { kind: 'quiesce' });
      // A merge that an earlier process started: a running row with no permit is uncertain.
      h.repos.taskMerges.save({
        ...h.repos.taskMerges.list('merged')[0]!,
        id: 'mrg_run',
        taskKey: 'AR-9',
        state: 'running',
        step: 'merging',
        finishedAt: undefined,
      });
      await expect(change(release, attemptId, { kind: 'switch' })).rejects.toMatchObject({
        code: 'release_not_drained',
        details: { uncertain: true, pending: { merges: 1 } },
      });
      expect(h.repos.releaseDeployments.get(release.id)!.phase).toBe('quiescing');
    });

    it('refuses the switch when the engine is offline', async () => {
      await setup();
      const { release, attemptId } = await begun();
      await change(release, attemptId, { kind: 'prepared', artifact: artifact(release.commit) });
      await change(release, attemptId, { kind: 'quiesce' });
      engine = { ...engine, online: false };
      await expect(change(release, attemptId, { kind: 'switch' })).rejects.toMatchObject({
        code: 'release_not_drained',
        details: { engineOnline: false },
      });
    });

    it('does not let an ordinary resume lift the fence, and refuses a second pause owner', async () => {
      await setup();
      const { release, attemptId } = await begun();
      await change(release, attemptId, { kind: 'prepared', artifact: artifact(release.commit) });
      await change(release, attemptId, { kind: 'quiesce' });
      await expect(
        h.domain.pauses.resume({ scope: 'instance' }, { userId: null, source: 'control' }),
      ).rejects.toMatchObject({ code: 'release_pause_conflict' });
      expect(h.repos.releaseDeployments.maintenanceHeld()).toBe(true);
      expect(release.id).toBeTruthy();
    });

    it('refuses to quiesce when someone paused the instance already', async () => {
      await setup();
      const { release, attemptId } = await begun();
      await change(release, attemptId, { kind: 'prepared', artifact: artifact(release.commit) });
      await h.domain.pauses.pause({ scope: 'instance' }, { userId: null, source: 'control' }, {});
      await expect(change(release, attemptId, { kind: 'quiesce' })).rejects.toMatchObject({
        code: 'release_pause_conflict',
      });
      const stored = h.repos.releaseDeployments.get(release.id)!;
      expect(stored).toMatchObject({ phase: 'prepared', maintenance: false, pauseId: null });
    });

    it('refuses the switch when the pause was ended behind its back', async () => {
      await setup();
      const { release, attemptId } = await begun();
      await change(release, attemptId, { kind: 'prepared', artifact: artifact(release.commit) });
      const { deployment } = await change(release, attemptId, { kind: 'quiesce' });
      h.repos.pauses.close(deployment!.pauseId!, '2026-01-03T00:00:00.000Z', null);
      await expect(change(release, attemptId, { kind: 'switch' })).rejects.toMatchObject({
        code: 'release_pause_conflict',
      });
    });
  });

  describe('the result gates', () => {
    it('accepts live only when the cloud runs the release commit', async () => {
      await setup();
      const { release, attemptId } = await switching();
      engine = { ...engine, version: release.commit };
      await expect(
        change(release, attemptId, {
          kind: 'report',
          report: { outcome: 'live' },
          image: artifact(release.commit),
        }),
      ).rejects.toMatchObject({ code: 'release_target_mismatch' });
      expect(h.repos.releaseDeployments.get(release.id)!.phase).toBe('switching');
    });

    it('accepts live only when the engine runs the release commit, and not an offline one', async () => {
      await setup();
      const { release, attemptId } = await switching();
      h.setAppVersion(release.commit);
      await expect(
        change(release, attemptId, {
          kind: 'report',
          report: { outcome: 'live' },
          image: artifact(release.commit),
        }),
      ).rejects.toMatchObject({ code: 'release_engine_mismatch' });
      engine = { ...engine, online: false, version: release.commit };
      await expect(
        change(release, attemptId, {
          kind: 'report',
          report: { outcome: 'live' },
          image: artifact(release.commit),
        }),
      ).rejects.toMatchObject({ code: 'engine_offline' });
      expect(h.domain.releases.get(release.id).state).toBe('deploying');
    });

    it('accepts live only with the prepared image', async () => {
      await setup();
      const { release, attemptId } = await switching();
      runs(release.commit);
      await expect(
        change(release, attemptId, {
          kind: 'report',
          report: { outcome: 'live' },
          image: { ...image(release.commit), imageId: `sha256:${'9'.repeat(64)}` },
        }),
      ).rejects.toMatchObject({ code: 'release_artifact_changed' });
    });

    it('accepts a rollback only when both targets run the previous program', async () => {
      await setup();
      const { release, attemptId } = await switching();
      const failed: ReleaseDeploymentChange = {
        kind: 'report',
        report: {
          outcome: 'failed',
          failure: { step: 'switch', message: 'engine did not start', rolledBack: true },
        },
        image: image(PREVIOUS),
      };
      // The engine is on the new program: the rollback is not complete.
      engine = { ...engine, version: release.commit };
      await expect(change(release, attemptId, failed)).rejects.toMatchObject({
        code: 'release_engine_mismatch',
      });
      engine = { ...engine, version: PREVIOUS };
      const done = await change(release, attemptId, failed);
      expect(done.deployment).toMatchObject({ phase: 'failed', maintenance: true, recovery: null });
      expect(done.release).toMatchObject({ state: 'failed' });
      // A failed deployment resumes only against the previous program as well.
      const pauseId = done.deployment!.pauseId!;
      engine = { ...engine, version: release.commit };
      await expect(change(release, attemptId, { kind: 'resume', pauseId })).rejects.toMatchObject({
        code: 'release_engine_mismatch',
      });
      engine = { ...engine, version: PREVIOUS };
      const resumed = await change(release, attemptId, { kind: 'resume', pauseId });
      expect(resumed.deployment).toMatchObject({ phase: 'failed', maintenance: false });
      expect(h.repos.releaseDeployments.active()).toBeNull();
    });

    it('refuses to resume a live deployment while a target does not run the new program', async () => {
      await setup();
      const { release, attemptId } = await switching();
      runs(release.commit);
      const live = await change(release, attemptId, {
        kind: 'report',
        report: { outcome: 'live' },
        image: artifact(release.commit),
      });
      engine = { ...engine, version: PREVIOUS };
      await expect(
        change(release, attemptId, { kind: 'resume', pauseId: live.deployment!.pauseId! }),
      ).rejects.toMatchObject({ code: 'release_engine_mismatch' });
      await expect(change(release, attemptId, { kind: 'resume', pauseId: 'not-mine' })).rejects.toMatchObject(
        {
          code: 'release_pause_conflict',
        },
      );
    });

    it('needs recovery when the rollback did not complete, and nothing else moves until it is settled', async () => {
      await setup();
      const { release, attemptId } = await switching();
      const lost = await change(release, attemptId, {
        kind: 'report',
        report: {
          outcome: 'failed',
          failure: { step: 'switch', message: 'rollback failed', rolledBack: false },
        },
      });
      expect(lost.deployment).toMatchObject({
        phase: 'recovery_required',
        maintenance: true,
        recovery: { code: 'rollback_failed' },
      });
      // The release is not closed: nobody has shown the previous program to run, and the approvers are told once.
      expect(lost.release.state).toBe('deploying');
      expect(releaseAlerts(release.id)).toHaveLength(1);
      expect(h.repos.releaseDeployments.active()).not.toBeNull();
      await expect(change(release, attemptId, { kind: 'quiesce' })).rejects.toMatchObject({
        code: 'release_recovery_required',
      });
      // No report of the coordinator settles it, whatever the targets run: a person has to.
      runs(release.commit);
      const live: ReleaseDeploymentChange = {
        kind: 'report',
        report: { outcome: 'live' },
        image: artifact(release.commit),
      };
      await expect(change(release, attemptId, live)).rejects.toMatchObject({
        code: 'release_recovery_required',
      });
      runs(PREVIOUS);
      const rolledBack: ReleaseDeploymentChange = {
        kind: 'report',
        report: {
          outcome: 'failed',
          failure: { step: 'rollback', message: 'rolled back by hand', rolledBack: true },
        },
        image: image(PREVIOUS),
      };
      await expect(change(release, attemptId, rolledBack)).rejects.toMatchObject({
        code: 'release_recovery_required',
      });
      await expect(
        change(release, attemptId, { kind: 'resume', pauseId: lost.deployment!.pauseId! }),
      ).rejects.toMatchObject({ code: 'release_recovery_required' });
      expect(h.repos.releaseDeployments.get(release.id)).toMatchObject({
        phase: 'recovery_required',
        maintenance: true,
      });
      expect(h.domain.releases.get(release.id).state).toBe('deploying');
    });

    it('records a recovery the coordinator asks for, from the pause on: fence up, release kept, alert once', async () => {
      await setup();
      const { release, attemptId } = await switching();
      const view = await change(release, attemptId, {
        kind: 'recovery',
        code: 'cloud_transport_failed',
        message: 'the cloud did not answer',
      });
      expect(view.deployment).toMatchObject({
        phase: 'recovery_required',
        maintenance: true,
        recovery: { code: 'cloud_transport_failed' },
      });
      expect(view.release.state).toBe('deploying');
      expect(h.repos.releaseDeployments.active()).not.toBeNull();
      expect(releaseAlerts(release.id)).toHaveLength(1);
      // Asked again: the fence stays, the first cause stays, nobody is told twice.
      const again = await change(release, attemptId, {
        kind: 'recovery',
        code: 'engine_switch_failed',
        message: 'the engine did not start',
      });
      expect(again.deployment).toMatchObject({
        phase: 'recovery_required',
        maintenance: true,
        recovery: { code: 'cloud_transport_failed' },
      });
      expect(releaseAlerts(release.id)).toHaveLength(1);
    });

    it('records a recovery from quiescing, before anything is switched', async () => {
      await setup();
      const first = await begun();
      await change(first.release, first.attemptId, {
        kind: 'prepared',
        artifact: artifact(first.release.commit),
      });
      await change(first.release, first.attemptId, { kind: 'quiesce' });
      const quiescing = await change(first.release, first.attemptId, {
        kind: 'recovery',
        code: 'engine_switch_failed',
        message: 'x',
      });
      expect(quiescing.deployment).toMatchObject({ phase: 'recovery_required', maintenance: true });
      expect(quiescing.release.state).toBe('deploying');
    });

    it('keeps a live release live when its fenced deployment needs recovery', async () => {
      await setup();
      const { release, attemptId } = await switching();
      runs(release.commit);
      await change(release, attemptId, {
        kind: 'report',
        report: { outcome: 'live' },
        image: artifact(release.commit),
      });
      const view = await change(release, attemptId, {
        kind: 'recovery',
        code: 'database_incompatible',
        message: 'the schema is newer',
      });
      expect(view.deployment).toMatchObject({ phase: 'recovery_required', maintenance: true });
      expect(view.release.state).toBe('live');
      expect(releaseAlerts(release.id)).toHaveLength(1);
    });

    it('does not take a recovery before the pause: the attempt fails instead', async () => {
      await setup();
      const { release, attemptId } = await begun();
      const recovery = {
        kind: 'recovery',
        code: 'cloud_transport_failed',
        message: 'the cloud did not answer',
      } as const;
      await expect(change(release, attemptId, recovery)).rejects.toMatchObject({
        code: 'release_deployment_conflict',
        details: { phase: 'preparing' },
      });
      expect(releaseAlerts(release.id)).toHaveLength(0);
    });

    it('ends a failure before the switch without a fence', async () => {
      await setup();
      const { release, attemptId } = await begun();
      const view = await change(release, attemptId, {
        kind: 'report',
        report: { outcome: 'failed', failure: { step: 'build', message: 'no image', rolledBack: true } },
        image: image(PREVIOUS),
      });
      expect(view.deployment).toMatchObject({ phase: 'failed', maintenance: false });
      expect(view.release.state).toBe('failed');
      expect(h.repos.releaseDeployments.active()).toBeNull();
    });

    it.each([false, true])(
      'ends an unconfirmed failure before the pause (prepared: %s): nothing was touched, no recovery',
      async (prepared) => {
        await setup();
        const { release, attemptId } = await begun();
        if (prepared)
          await change(release, attemptId, { kind: 'prepared', artifact: artifact(release.commit) });
        const view = await change(release, attemptId, {
          kind: 'report',
          report: { outcome: 'failed', failure: { step: 'build', message: 'no image', rolledBack: false } },
        });
        expect(view.deployment).toMatchObject({
          phase: 'failed',
          maintenance: false,
          pauseId: null,
          recovery: null,
        });
        expect(view.release.state).toBe('failed');
        expect(h.repos.releaseDeployments.active()).toBeNull();
        expect(releaseAlerts(release.id)).toHaveLength(1);
      },
    );

    it('writes the release and the deployment together: a release that cannot change leaves the deployment as it was', async () => {
      await setup();
      const { release, attemptId } = await switching();
      runs(release.commit);
      const before = h.repos.releaseDeployments.get(release.id)!;
      const requestId = randomUUID();
      vi.spyOn(h.domain.releases, 'reporter').mockResolvedValue({
        report: () => {
          throw new Error('the release could not be written');
        },
        alert: () => undefined,
      });
      await expect(
        change(
          release,
          attemptId,
          { kind: 'report', report: { outcome: 'live' }, image: artifact(release.commit) },
          { requestId },
        ),
      ).rejects.toThrow('the release could not be written');
      expect(h.repos.releaseDeployments.get(release.id)).toEqual(before);
      expect(h.repos.releaseDeployments.request(requestId)).toBeNull();
      expect(h.domain.releases.get(release.id).state).toBe('deploying');
    });

    it('rejects a change the phase does not allow', async () => {
      await setup();
      const { release, attemptId } = await begun();
      await expect(change(release, attemptId, { kind: 'switch' })).rejects.toMatchObject({
        code: 'release_deployment_conflict',
        details: { phase: 'preparing' },
      });
    });
  });

  describe('on the control socket', () => {
    const servers: net.Server[] = [];
    afterEach(async () => {
      for (const server of servers.splice(0))
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function open() {
      const release: ControlRelease = {
        deploy: h.domain.releaseDeployments,
        appVersion: () => h.domain.releases.appVersion(),
        next: () => h.domain.releases.next(),
        get: (id) => h.domain.releases.getForControl(id),
        claim: (id, previous) => h.domain.releases.claim(id, previous),
        report: (id, report) => h.domain.releases.report(id, report),
      };
      const server = net.createServer((connection) =>
        serveControlConnection(connection, new ScriptedPause(), recordingLog(), release),
      );
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port };
    }

    it('begins, reads and changes a deployment, and refuses the legacy claim and report', async () => {
      await setup();
      const target = await open();
      const release = await approved();
      const input = beginInput(release.id);
      const begin = await sendControlRequest(target, { op: 'release_deploy_begin', ...input });
      expect(begin).toMatchObject({
        ok: true,
        appVersion: PREVIOUS,
        release: { state: 'deploying' },
        deployment: { phase: 'preparing', revision: 0 },
        drain: { ready: true },
        databaseSchemaVersion: expect.any(Number),
      });
      const read = await sendControlRequest(target, { op: 'release_deploy_get', releaseId: release.id });
      expect(read).toMatchObject({ ok: true, deployment: { attemptId: input.attemptId } });
      const prepared = await sendControlRequest(target, {
        op: 'release_deploy_change',
        releaseId: release.id,
        attemptId: input.attemptId,
        requestId: randomUUID(),
        expectedRevision: 0,
        change: { kind: 'prepared', artifact: artifact(release.commit) },
      });
      expect(prepared).toMatchObject({ ok: true, deployment: { phase: 'prepared', revision: 1 } });
      expect(
        await sendControlRequest(target, {
          op: 'release_claim',
          releaseId: release.id,
          previousCommit: null,
        }),
      ).toMatchObject({ ok: false, error: { code: 'release_protocol_unavailable' } });
      expect(
        await sendControlRequest(target, {
          op: 'release_report',
          releaseId: release.id,
          report: { outcome: 'live' },
        }),
      ).toMatchObject({ ok: false, error: { code: 'release_protocol_unavailable' } });
      expect(
        await sendControlRequest(target, { op: 'release_deploy_get', releaseId: 'rel_missing' }),
      ).toMatchObject({
        ok: false,
      });
    });

    it('rejects a request with a field the protocol does not know', async () => {
      await setup();
      const target = await open();
      const response = await sendControlRequest(target, {
        op: 'release_deploy_get',
        releaseId: 'rel_x',
        extra: true,
      } as never);
      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    });
  });

  describe('the stored document', () => {
    it('rejects a document that breaks the contract', async () => {
      await setup();
      const { release } = await begun();
      const stored = h.repos.releaseDeployments.get(release.id)!;
      expect(() =>
        h.repos.releaseDeployments.save({ ...stored, revision: -1 } as HybridDeployment, 0),
      ).toThrow();
    });

    it('lets the database keep one active deployment and answers the fence from its own column', async () => {
      await setup();
      const { release } = await begun();
      const stored = h.repos.releaseDeployments.get(release.id)!;
      expect(h.repos.releaseDeployments.active()?.releaseId).toBe(release.id);
      expect(h.repos.releaseDeployments.maintenanceHeld()).toBe(false);
      // A second active attempt, even of another release, cannot be stored.
      expect(() =>
        h.repos.releaseDeployments.insert({
          ...stored,
          releaseId: 'rel_other',
          attemptId: '00000000-0000-4000-8000-0000000000aa',
        }),
      ).toThrow();
      // A finished attempt gives the slot back.
      expect(
        h.repos.releaseDeployments.save(
          { ...stored, revision: stored.revision + 1, phase: 'failed' },
          stored.revision,
        ),
      ).toBe(true);
      expect(h.repos.releaseDeployments.active()).toBeNull();
    });

    it('writes a revision only on top of the one it read', async () => {
      await setup();
      const { release } = await begun();
      const stored = h.repos.releaseDeployments.get(release.id)!;
      const next = { ...stored, revision: stored.revision + 1, updatedAt: new Date().toISOString() };
      expect(h.repos.releaseDeployments.save(next, stored.revision)).toBe(true);
      // The same write again lost the race: the stored revision moved on.
      expect(h.repos.releaseDeployments.save(next, stored.revision)).toBe(false);
      expect(h.repos.releaseDeployments.get(release.id)?.revision).toBe(next.revision);
    });
  });
});
