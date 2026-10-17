import path from 'node:path';
import { HYBRID_RECOVERY_CODES } from '@projectman/shared';
import type {
  HybridRecoveryCode,
  Release,
  ReleaseDeploymentChange,
  ReleaseImageRef,
} from '@projectman/shared';
import { CloudError, refused } from '../cloud/errors';
import type { HybridReleaseJournal, JournalFailureCode, LocalPhase } from './journal';
import { FAILURES, PUBLISH_FAILED_MESSAGE } from './messages';
import { ControlError, LIMITS, RoundStopped } from './ports';
import type { CoordinatorPorts, DeployView, EngineState, HeldHeavyLock, RoundResult } from './ports';
import type { VerifiedPrepared } from './verify';

/**
 * The hybrid release coordinator (PM-751): one approved release goes to the cloud server and to the engine on this
 * Mac with no manual command chain, and ends either live on both, or back on the previous program (verified), or
 * in a recovery a person has to settle. It is a state machine over `CoordinatorPorts`; the journal is written
 * before every side effect, and every phase can be entered again after a stop, so a crash at any point is carried
 * on by the next round instead of repeated or forgotten.
 *
 * What it never does: delete or overwrite a journal, restore data, kill a process, write a secret or a
 * configuration on the machine, or decide that an unknown state is fine. What it cannot prove goes to recovery.
 */

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Phases that run after the new program may have been started on a target. */
const ROLLBACK_PHASES: readonly LocalPhase[] = [
  'rollback_engine',
  'rollback_cloud',
  'report_failed',
  'recovery_required',
];

/** What a plan shows: read-only, no claim, no state. */
export interface PlanReport {
  state: 'idle' | 'resume' | 'ready' | 'blocked';
  releaseId: string | null;
  commit: string | null;
  phase: LocalPhase | null;
  /** Fixed codes only. */
  problems: string[];
}

interface BaselineFacts {
  appVersion: string;
  image: ReleaseImageRef;
  engineRoot: string;
  enginePid: number;
  engineBootId: string;
  plistSha256: string;
  schemaVersion: number;
}

type Baseline = { ok: true; facts: BaselineFacts } | { ok: false; problems: string[] };

/** A phase asks the machine to go another way: the loop turns it into the next journal phase. */
class Divert extends Error {
  readonly kind: 'fail_before' | 'rollback' | 'recovery';
  readonly code: JournalFailureCode;

  constructor(kind: Divert['kind'], code: JournalFailureCode) {
    super(`divert:${kind}:${code}`);
    this.name = 'Divert';
    this.kind = kind;
    this.code = code;
  }
}

type EngineKind = 'old_running' | 'old_stopped' | 'new_running' | 'new_stopped' | 'unknown';

function sameImage(a: ReleaseImageRef | null, b: ReleaseImageRef): boolean {
  return a !== null && a.commit === b.commit && a.imageId === b.imageId && a.platform === b.platform;
}

const imageRef = (image: ReleaseImageRef): ReleaseImageRef => ({
  commit: image.commit,
  imageId: image.imageId,
  platform: image.platform,
});

const recoveryCodeOf = (error: ControlError): HybridRecoveryCode =>
  (HYBRID_RECOVERY_CODES as readonly string[]).includes(error.code)
    ? (error.code as HybridRecoveryCode)
    : 'release_deployment_conflict';

export class HybridCoordinator {
  private readonly p: CoordinatorPorts;
  private j!: HybridReleaseJournal;
  private heavy: HeldHeavyLock | null = null;
  private heavyTried = false;
  private prepared: VerifiedPrepared | null = null;

  constructor(ports: CoordinatorPorts) {
    this.p = ports;
  }

  // ---- the two entry points ----------------------------------------------------------------------

  /** What a round would do now. Reads, never writes. */
  async plan(): Promise<PlanReport> {
    const read = this.p.journal.read();
    if (read.kind === 'ok') {
      const { journal } = read;
      return {
        state: journal.phase === 'recovery_required' ? 'blocked' : 'resume',
        releaseId: journal.releaseId,
        commit: journal.commit,
        phase: journal.phase,
        problems: journal.phase === 'recovery_required' ? [journal.failure?.code ?? 'recovery_required'] : [],
      };
    }
    await this.p.machine.verifyTarget();
    const release = await this.guarded(() => this.p.control.releaseNext());
    if (!release) return { state: 'idle', releaseId: null, commit: null, phase: null, problems: [] };
    const base = { releaseId: release.id, commit: release.commit, phase: null };
    if (release.state !== 'approved')
      return { ...base, state: 'blocked', problems: ['release_not_startable'] };
    const baseline = await this.baseline();
    return baseline.ok
      ? { ...base, state: 'ready', problems: [] }
      : { ...base, state: 'blocked', problems: baseline.problems };
  }

  /** One round: carries an unfinished attempt on, or starts the next approved release. */
  async round(): Promise<RoundResult> {
    try {
      return await this.run();
    } finally {
      await this.dropHeavy();
    }
  }

  private async run(): Promise<RoundResult> {
    const read = this.p.journal.read();
    if (read.kind === 'ok' && read.journal.phase === 'complete') this.p.journal.archive(read.journal);
    else if (read.kind === 'ok') {
      this.j = read.journal;
      this.checkIdentity();
      await this.p.machine.verifyTarget();
      return this.drive();
    }
    await this.p.machine.verifyTarget();
    const release = await this.guarded(() => this.p.control.releaseNext());
    if (!release) return { status: 'idle' };
    // A release the cloud holds as deploying or live without a journal here is not ours to continue: the journal
    // that knew its rollback point is gone, and nothing is guessed in its place.
    if (release.state !== 'approved')
      throw refused(`release ${release.id} is ${release.state} but this watcher has no journal for it`);
    if (!COMMIT_SHA.test(release.commit)) throw refused(`release ${release.id} has no valid commit`);
    await this.start(release);
    return this.drive();
  }

  // ---- starting an attempt ----------------------------------------------------------------------

  /** Every fact the previous program must show before anything is touched. */
  private async baseline(): Promise<Baseline> {
    const { control, machine, engine, config } = this.p;
    const problems: string[] = [];
    let appVersion: string | null = null;
    try {
      const answer = await control.engines();
      appVersion = answer.appVersion;
      if (!appVersion || !COMMIT_SHA.test(appVersion)) problems.push('cloud_version_unknown');
      const entry = answer.engines.find((candidate) => candidate.id === config.engineId);
      if (!entry?.online || entry.version !== appVersion) problems.push('engine_registry_mismatch');
    } catch {
      problems.push('cloud_control_unavailable');
    }
    let image: ReleaseImageRef | null = null;
    let schemaVersion = 0;
    try {
      image = await machine.current();
      if (!image || image.commit !== appVersion) {
        problems.push('cloud_image_unknown');
        image = null;
      } else {
        const probe = await machine.probe(image);
        if (!sameImage(probe.current, image) || !probe.healthy || !probe.imagePresent || !probe.imageVerified)
          problems.push('cloud_image_not_ready');
        if (probe.lockHeld) problems.push('cloud_image_busy');
        if (probe.schemaVersion === null) problems.push('cloud_schema_unknown');
        else schemaVersion = probe.schemaVersion;
      }
    } catch {
      problems.push('cloud_machine_unavailable');
    }
    let state: EngineState | null = null;
    try {
      state = await engine.state();
      const ready =
        state.loaded &&
        state.root !== null &&
        state.pid !== null &&
        state.pidAlive &&
        state.plistSha256 !== null &&
        state.status !== null &&
        state.status.connected &&
        state.status.pid === state.pid;
      if (!ready) problems.push('engine_not_ready');
      else if ((await engine.rootCommit(state.root as string)) !== appVersion)
        problems.push('engine_commit_mismatch');
    } catch {
      problems.push('engine_state_unreadable');
    }
    if (this.p.oldLiveJournal()) problems.push('old_watcher_journal_present');
    if (
      problems.length > 0 ||
      !appVersion ||
      !image ||
      !state ||
      state.root === null ||
      state.pid === null ||
      state.plistSha256 === null ||
      state.status === null
    )
      return { ok: false, problems: problems.length > 0 ? problems : ['baseline_incomplete'] };
    return {
      ok: true,
      facts: {
        appVersion,
        image: imageRef(image),
        engineRoot: state.root,
        enginePid: state.pid,
        engineBootId: state.status.bootId,
        plistSha256: state.plistSha256,
        schemaVersion,
      },
    };
  }

  private async start(release: Release): Promise<void> {
    const baseline = await this.baseline();
    if (!baseline.ok) throw refused(`the release cannot start: ${baseline.problems.join(', ')}`);
    const { facts } = baseline;
    const existing = await this.guarded(() => this.p.control.deployGet(release.id));
    if (existing.deployment !== null) throw refused(`release ${release.id} has a deployment already`);
    const { config, clock } = this.p;
    const attemptId = this.p.uuid();
    const snapshot = await this.p.engine.snapshotPlist(attemptId);
    if (snapshot.sha256 !== facts.plistSha256)
      throw refused('the engine service definition changed while it was read');
    const at = clock.now().toISOString();
    const journal: HybridReleaseJournal = {
      version: 1,
      releaseId: release.id,
      attemptId,
      controllerId: config.controllerId,
      targetHash: config.targetHash,
      commit: release.commit,
      revision: 0,
      phase: 'claim',
      configSha256: config.configSha256,
      outputDir: path.join(config.stateDir, 'artifacts', `${release.id}-${attemptId}`),
      receiptPath: null,
      receiptSha256: null,
      previous: {
        image: facts.image,
        engineRoot: facts.engineRoot,
        engineCommit: facts.appVersion,
        enginePid: facts.enginePid,
        engineBootId: facts.engineBootId,
        plistPath: snapshot.path,
        plistSha256: snapshot.sha256,
        schemaVersion: facts.schemaVersion,
      },
      pauseId: null,
      pendingRequest: {
        op: 'release_deploy_begin',
        releaseId: release.id,
        attemptId,
        controllerId: config.controllerId,
        requestId: this.p.uuid(),
        targetHash: config.targetHash,
        engineId: config.engineId,
        previousImage: facts.image,
      },
      publish: { tag: null, url: null, attemptedAt: null },
      failure: null,
      startedAt: at,
      updatedAt: at,
    };
    this.p.journal.create(journal);
    this.j = journal;
    this.p.log(`release ${release.id}: attempt ${attemptId} started`);
  }

  /** A journal of another controller, target or configuration is never carried on. */
  private checkIdentity(): void {
    const { config } = this.p;
    if (this.j.controllerId !== config.controllerId)
      throw refused('the journal belongs to another controller; it stays where it is');
    if (this.j.targetHash !== config.targetHash)
      throw refused('the journal belongs to another release target; it stays where it is');
    if (this.j.configSha256 !== config.configSha256)
      throw refused('the configuration changed during the attempt; the journal stays and a person decides');
  }

  // ---- the loop ---------------------------------------------------------------------------------

  private async drive(): Promise<RoundResult> {
    for (;;) {
      if (this.p.signal.aborted) throw new RoundStopped('aborted', 'the round was stopped');
      try {
        const result = await this.step();
        if (result) return result;
      } catch (error) {
        if (!(error instanceof Divert)) throw error;
        this.divert(error);
      }
    }
  }

  private async step(): Promise<RoundResult | null> {
    switch (this.j.phase) {
      case 'claim':
        return this.claim();
      case 'prepare':
        return this.prepare();
      case 'bind':
        return this.bind();
      case 'quiesce':
        return this.quiesce();
      case 'drain':
        return this.drain();
      case 'import':
        return this.importImage();
      case 'cloud_start':
        return this.cloudStart();
      case 'cloud_verify':
        return this.cloudVerify();
      case 'engine_stop':
        return this.engineStop();
      case 'engine_start':
        return this.engineStart();
      case 'engine_verify':
        return this.engineVerify();
      case 'report_live':
        return this.reportLive();
      case 'resume':
        return this.resume();
      case 'publish':
        return this.publish();
      case 'rollback_engine':
        return this.rollbackEngine();
      case 'rollback_cloud':
        return this.rollbackCloud();
      case 'report_failed':
        return this.reportFailed();
      case 'recovery_required':
        return this.recoveryRequired();
      case 'complete':
        return this.complete();
    }
  }

  /** Turns a phase's request to go another way into the journal's next phase. Never sends anything itself. */
  private divert(d: Divert): void {
    const failure = { code: d.code, message: FAILURES[d.code].message };
    if (d.kind === 'recovery') {
      this.save({ failure, phase: 'recovery_required', pendingRequest: null });
      return;
    }
    if (this.j.pauseId === null) {
      // Nothing was paused yet: the attempt just ends.
      this.save({ failure, phase: 'report_failed', pendingRequest: null });
      return;
    }
    if (ROLLBACK_PHASES.includes(this.j.phase) || this.j.phase === 'resume') {
      const code: JournalFailureCode = 'rollback_failed';
      this.save({
        failure: { code, message: FAILURES[code].message },
        phase: 'recovery_required',
        pendingRequest: null,
      });
      return;
    }
    this.save({ failure, phase: 'rollback_engine', pendingRequest: null });
  }

  // ---- journal and control helpers --------------------------------------------------------------

  private save(patch: Partial<HybridReleaseJournal>): void {
    this.j = { ...this.j, ...patch, updatedAt: this.p.clock.now().toISOString() };
    this.p.journal.write(this.j);
  }

  /** The cloud accepted a change: its revision is the journal's, and the request is no longer pending. */
  private accepted(view: DeployView, phase: LocalPhase, patch: Partial<HybridReleaseJournal> = {}): void {
    const deployment = view.deployment;
    if (!deployment || deployment.attemptId !== this.j.attemptId)
      throw new RoundStopped('control_answer_invalid', 'the cloud answered with another deployment');
    this.save({ ...patch, revision: deployment.revision, pendingRequest: null, phase });
  }

  /** A port call whose control errors become the round's stop: the request may or may not have been applied. */
  private async guarded<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ControlError)
        throw new RoundStopped(`control_${error.kind}`, 'the cloud control socket did not answer usefully');
      throw error;
    }
  }

  /** Sends the journal's pending request again with the same id and body, up to the fixed attempts. */
  private async sendPending(): Promise<DeployView> {
    const pending = this.j.pendingRequest;
    if (!pending) throw new RoundStopped('journal_inconsistent', 'there is no request to send');
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (pending.op === 'release_deploy_begin') {
          const { op, ...body } = pending;
          void op;
          return await this.p.control.begin(body);
        }
        const { op, ...body } = pending;
        void op;
        return await this.p.control.change(body);
      } catch (error) {
        if (!(error instanceof ControlError)) throw error;
        if (error.kind === 'refused') {
          // The board answered no: the request was not applied, and it is not carried on.
          this.save({ pendingRequest: null });
          throw error;
        }
        if (attempt >= LIMITS.sendAttempts)
          throw new RoundStopped(
            `control_${error.kind}`,
            'the answer of the cloud control socket is lost; the same request is sent again next round',
          );
        await this.sleep(LIMITS.sendRetryMs);
      }
    }
  }

  /** The change of the current phase: sent as the pending request, which a restart sends again unchanged. */
  private async deliver(change: ReleaseDeploymentChange): Promise<DeployView> {
    const pending = this.j.pendingRequest;
    if (pending === null) {
      this.save({
        pendingRequest: {
          op: 'release_deploy_change',
          releaseId: this.j.releaseId,
          attemptId: this.j.attemptId,
          requestId: this.p.uuid(),
          expectedRevision: this.j.revision,
          change,
        },
      });
    } else if (
      pending.op !== 'release_deploy_change' ||
      pending.change.kind !== change.kind ||
      (pending.change.kind === 'report' &&
        change.kind === 'report' &&
        pending.change.report.outcome !== change.report.outcome)
    )
      throw new RoundStopped('journal_inconsistent', 'the pending request is not the one this phase sends');
    return this.sendPending();
  }

  /** The deployment as the cloud holds it; it must still be this attempt's, with this attempt's pause. */
  private async ownView(): Promise<DeployView> {
    const view = await this.guarded(() => this.p.control.deployGet(this.j.releaseId));
    const deployment = view.deployment;
    if (
      !deployment ||
      deployment.attemptId !== this.j.attemptId ||
      deployment.controllerId !== this.j.controllerId
    )
      throw new Divert('recovery', 'release_deployment_conflict');
    if (this.j.pauseId !== null && deployment.pauseId !== this.j.pauseId)
      throw new Divert('recovery', 'release_pause_conflict');
    if (this.j.pendingRequest === null && deployment.revision !== this.j.revision)
      throw new Divert('recovery', 'release_deployment_conflict');
    return view;
  }

  private async sleep(ms: number): Promise<void> {
    try {
      await this.p.clock.sleep(ms, this.p.signal);
    } catch {
      throw new RoundStopped('aborted', 'the round was stopped');
    }
  }

  /** Polls `check` until it holds or `ms` passed; a check that throws counts as not yet. */
  private async waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
    const end = this.p.clock.now().getTime() + ms;
    for (;;) {
      let ok = false;
      try {
        ok = await check();
      } catch (error) {
        if (error instanceof RoundStopped) throw error;
      }
      if (ok) return true;
      if (this.p.clock.now().getTime() >= end) return false;
      await this.sleep(LIMITS.pollMs);
    }
  }

  private describe(error: unknown): string {
    if (error instanceof CloudError || error instanceof ControlError || error instanceof RoundStopped)
      return `${error.name}: ${error.message.slice(0, 300)}`;
    return error instanceof Error ? error.name : 'an unknown error';
  }

  // ---- the heavy-run queue ----------------------------------------------------------------------

  private async holdHeavy(waitMs: number): Promise<boolean> {
    if (this.heavy) return true;
    this.heavyTried = true;
    const lock = await this.p.heavy.acquire('hybrid release', Math.max(0, waitMs));
    if (!lock) return false;
    this.heavy = lock;
    return true;
  }

  /** In a phase after the drain: the queue is taken again if this round does not hold it, for a short while. */
  private async holdHeavyAgain(): Promise<void> {
    if (this.heavy || this.heavyTried) return;
    if (!(await this.holdHeavy(LIMITS.heavyReentryMs)))
      this.p.log('the heavy-run queue was not free; the round carries on without holding it');
  }

  private async dropHeavy(): Promise<void> {
    const held = this.heavy;
    this.heavy = null;
    if (held) await held.release().catch(() => undefined);
  }

  // ---- phases before the pause ------------------------------------------------------------------

  private async claim(): Promise<RoundResult | null> {
    let view: DeployView;
    try {
      view = await this.sendPending();
    } catch (error) {
      if (!(error instanceof ControlError) || error.kind !== 'refused') throw error;
      // The deployment never began: the journal is closed, nothing was changed anywhere.
      const code = recoveryCodeOf(error);
      this.save({ failure: { code, message: FAILURES[code].message }, phase: 'complete' });
      this.p.journal.archive(this.j);
      return { status: 'failed', releaseId: this.j.releaseId, code };
    }
    this.accepted(view, 'prepare');
    return null;
  }

  private async prepare(): Promise<RoundResult | null> {
    const { prepare } = this.p;
    const input = { releaseId: this.j.releaseId, commit: this.j.commit, outputDir: this.j.outputDir };
    let state = prepare.inspect(this.j.outputDir);
    // A directory without a receipt is a preparation that was interrupted: it is never reused.
    if (state === 'partial') throw new Divert('fail_before', 'prepare_failed');
    if (state === 'absent') {
      try {
        await prepare.prepare(input);
      } catch (error) {
        this.p.log(`preparation failed: ${this.describe(error)}`);
        throw new Divert('fail_before', 'prepare_failed');
      }
      state = prepare.inspect(this.j.outputDir);
      if (state !== 'receipt') throw new Divert('fail_before', 'prepare_failed');
    }
    let verified: VerifiedPrepared;
    try {
      verified = await prepare.verify({
        outputDir: this.j.outputDir,
        engineReleasesDir: this.p.config.engineReleasesDir,
        releaseId: this.j.releaseId,
        commit: this.j.commit,
        expectedReceiptSha256: this.j.receiptSha256,
      });
    } catch (error) {
      this.p.log(`preparation did not verify: ${this.describe(error)}`);
      throw new Divert('fail_before', 'prepare_failed');
    }
    this.prepared = verified;
    this.save({ receiptPath: verified.receiptPath, receiptSha256: verified.receiptSha256, phase: 'bind' });
    return null;
  }

  /** The preparation checked again; `fresh` hashes the archive and the candidate once more. */
  private async verified(code: JournalFailureCode, fresh: boolean): Promise<VerifiedPrepared> {
    if (this.prepared && !fresh) return this.prepared;
    try {
      this.prepared = await this.p.prepare.verify({
        outputDir: this.j.outputDir,
        engineReleasesDir: this.p.config.engineReleasesDir,
        releaseId: this.j.releaseId,
        commit: this.j.commit,
        expectedReceiptSha256: this.j.receiptSha256,
      });
      return this.prepared;
    } catch (error) {
      this.p.log(`preparation did not verify: ${this.describe(error)}`);
      throw new Divert('fail_before', code);
    }
  }

  private async bind(): Promise<RoundResult | null> {
    const verified = await this.verified('prepare_failed', true);
    let view: DeployView;
    try {
      view = await this.deliver({ kind: 'prepared', artifact: verified.artifact });
    } catch (error) {
      if (!(error instanceof ControlError) || error.kind !== 'refused') throw error;
      this.p.log(`the cloud refused the prepared artifact: ${error.code}`);
      throw new Divert('fail_before', 'prepare_failed');
    }
    this.accepted(view, 'quiesce');
    return null;
  }

  private async quiesce(): Promise<RoundResult | null> {
    let view: DeployView;
    try {
      view = await this.deliver({ kind: 'quiesce' });
    } catch (error) {
      if (!(error instanceof ControlError) || error.kind !== 'refused') throw error;
      this.p.log(`the cloud refused the pause: ${error.code}`);
      throw new Divert('fail_before', 'quiesce_refused');
    }
    const pauseId = view.deployment?.pauseId ?? null;
    if (pauseId === null) throw new RoundStopped('control_answer_invalid', 'the cloud named no pause');
    this.accepted(view, 'drain', { pauseId });
    return null;
  }

  // ---- the switch -------------------------------------------------------------------------------

  private async drain(): Promise<RoundResult | null> {
    const end = this.p.clock.now().getTime() + LIMITS.drainMs;
    const timedOut = () => this.p.clock.now().getTime() >= end;
    for (;;) {
      const view = await this.ownView();
      if (view.drain.ready) break;
      if (timedOut()) throw new Divert('rollback', 'drain_timeout');
      await this.sleep(LIMITS.pollMs);
    }
    if (!(await this.holdHeavy(end - this.p.clock.now().getTime())))
      throw new Divert('rollback', 'drain_timeout');
    for (;;) {
      try {
        const view = await this.deliver({ kind: 'switch' });
        this.accepted(view, 'import');
        return null;
      } catch (error) {
        if (!(error instanceof ControlError) || error.kind !== 'refused') throw error;
        // The work came back between the check and the switch: the drain is waited for again, within its budget.
        if (error.code === 'release_not_drained' && !timedOut()) {
          await this.sleep(LIMITS.pollMs);
          continue;
        }
        this.p.log(`the cloud refused the switch: ${error.code}`);
        throw new Divert(
          'rollback',
          error.code === 'release_not_drained' ? 'drain_timeout' : 'switch_refused',
        );
      }
    }
  }

  /** The image lock of the cloud machine is waited for; past the limit the state cannot be told. */
  private async waitUnlocked(image: ReleaseImageRef, code: JournalFailureCode) {
    let last = await this.p.machine.probe(image);
    const free = await this.waitFor(async () => {
      last = await this.p.machine.probe(image);
      return !last.lockHeld;
    }, LIMITS.imageLockMs);
    if (!free) throw new Divert('recovery', code);
    return last;
  }

  private async importImage(): Promise<RoundResult | null> {
    await this.holdHeavyAgain();
    const verified = await this.verified('cloud_import_failed', true);
    const ref = imageRef(verified.artifact);
    const first = await this.waitUnlocked(ref, 'cloud_transport_failed');
    if (!(first.imagePresent && first.imageVerified)) {
      try {
        await this.p.machine.importImage(verified.selected);
      } catch (error) {
        this.p.log(`the image import failed: ${this.describe(error)}`);
        // The machine may still be writing: its lock is waited for before the answer is taken.
        const probe = await this.waitUnlocked(ref, 'cloud_transport_failed');
        if (!(probe.imagePresent && probe.imageVerified)) throw new Divert('rollback', 'cloud_import_failed');
      }
    }
    this.save({ phase: 'cloud_start' });
    return null;
  }

  private async cloudStart(): Promise<RoundResult | null> {
    await this.holdHeavyAgain();
    const verified = await this.verified('cloud_start_failed', false);
    const ref = imageRef(verified.artifact);
    const previous = this.j.previous.image;
    let probe = await this.waitUnlocked(ref, 'cloud_transport_failed');
    if (!sameImage(probe.current, ref)) {
      if (!sameImage(probe.current, previous)) throw new Divert('recovery', 'cloud_transport_failed');
      try {
        await this.p.machine.start(ref);
      } catch (error) {
        this.p.log(`the image start failed: ${this.describe(error)}`);
        probe = await this.waitUnlocked(ref, 'cloud_transport_failed');
        if (!sameImage(probe.current, ref)) {
          // The previous program unchanged and healthy: a clean failure. Anything else cannot be proven.
          if (sameImage(probe.current, previous) && probe.healthy)
            throw new Divert('rollback', 'cloud_start_failed');
          throw new Divert('recovery', 'cloud_transport_failed');
        }
      }
    }
    this.save({ phase: 'cloud_verify' });
    return null;
  }

  private async cloudVerify(): Promise<RoundResult | null> {
    await this.holdHeavyAgain();
    const verified = await this.verified('cloud_verify_failed', false);
    const ref = imageRef(verified.artifact);
    if (!(await this.p.machine.waitHealthy(ref))) throw new Divert('rollback', 'cloud_verify_failed');
    // The program that answers must be the new commit: the container's health alone says nothing about which one.
    const running = await this.waitFor(
      async () => (await this.p.control.engines()).appVersion === this.j.commit,
      LIMITS.healthMs,
    );
    if (!running) throw new Divert('rollback', 'cloud_verify_failed');
    this.save({ phase: 'engine_stop' });
    return null;
  }

  // ---- the engine -------------------------------------------------------------------------------

  private candidateRoot(): string {
    return path.join(this.p.config.engineReleasesDir, `${this.j.releaseId}-${this.j.commit}`);
  }

  /** What the engine's job and process are, in the terms of this attempt; anything else is `unknown`. */
  private classify(state: EngineState): EngineKind {
    const running = state.loaded && state.pid !== null && state.pidAlive;
    if (state.root === this.j.previous.engineRoot) return running ? 'old_running' : 'old_stopped';
    if (state.root === this.candidateRoot()) return running ? 'new_running' : 'new_stopped';
    return 'unknown';
  }

  /**
   * The engine processes this attempt knows of, other than the one launchd runs now (the one recorded before the switch,
   * and the one that last wrote the status file), have exited. A job that is out of launchd says nothing about its
   * process, so a stopped job alone never proves it: another engine on the same home must not start next to it.
   */
  private async enginesGone(state: EngineState): Promise<boolean> {
    const pids = new Set<number>([this.j.previous.enginePid]);
    if (state.status) pids.add(state.status.pid);
    if (state.loaded && state.pid !== null) pids.delete(state.pid);
    return this.waitFor(async () => {
      for (const pid of pids) if (await this.p.engine.pidAlive(pid)) return false;
      return true;
    }, LIMITS.processExitMs);
  }

  private async engineStop(): Promise<RoundResult | null> {
    await this.holdHeavyAgain();
    const state = await this.p.engine.state();
    switch (this.classify(state)) {
      case 'old_running': {
        // Boots the job out and proves the process is gone: a process that is still alive is never killed.
        let stopped = false;
        try {
          stopped = await this.p.engine.stop(state.pid as number);
        } catch (error) {
          this.p.log(`the engine stop failed: ${this.describe(error)}`);
        }
        if (!stopped) throw new Divert('recovery', 'engine_switch_failed');
        break;
      }
      case 'old_stopped':
      case 'new_stopped':
      case 'new_running':
        // An interrupted stop: the job is gone, but its process must be proven gone too.
        if (!(await this.enginesGone(state))) throw new Divert('recovery', 'engine_switch_failed');
        break;
      case 'unknown':
        throw new Divert('recovery', 'engine_switch_failed');
    }
    this.save({ phase: 'engine_start' });
    return null;
  }

  private async engineStart(): Promise<RoundResult | null> {
    await this.holdHeavyAgain();
    const state = await this.p.engine.state();
    switch (this.classify(state)) {
      case 'new_running':
        break;
      case 'old_running':
        // Not stopped yet (a stop that was interrupted): back to the stop, which proves it.
        this.save({ phase: 'engine_stop' });
        return null;
      case 'unknown':
        throw new Divert('recovery', 'engine_switch_failed');
      case 'old_stopped':
      case 'new_stopped': {
        if (!(await this.enginesGone(state))) throw new Divert('recovery', 'engine_switch_failed');
        const verified = await this.verified('engine_start_failed', true);
        try {
          await this.p.engine.start(verified.engineRoot);
        } catch (error) {
          this.p.log(`the engine start failed: ${this.describe(error)}`);
          throw new Divert('rollback', 'engine_start_failed');
        }
      }
    }
    this.save({ phase: 'engine_verify' });
    return null;
  }

  private async engineVerify(): Promise<RoundResult | null> {
    await this.holdHeavyAgain();
    const ok = await this.waitFor(async () => {
      const state = await this.p.engine.state();
      if (this.classify(state) !== 'new_running') return false;
      const status = state.status;
      // The process that reports must be the one launchd runs, and not the one that ran before.
      if (
        !status ||
        !status.connected ||
        status.pid !== state.pid ||
        status.bootId === this.j.previous.engineBootId
      )
        return false;
      const registry = await this.p.control.engines();
      const entry = registry.engines.find((candidate) => candidate.id === this.p.config.engineId);
      return (
        registry.appVersion === this.j.commit && entry?.online === true && entry.version === this.j.commit
      );
    }, LIMITS.healthMs);
    if (!ok) throw new Divert('rollback', 'engine_verify_failed');
    this.save({ phase: 'report_live' });
    return null;
  }

  // ---- live -------------------------------------------------------------------------------------

  private async reportLive(): Promise<RoundResult | null> {
    const verified = await this.verified('live_refused', false);
    let view: DeployView;
    try {
      view = await this.deliver({
        kind: 'report',
        report: { outcome: 'live' },
        image: imageRef(verified.artifact),
      });
    } catch (error) {
      if (!(error instanceof ControlError) || error.kind !== 'refused') throw error;
      this.p.log(`the cloud did not accept the live report: ${error.code}`);
      throw new Divert('rollback', 'live_refused');
    }
    this.accepted(view, 'resume');
    return null;
  }

  private async resume(): Promise<RoundResult | null> {
    const pauseId = this.j.pauseId;
    if (pauseId === null) throw new RoundStopped('journal_inconsistent', 'there is no pause to end');
    let view: DeployView;
    try {
      view = await this.deliver({ kind: 'resume', pauseId });
    } catch (error) {
      if (!(error instanceof ControlError) || error.kind !== 'refused') throw error;
      this.p.log(`the cloud refused to end the pause: ${error.code}`);
      throw new Divert('recovery', recoveryCodeOf(error));
    }
    await this.dropHeavy();
    if (this.j.failure !== null) {
      this.accepted(view, 'complete');
      return this.complete();
    }
    this.accepted(view, 'publish');
    return null;
  }

  private async publish(): Promise<RoundResult | null> {
    await this.dropHeavy();
    const pending = this.j.pendingRequest;
    if (pending !== null) {
      const outcome =
        pending.op === 'release_deploy_change' && pending.change.kind === 'report'
          ? pending.change.report.outcome
          : null;
      if (outcome !== 'published' && outcome !== 'publish_failed')
        throw new RoundStopped('journal_inconsistent', 'the pending request is not a publish report');
      const view = await this.sendPendingOrStop();
      this.accepted(view, outcome === 'published' ? 'complete' : 'publish');
      return outcome === 'published' ? this.complete() : this.livePending();
    }
    const { tag, url, attemptedAt } = this.j.publish;
    if (tag === null || url === null) {
      if (
        attemptedAt !== null &&
        this.p.clock.now().getTime() - Date.parse(attemptedAt) < LIMITS.publishRetryMs
      )
        return this.livePending();
      const view = await this.guarded(() => this.p.control.deployGet(this.j.releaseId));
      let made: { tag: string; url: string };
      try {
        made = await this.p.publisher.publish({ release: view.release, commit: this.j.commit });
      } catch (error) {
        this.p.log(`publishing failed: ${this.describe(error)}`);
        const first = attemptedAt === null;
        this.save({ publish: { tag: null, url: null, attemptedAt: this.p.clock.now().toISOString() } });
        if (first) {
          const reported = await this.deliver({
            kind: 'report',
            report: { outcome: 'publish_failed', message: PUBLISH_FAILED_MESSAGE },
          }).catch((reason: unknown) => {
            if (reason instanceof ControlError && reason.kind === 'refused') return null;
            throw reason;
          });
          if (reported) this.accepted(reported, 'publish');
        }
        return this.livePending();
      }
      this.save({ publish: { tag: made.tag, url: made.url, attemptedAt: this.p.clock.now().toISOString() } });
    }
    const { tag: madeTag, url: madeUrl } = this.j.publish;
    if (madeTag === null || madeUrl === null)
      throw new RoundStopped('journal_inconsistent', 'no tag to report');
    let view: DeployView;
    try {
      view = await this.deliver({
        kind: 'report',
        report: { outcome: 'published', tag: madeTag, url: madeUrl },
      });
    } catch (error) {
      if (!(error instanceof ControlError) || error.kind !== 'refused') throw error;
      this.p.log(`the cloud refused the published report: ${error.code}`);
      throw new Divert('recovery', recoveryCodeOf(error));
    }
    this.accepted(view, 'complete');
    return this.complete();
  }

  /** The pending request again, any refusal being a stop: there is nothing to unwind after the release is live. */
  private async sendPendingOrStop(): Promise<DeployView> {
    try {
      return await this.sendPending();
    } catch (error) {
      if (error instanceof ControlError)
        throw new RoundStopped(`control_${error.kind}`, 'the cloud did not accept the pending report');
      throw error;
    }
  }

  private livePending(): RoundResult {
    return { status: 'live', releaseId: this.j.releaseId, publishPending: true };
  }

  // ---- going back -------------------------------------------------------------------------------

  private async rollbackEngine(): Promise<RoundResult | null> {
    await this.holdHeavyAgain();
    const { previous } = this.j;
    // The fence: nothing is switched back unless this attempt's pause still holds the cloud.
    await this.ownView();
    // The gate: going back is only automatic when the previous program can run on the data as it is now.
    const probe = await this.p.machine.probe(previous.image);
    if (probe.schemaVersion === null || probe.schemaVersion > previous.schemaVersion)
      throw new Divert('recovery', 'database_incompatible');
    if (!probe.imagePresent || !probe.imageVerified) throw new Divert('recovery', 'rollback_failed');
    if ((await this.p.engine.rootCommit(previous.engineRoot)) !== previous.engineCommit)
      throw new Divert('recovery', 'rollback_failed');

    const state = await this.p.engine.state();
    const kind = this.classify(state);
    if (kind === 'unknown') throw new Divert('recovery', 'rollback_failed');
    if (kind !== 'old_running') {
      if (kind === 'new_running') {
        let stopped = false;
        try {
          stopped = await this.p.engine.stop(state.pid as number);
        } catch (error) {
          this.p.log(`the engine stop failed: ${this.describe(error)}`);
        }
        if (!stopped) throw new Divert('recovery', 'rollback_failed');
      }
      // No other engine process of this attempt may run when the previous one is loaded again.
      if (!(await this.enginesGone(state))) throw new Divert('recovery', 'rollback_failed');
      try {
        await this.p.engine.restorePrevious({
          plistPath: previous.plistPath,
          plistSha256: previous.plistSha256,
        });
      } catch (error) {
        this.p.log(`the previous engine could not be restored: ${this.describe(error)}`);
        throw new Divert('recovery', 'rollback_failed');
      }
    }
    this.save({ phase: 'rollback_cloud' });
    return null;
  }

  private async rollbackCloud(): Promise<RoundResult | null> {
    await this.holdHeavyAgain();
    await this.ownView();
    const previous = this.j.previous.image;
    let probe = await this.waitUnlocked(previous, 'rollback_failed');
    if (!(sameImage(probe.current, previous) && probe.healthy)) {
      // Only this attempt's own image is switched back from: a third image is a state nobody here made.
      if (!sameImage(probe.current, previous) && !(await this.isOwnImage(probe.current)))
        throw new Divert('recovery', 'rollback_failed');
      try {
        await this.p.machine.start(previous);
      } catch (error) {
        this.p.log(`the previous image start failed: ${this.describe(error)}`);
        probe = await this.waitUnlocked(previous, 'rollback_failed');
        if (!sameImage(probe.current, previous)) throw new Divert('recovery', 'rollback_failed');
      }
      if (!(await this.p.machine.waitHealthy(previous))) throw new Divert('recovery', 'rollback_failed');
    }
    this.save({ phase: 'report_failed' });
    return null;
  }

  /** The image the cloud runs is the one this attempt prepared; a preparation that does not verify cannot tell. */
  private async isOwnImage(current: ReleaseImageRef | null): Promise<boolean> {
    if (current === null) return false;
    try {
      const verified = await this.verified('rollback_failed', false);
      return sameImage(current, imageRef(verified.artifact));
    } catch (error) {
      if (error instanceof Divert) return false;
      throw error;
    }
  }

  /** The previous pair, proven on both targets and in the registry the cloud will check. */
  private async previousPairRuns(): Promise<boolean> {
    const { previous } = this.j;
    return this.waitFor(async () => {
      const registry = await this.p.control.engines();
      const entry = registry.engines.find((candidate) => candidate.id === this.p.config.engineId);
      if (registry.appVersion !== previous.image.commit) return false;
      if (!entry?.online || entry.version !== previous.engineCommit) return false;
      const state = await this.p.engine.state();
      return this.classify(state) === 'old_running' && state.status?.connected === true;
    }, LIMITS.healthMs);
  }

  private async reportFailed(): Promise<RoundResult | null> {
    const failure = this.j.failure;
    if (!failure) throw new RoundStopped('journal_inconsistent', 'there is no failure to report');
    const rolledBack = this.j.pauseId !== null;
    if (rolledBack) {
      await this.holdHeavyAgain();
      if (!(await this.previousPairRuns())) throw new Divert('recovery', 'rollback_failed');
    }
    const fixed = FAILURES[failure.code];
    let view: DeployView;
    try {
      view = await this.deliver({
        kind: 'report',
        report: { outcome: 'failed', failure: { step: fixed.step, message: fixed.message, rolledBack } },
        ...(rolledBack ? { image: imageRef(this.j.previous.image) } : {}),
      });
    } catch (error) {
      if (!(error instanceof ControlError) || error.kind !== 'refused') throw error;
      this.p.log(`the cloud refused the failure report: ${error.code}`);
      throw new Divert('recovery', recoveryCodeOf(error));
    }
    this.accepted(view, rolledBack ? 'resume' : 'complete');
    return rolledBack ? null : this.complete();
  }

  // ---- recovery ---------------------------------------------------------------------------------

  /**
   * The state is not one the coordinator may settle: the fence stays, the owner is told once (by the cloud, through a
   * `recovery` change), and nothing runs on its own again. A person settles it; a later round only makes sure the
   * cloud has the recovery on record.
   */
  private async recoveryRequired(): Promise<RoundResult | null> {
    const failure = this.j.failure;
    const code: JournalFailureCode = failure?.code ?? 'release_recovery_required';
    const result: RoundResult = { status: 'recovery_required', releaseId: this.j.releaseId, code };
    if (this.j.pauseId === null) return result;
    try {
      if (this.j.pendingRequest === null) {
        const view = await this.guarded(() => this.p.control.deployGet(this.j.releaseId));
        const deployment = view.deployment;
        const eligible =
          deployment !== null &&
          deployment.attemptId === this.j.attemptId &&
          deployment.phase !== 'recovery_required' &&
          (deployment.phase === 'quiescing' ||
            deployment.phase === 'switching' ||
            (deployment.phase === 'live' && deployment.maintenance));
        if (!eligible) return result;
        this.save({ revision: deployment.revision });
        const recoveryCode = (HYBRID_RECOVERY_CODES as readonly string[]).includes(code)
          ? (code as HybridRecoveryCode)
          : 'release_deployment_conflict';
        await this.deliver({ kind: 'recovery', code: recoveryCode, message: FAILURES[code].message });
      } else {
        await this.sendPending();
      }
    } catch (error) {
      if (error instanceof RoundStopped) throw error;
      if (error instanceof ControlError && error.kind === 'refused') {
        this.p.log(`the cloud did not take the recovery note: ${error.code}`);
        return result;
      }
      throw error;
    }
    const view = await this.guarded(() => this.p.control.deployGet(this.j.releaseId));
    if (view.deployment) this.save({ revision: view.deployment.revision, pendingRequest: null });
    return result;
  }

  // ---- the end ----------------------------------------------------------------------------------

  private complete(): RoundResult {
    const { j } = this;
    this.save({ phase: 'complete', pendingRequest: null });
    this.p.journal.archive(this.j);
    if (j.failure === null) return { status: 'live', releaseId: j.releaseId, publishPending: false };
    return {
      status: j.pauseId !== null ? 'rolled_back' : 'failed',
      releaseId: j.releaseId,
      code: j.failure.code,
    };
  }
}
