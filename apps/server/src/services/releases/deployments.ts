import { HybridDeployment } from '@projectman/shared';
import type {
  HybridReleaseTarget,
  Release,
  ReleaseDeployBegin,
  ReleaseDeployChange,
  ReleaseDeploymentChange,
  ReleaseDrainPending,
  ReleaseDrainStatus,
  ReleaseEngineStatus,
  ReleaseImageRef,
} from '@projectman/shared';
import type { ReleaseWorkAdmission } from '../../contracts';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { schemaVersion } from '../../db';
import { conflict, KeyedMutex, notFound } from '../../kernel';
import {
  expectedTargets,
  nextPhase,
  payloadHash,
  phaseConflict,
  sameArtifact,
  sameImage,
  settledTargets,
} from './deployment-rules';
import type { ExpectedTargets } from './deployment-rules';
import type { ReleaseService } from './releases';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** The part of the pause service the deployments use: the fence's pause is owned by the deployment. */
export interface DeploymentPause {
  acquireOwnedInstancePause(reason: string, atomic: (pauseId: string) => void): Promise<string>;
  resumeOwnedInstancePause(pauseId: string, atomic: () => void): Promise<void>;
  unstoppedSessions(): number;
}

export interface ReleaseDeploymentsDeps {
  ctx: DomainContext;
  releases: ReleaseService;
  pause: DeploymentPause;
  work: ReleaseWorkAdmission;
  /** Null: this instance does not release in the hybrid way. */
  binding: HybridReleaseTarget | null;
  /** The cloud registry's view of the engines; the engine's version and presence are the server's own observation. */
  engines: () => ReleaseEngineStatus[];
  /** The fence is down: what waited for it may start (the queues pump themselves). */
  onResumed: () => void;
}

/** What the control socket answers with: the deployment, the release, the drain state and the database's schema. */
export interface DeploymentView {
  deployment: HybridDeployment | null;
  release: Release;
  drain: ReleaseDrainStatus;
  databaseSchemaVersion: number;
}

/**
 * The durable deployment of a hybrid release (PM-752). Exclusive (one active deployment on the instance),
 * restart-surviving (the document, the maintenance bit and the owned pause are stored together),
 * compare-and-swap on the revision and idempotent per request id. The cloud decides each transition from
 * its own facts: the version it runs, the version the engine reported, the drain state. A caller's report of
 * a state is accepted only when both targets show it.
 */
export class ReleaseDeployments {
  private readonly deps: ReleaseDeploymentsDeps;
  private readonly lock = new KeyedMutex();

  constructor(deps: ReleaseDeploymentsDeps) {
    this.deps = deps;
  }

  /** A hybrid instance refuses the single-target `release_claim`/`release_report`: they would skip the fence. */
  refuseLegacy(): void {
    if (this.deps.binding)
      throw conflict(
        'release_protocol_unavailable',
        'this instance releases through the hybrid deployment protocol',
      );
  }

  get(releaseId: string): DeploymentView {
    this.binding();
    return this.view(releaseId);
  }

  async begin(input: ReleaseDeployBegin): Promise<DeploymentView> {
    const binding = this.binding();
    return this.lock.run('deployments', async () => {
      const hash = payloadHash(input);
      const replay = this.replay(input.requestId, hash, input.releaseId, input.attemptId);
      if (replay) return replay;
      if (input.engineId !== binding.engineId)
        throw conflict('release_engine_mismatch', 'the engine is not the one this instance releases to');
      if (input.targetHash !== binding.targetHash)
        throw conflict('release_target_mismatch', 'the target is not the one this instance releases to');
      const { ctx, releases } = this.deps;
      const release = releases.getForControl(input.releaseId);
      const active = ctx.repos.releaseDeployments.active();
      if (active)
        throw conflict(
          'release_deployment_conflict',
          `the deployment of release ${active.releaseId} still holds the instance`,
          { releaseId: active.releaseId, phase: active.phase },
        );
      if (ctx.repos.releaseDeployments.get(release.id))
        throw conflict('release_deployment_conflict', `release ${release.id} has a deployment already`, {
          releaseId: release.id,
        });
      const running = releases.appVersion();
      if (!COMMIT_SHA.test(running) || input.previousImage.commit !== running)
        throw conflict(
          'release_target_mismatch',
          `the server runs ${running}, not the previous image ${input.previousImage.commit}`,
          { appVersion: running, commit: input.previousImage.commit },
        );
      const engine = this.engine();
      if (!engine?.online) throw conflict('engine_offline', 'the engine of the release is not connected');
      const engineCommit = engine.version ?? '';
      if (!COMMIT_SHA.test(engineCommit))
        throw conflict('release_engine_mismatch', 'the engine did not report a commit it runs', {
          version: engine.version,
        });
      const at = isoNow(ctx);
      const deployment = HybridDeployment.parse({
        version: 1,
        releaseId: release.id,
        attemptId: input.attemptId,
        controllerId: input.controllerId,
        targetHash: input.targetHash,
        engineId: input.engineId,
        revision: 0,
        phase: 'preparing',
        previousImage: input.previousImage,
        previousEngineCommit: engineCommit,
        previousSchemaVersion: schemaVersion(ctx.repos.db),
        artifact: null,
        pauseId: null,
        maintenance: false,
        recovery: null,
        startedAt: at,
        updatedAt: at,
      });
      ctx.unitOfWork(() => {
        releases.claim(release.id, input.previousImage.commit);
        ctx.repos.releaseDeployments.insert(deployment);
        ctx.repos.releaseDeployments.recordRequest(
          {
            requestId: input.requestId,
            releaseId: release.id,
            attemptId: input.attemptId,
            payloadHash: hash,
            resultingRevision: 0,
          },
          at,
        );
      });
      return this.view(release.id);
    });
  }

  async change(input: ReleaseDeployChange): Promise<DeploymentView> {
    this.binding();
    return this.lock.run('deployments', async () => {
      const hash = payloadHash(input);
      const replay = this.replay(input.requestId, hash, input.releaseId, input.attemptId);
      if (replay) return replay;
      const { ctx, releases } = this.deps;
      const release = releases.getForControl(input.releaseId);
      const current = ctx.repos.releaseDeployments.get(release.id);
      if (!current) throw notFound('release deployment', release.id);
      if (current.attemptId !== input.attemptId)
        throw conflict('release_deployment_conflict', 'the deployment belongs to another attempt', {
          releaseId: release.id,
        });
      if (current.revision !== input.expectedRevision)
        throw conflict('release_deployment_conflict', 'the deployment changed since it was read', {
          releaseId: release.id,
          revision: current.revision,
        });
      const request = { requestId: input.requestId, payloadHash: hash };
      await this.apply(current, release, input.change, request);
      return this.view(release.id);
    });
  }

  /** The state of the instance's work, for the switch to decide on. */
  drain(): ReleaseDrainStatus {
    const { ctx, work, pause } = this.deps;
    const permits = work.counts();
    const running = {
      merges: ctx.repos.taskMerges.list('running').length,
      documentWrites: ctx.repos.docWrites.list('running').length,
      fullTests: ctx.repos.fullTestRuns.list('running').length,
    };
    // A running row without a permit is work an earlier process started: it may be alive, so it is uncertain.
    const pick = (permit: number, row: number) => (permit > 0 ? permit : row);
    const pending: ReleaseDrainPending = {
      sessions: pause.unstoppedSessions(),
      merges: pick(permits.merges, running.merges),
      documentWrites: pick(permits.documentWrites, running.documentWrites),
      fullTests: pick(permits.fullTests, running.fullTests),
      screenshots: permits.screenshots,
    };
    const uncertain =
      (running.merges > 0 && permits.merges === 0) ||
      (running.documentWrites > 0 && permits.documentWrites === 0) ||
      (running.fullTests > 0 && permits.fullTests === 0);
    const engineOnline = this.engine()?.online === true;
    const idle = Object.values(pending).every((count) => count === 0);
    return {
      observedAt: isoNow(ctx),
      ready: idle && !uncertain && engineOnline,
      uncertain,
      engineOnline,
      pending,
    };
  }

  private async apply(
    current: HybridDeployment,
    release: Release,
    change: ReleaseDeploymentChange,
    request: { requestId: string; payloadHash: string },
  ): Promise<void> {
    const { releases, pause } = this.deps;
    if (change.kind === 'prepared' && current.artifact) {
      if (!sameArtifact(current.artifact, change.artifact))
        throw conflict('release_artifact_changed', 'the artifact differs from the one the attempt prepared');
      return;
    }
    const phase = nextPhase(current, change, release);
    if (!phase) {
      if (current.phase === 'recovery_required')
        throw conflict('release_recovery_required', 'the deployment needs recovery first', {
          releaseId: current.releaseId,
          code: current.recovery?.code ?? null,
        });
      throw phaseConflict(current, change.kind);
    }
    switch (change.kind) {
      case 'prepared': {
        if (change.artifact.commit !== release.commit)
          throw conflict(
            'release_target_mismatch',
            `the artifact is built from ${change.artifact.commit}, not the release's commit ${release.commit}`,
            { commit: change.artifact.commit, releaseCommit: release.commit },
          );
        this.save(current, { phase, artifact: change.artifact }, request);
        return;
      }
      case 'quiesce': {
        await pause.acquireOwnedInstancePause(`release ${release.id}`, (pauseId) =>
          this.save(current, { phase, pauseId, maintenance: true }, request),
        );
        return;
      }
      case 'switch': {
        this.requireOwnPause(current);
        const drain = this.drain();
        if (!drain.ready)
          throw conflict('release_not_drained', 'work is still running or cannot be told to be finished', {
            releaseId: current.releaseId,
            ...drain,
          });
        this.save(current, { phase }, request);
        return;
      }
      case 'recovery': {
        this.save(current, { phase, recovery: { code: change.code, message: change.message } }, request);
        return;
      }
      case 'resume': {
        const pauseId = current.pauseId;
        if (!pauseId || pauseId !== change.pauseId)
          throw conflict('release_pause_conflict', 'the pause is not the one the deployment owns', {
            releaseId: current.releaseId,
          });
        this.requireFacts(settledTargets(current, release), this.imageOf(current, release));
        await pause.resumeOwnedInstancePause(pauseId, () =>
          this.save(current, { phase, maintenance: false }, request),
        );
        this.deps.onResumed();
        return;
      }
      case 'report': {
        const { report } = change;
        switch (report.outcome) {
          case 'live': {
            const artifact = current.artifact;
            if (!artifact) throw phaseConflict(current, 'report live without an artifact');
            if (!change.image || !sameImage(change.image, artifact))
              throw conflict('release_artifact_changed', 'the running image is not the prepared artifact');
            this.requireFacts(expectedTargets(current, release, 'new'), change.image);
            if (release.state === 'deploying') await releases.report(release.id, { outcome: 'live' });
            this.save(current, { phase, recovery: null }, request);
            return;
          }
          case 'failed': {
            if (report.failure.rolledBack) {
              if (!change.image || !sameImage(change.image, current.previousImage))
                throw conflict('release_artifact_changed', 'the running image is not the previous image');
              this.requireFacts(expectedTargets(current, release, 'previous'), change.image);
            }
            if (release.state === 'deploying') await releases.report(release.id, report);
            this.save(
              current,
              {
                phase,
                recovery: report.failure.rolledBack
                  ? null
                  : { code: 'rollback_failed', message: report.failure.message },
              },
              request,
            );
            return;
          }
          case 'published': {
            this.requireFacts(expectedTargets(current, release, 'new'), null);
            if (release.state === 'live') await releases.report(release.id, report);
            this.save(current, { phase }, request);
            return;
          }
          case 'publish_failed': {
            if (release.state === 'live') await releases.report(release.id, report);
            this.save(current, { phase }, request);
            return;
          }
        }
      }
    }
  }

  /** Both targets must show the expected program: the cloud server and the engine are separate facts. */
  private requireFacts(expected: ExpectedTargets, image: ReleaseImageRef | null): void {
    const running = this.deps.releases.appVersion();
    if (running !== expected.cloudCommit)
      throw conflict(
        'release_target_mismatch',
        `the server runs ${running}, not the expected ${expected.cloudCommit}`,
        { appVersion: running, expected: expected.cloudCommit },
      );
    if (image && image.commit !== expected.cloudCommit)
      throw conflict('release_target_mismatch', 'the image is not of the expected commit', {
        commit: image.commit,
        expected: expected.cloudCommit,
      });
    const engine = this.engine();
    if (!engine?.online) throw conflict('engine_offline', 'the engine of the release is not connected');
    if (engine.version !== expected.engineCommit)
      throw conflict(
        'release_engine_mismatch',
        `the engine runs ${engine.version ?? 'an unknown version'}, not the expected ${expected.engineCommit}`,
        { version: engine.version, expected: expected.engineCommit },
      );
  }

  /** The image the settled phase stands for. */
  private imageOf(current: HybridDeployment, release: Pick<Release, 'commit'>): ReleaseImageRef | null {
    if (current.phase === 'failed') return current.previousImage;
    return current.artifact && current.artifact.commit === release.commit ? current.artifact : null;
  }

  /** The switch needs the fence's pause to be open still: someone may have ended it by hand. */
  private requireOwnPause(current: HybridDeployment): void {
    const pause = current.pauseId ? this.deps.ctx.repos.pauses.get(current.pauseId) : null;
    if (!current.maintenance || !pause || pause.resumedAt !== null)
      throw conflict('release_pause_conflict', 'the pause of the deployment is not open', {
        releaseId: current.releaseId,
      });
  }

  /** Writes the next revision and the request that made it, in the caller's transaction. */
  private save(
    current: HybridDeployment,
    patch: Partial<HybridDeployment>,
    request: { requestId: string; payloadHash: string },
  ): void {
    const { ctx } = this.deps;
    const at = isoNow(ctx);
    const next = HybridDeployment.parse({
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: at,
    });
    ctx.unitOfWork(() => {
      if (!ctx.repos.releaseDeployments.save(next, current.revision))
        throw conflict('release_deployment_conflict', 'the deployment changed since it was read', {
          releaseId: current.releaseId,
          revision: current.revision,
        });
      ctx.repos.releaseDeployments.recordRequest(
        {
          requestId: request.requestId,
          releaseId: current.releaseId,
          attemptId: current.attemptId,
          payloadHash: request.payloadHash,
          resultingRevision: next.revision,
        },
        at,
      );
    });
  }

  /** The answer to a request the deployment took already; a different payload under the same id is a conflict. */
  private replay(
    requestId: string,
    hash: string,
    releaseId: string,
    attemptId: string,
  ): DeploymentView | null {
    const taken = this.deps.ctx.repos.releaseDeployments.request(requestId);
    if (!taken) return null;
    if (taken.payloadHash !== hash || taken.releaseId !== releaseId || taken.attemptId !== attemptId)
      throw conflict('release_deployment_conflict', 'the request id was used for another request', {
        releaseId,
      });
    return this.view(releaseId);
  }

  private view(releaseId: string): DeploymentView {
    const { ctx, releases } = this.deps;
    return {
      deployment: ctx.repos.releaseDeployments.get(releaseId),
      release: releases.getForControl(releaseId),
      drain: this.drain(),
      databaseSchemaVersion: schemaVersion(ctx.repos.db),
    };
  }

  private binding(): HybridReleaseTarget {
    const { binding } = this.deps;
    if (!binding)
      throw conflict('release_not_configured', 'this instance does not release in the hybrid way');
    return binding;
  }

  private engine(): ReleaseEngineStatus | undefined {
    const { binding, engines } = this.deps;
    return binding ? engines().find((engine) => engine.id === binding.engineId) : undefined;
  }
}
