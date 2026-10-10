import {
  DEFAULT_PAUSE_FORCE_AFTER_MS,
  isWorkPaused,
  NUDGE_POINTS,
  pauseStateOf,
  RESTART_POINTS,
} from '@projectman/shared';
import type {
  Actor,
  InstancePauseView,
  PausedSession,
  PauseKind,
  PauseSource,
  PauseStatus,
  ProjectPauseView,
  Session,
  SessionPause,
} from '@projectman/shared';
import type { PauseOutcome, RunnerEvent, SessionRunner } from '../contracts';
import type { PauseRecord, SessionPauseRecord } from '../db';
import type { Admission, RefinementSteps } from './admission';
import { findHumanByEmail } from './access';
import { isoNow } from './context';
import type { DomainContext } from './context';
import type { FixLimitWatch } from './fix-limit';
import type { HandoffService } from './handoffs';
import type { ScheduleService } from './schedules';
import type { MessageDelivery, Messaging } from './messaging';
import type { ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';
import type { AppendTimelineInput, TimelineService } from './timeline';
import { humanActor, newId, SYSTEM_ACTOR } from './util';

/** How long a shutdown waits for the answers of sessions the runner cut at its deadline. */
export const SHUTDOWN_CUT_GRACE_MS = 10_000;
const SHUTDOWN_POLL_MS = 50;

/** What a pause covers: the whole instance, or one project. */
export type PauseTarget = { scope: 'instance' } | { scope: 'project'; projectKey: string };

/** Who asks: a person (the app), the control command or the system; a person has a user id. */
export interface PauseRequester {
  /** Internal approval freshness check, run under the admission lock before changing state. */
  check?: () => void;
  userId: string | null;
  source: PauseSource;
  via?: 'integrator';
}

export interface PauseOptions {
  kind?: PauseKind;
  /** How long a session may take to stop before it is cut with one Esc (default `DEFAULT_PAUSE_FORCE_AFTER_MS`). */
  forceAfterMs?: number;
  reason?: string;
}

/**
 * Durable pause of the team's work (PM-219), of the instance or of one project: no session starts
 * or is written to meanwhile, the sessions that work stop at a safe point (the runner's `pause`,
 * PM-218), and resuming lets everything go on from where it stopped. A pause and the sessions it
 * holds are stored, so a restart does not lose them. A session is held by one open row (`session_pauses`)
 * for as long as any pause covers its project; the row says where it stopped and whether a session
 * whose process is gone restarts on resume.
 *
 * What waits is decided elsewhere, from the stored pauses: admission and the session launch refuse
 * with `team_paused`, messages wait (`MessageDelivery.holdForPause`), idle-time actions of sessions
 * do not run (`SessionOrchestrator.isPaused`). This service makes the pauses, follows the runner,
 * and on resume lets the sessions and the waiting work go on.
 */
export class PauseService {
  private readonly ctx: DomainContext;
  private readonly projects: Pick<ProjectService, 'config' | 'summaries'>;
  private readonly sessions: SessionOrchestrator;
  private readonly admission: Pick<Admission, 'exclusive' | 'retryDeferred'>;
  private readonly runner: SessionRunner;
  private readonly delivery: MessageDelivery;
  private readonly messaging: Pick<Messaging, 'holdsMessagesOf' | 'wakeWaiting' | 'send'>;
  private readonly timeline: TimelineService;
  private readonly fixLimit: Pick<FixLimitWatch, 'afterResume'>;
  private readonly schedules: Pick<ScheduleService, 'catchUp'>;
  private readonly refinement: Pick<RefinementSteps, 'turnEnded'>;
  private readonly handoffs: Pick<HandoffService, 'paused' | 'resumed'>;
  private readonly unsubscribe: () => void;

  constructor(deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'config' | 'summaries'>;
    sessions: SessionOrchestrator;
    admission: Pick<Admission, 'exclusive' | 'retryDeferred'>;
    runner: SessionRunner;
    delivery: MessageDelivery;
    messaging: Pick<Messaging, 'holdsMessagesOf' | 'wakeWaiting' | 'send'>;
    timeline: TimelineService;
    fixLimit: Pick<FixLimitWatch, 'afterResume'>;
    schedules: Pick<ScheduleService, 'catchUp'>;
    refinement: Pick<RefinementSteps, 'turnEnded'>;
    handoffs: Pick<HandoffService, 'paused' | 'resumed'>;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.sessions = deps.sessions;
    this.admission = deps.admission;
    this.runner = deps.runner;
    this.delivery = deps.delivery;
    this.messaging = deps.messaging;
    this.timeline = deps.timeline;
    this.fixLimit = deps.fixLimit;
    this.schedules = deps.schedules;
    this.refinement = deps.refinement;
    this.handoffs = deps.handoffs;
    this.unsubscribe = deps.runner.onEvent((event) => this.handleRunnerEvent(event));
    // A stop somebody meant closed a session's row: its progress changed.
    deps.sessions.onPauseDropped((projectKey) => this.publishChanged([projectKey]));
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** The project's work is paused: its own pause or the instance's. */
  isPaused(projectKey: string): boolean {
    return isWorkPaused(this.ctx.repos.pauses.open(), projectKey);
  }

  /** What holds the session, or undefined. */
  sessionPause(sessionId: string): SessionPause | undefined {
    const row = this.ctx.repos.pauses.openSession(sessionId);
    return row ? { since: row.since, point: row.point, tool: row.tool } : undefined;
  }

  // ---------------------------------------------------------------- views

  /** The open pauses that touch the project: its own and the instance's, with the project's sessions. */
  projectView(projectKey: string): ProjectPauseView {
    const { pauses } = this.ctx.repos;
    const project = pauses.findOpen('project', projectKey);
    const instance = pauses.findOpen('instance', null);
    return {
      project: project ? this.statusOf(project, [projectKey]) : null,
      instance: instance ? this.statusOf(instance, [projectKey]) : null,
    };
  }

  /** The instance's pause with the sessions of `viewerProjects` (the viewer's internal projects). */
  instanceView(viewerProjects: readonly string[], canManage: boolean): InstancePauseView {
    const pause = this.ctx.repos.pauses.findOpen('instance', null);
    return { pause: pause ? this.statusOf(pause, viewerProjects) : null, canManage };
  }

  /** The pause as the app shows it, with the sessions it holds in `projectKeys`. */
  private statusOf(pause: PauseRecord, projectKeys: readonly string[]): PauseStatus {
    const sessions = this.heldBy(pause)
      .filter((row) => projectKeys.includes(row.projectKey))
      .map((row) => this.pausedSession(row))
      .filter((s): s is PausedSession => s !== null);
    const requester = pause.requestedBy ? this.ctx.repos.users.get(pause.requestedBy) : null;
    return {
      id: pause.id,
      scope: pause.scope,
      projectKey: pause.projectKey,
      kind: pause.kind,
      state: pauseStateOf(sessions),
      source: pause.source,
      requestedBy: requester?.name ?? null,
      requestedAt: pause.requestedAt,
      reason: pause.reason,
      forceAt: new Date(Date.parse(pause.requestedAt) + pause.forceAfterMs).toISOString(),
      sessions,
    };
  }

  /** The open rows of the sessions a pause covers. */
  private heldBy(pause: Pick<PauseRecord, 'scope' | 'projectKey'>): SessionPauseRecord[] {
    const { pauses } = this.ctx.repos;
    return pause.scope === 'instance'
      ? pauses.openSessions()
      : pauses.openSessionsOfProject(pause.projectKey!);
  }

  private pausedSession(row: SessionPauseRecord): PausedSession | null {
    const session = this.ctx.repos.sessions.get(row.sessionId);
    if (!session) return null;
    return {
      sessionId: row.sessionId,
      projectKey: row.projectKey,
      member: session.member,
      workItem: session.workItem,
      since: row.since,
      point: row.point,
      tool: row.tool,
      waitingFor: row.waitingFor,
      pausedAt: row.pausedAt,
      stopped: !this.sessions.isRunning(row.sessionId),
    };
  }

  // ---------------------------------------------------------------- pause

  /**
   * Pauses the target: stores the pause, holds the sessions that run, and asks each to stop at a safe
   * point. A target that is paused already stays as it is (the first request's reason and deadline).
   */
  async pause(target: PauseTarget, by: PauseRequester, opts: PauseOptions = {}): Promise<void> {
    const kind = opts.kind ?? 'manual';
    const forceAfterMs = opts.forceAfterMs ?? DEFAULT_PAUSE_FORCE_AFTER_MS;
    const { pauses } = this.ctx.repos;
    const projectKeys = this.coveredProjects(target);
    const actors = await this.actors(projectKeys, by);
    // Only the rows and the timeline are written under the admission lock: no start slips in between.
    const caught = await this.admission.exclusive(async () => {
      by.check?.();
      if (pauses.findOpen(target.scope, keyOf(target))) return null;
      const at = isoNow(this.ctx);
      const record = {
        id: newId('pau'),
        scope: target.scope,
        projectKey: keyOf(target),
        kind,
        source: by.source,
        reason: opts.reason ?? null,
        requestedBy: by.userId,
        requestedAt: at,
        forceAfterMs,
      };
      const rows = this.ctx.unitOfWork(() => {
        pauses.insert(record);
        const held: SessionPauseRecord[] = [];
        for (const projectKey of projectKeys)
          for (const session of this.ctx.repos.sessions.list(projectKey)) {
            if (!this.sessions.isRunning(session.id) || pauses.openSession(session.id)) continue;
            const row = {
              sessionId: session.id,
              pauseId: record.id,
              projectKey,
              since: at,
              point: null,
              tool: null,
              waitingFor: null,
              pausedAt: null,
              needsRestart: false,
            };
            pauses.insertSession(row);
            held.push({ ...row, resumedAt: null });
          }
        for (const projectKey of projectKeys)
          this.record(kind, {
            projectKey,
            actor: actors.get(projectKey) ?? SYSTEM_ACTOR,
            type: 'team_paused',
            data: {
              pauseId: record.id,
              scope: record.scope,
              source: record.source,
              reason: record.reason,
              forceAfterMs,
            },
          });
        return held;
      });
      return { record, rows };
    });
    if (!caught) return;
    this.ctx.logger.info(
      {
        pauseId: caught.record.id,
        scope: target.scope,
        projectKey: keyOf(target),
        kind,
        sessions: caught.rows.length,
      },
      'the team is paused',
    );
    // No deadline of a handoff runs while the work is paused (PM-342).
    this.handoffs.paused(projectKeys);
    this.publishChanged(projectKeys);
    for (const row of caught.rows) this.stopSession(row.sessionId, forceAfterMs);
  }

  /** Asks the runner to stop the session at its next safe point; the outcome is recorded when it comes. */
  private stopSession(sessionId: string, forceAfterMs: number): void {
    this.runner.pause(sessionId, { forceAfterMs }).then(
      (outcome) => this.settled(sessionId, outcome),
      (err: unknown) => this.ctx.logger.warn({ err, sessionId }, 'could not pause the session'),
    );
  }

  /** The runner answered a pause with where the session stopped (no event came, or it came first). */
  private settled(sessionId: string, outcome: PauseOutcome | null): void {
    const row = this.ctx.repos.pauses.openSession(sessionId);
    // `null`: the pause was taken back. A row that has a point had its events already.
    if (!outcome || !row || row.point !== null) return;
    this.stopped(row, outcome);
  }

  /** A session that started while the team is paused (a start that passed admission before the pause). */
  sessionStarted(session: Session): void {
    const { pauses } = this.ctx.repos;
    if (pauses.openSession(session.id) || !this.isPaused(session.projectKey)) return;
    const covering = pauses
      .open()
      .filter((p) => p.scope === 'instance' || p.projectKey === session.projectKey);
    const first = covering[0];
    if (!first) return;
    const at = isoNow(this.ctx);
    pauses.insertSession({
      sessionId: session.id,
      pauseId: first.id,
      projectKey: session.projectKey,
      since: at,
      point: null,
      tool: null,
      waitingFor: null,
      pausedAt: null,
      needsRestart: false,
    });
    const left = Math.max(0, Date.parse(first.requestedAt) + first.forceAfterMs - this.ctx.now().getTime());
    this.publishSession(session.id);
    this.publishChanged([session.projectKey]);
    this.stopSession(session.id, left);
  }

  // ---------------------------------------------------------------- shutdown and startup

  /**
   * Before the server stops: pauses the instance (kind `shutdown`, by the system) so that every session
   * comes to a safe point and the stop loses no half-done step, then waits until none is still
   * stopping. The runner cuts what has not stopped after `waitMs`; this waits `graceMs`
   * (`SHUTDOWN_CUT_GRACE_MS`) more for those answers, and gives up then (the stop goes on). A pause that is open
   * already is not replaced: its sessions are held as they are, and the ones that have not stopped by `waitMs`
   * are cut (`force`), whichever pause holds them.
   */
  async pauseForShutdown(waitMs: number, graceMs = SHUTDOWN_CUT_GRACE_MS): Promise<void> {
    await this.pause(
      { scope: 'instance' },
      { userId: null, source: 'system' },
      { kind: 'shutdown', forceAfterMs: waitMs },
    );
    const limit = waitMs + graceMs;
    let forced = false;
    for (let waited = 0; this.stillStopping() && waited < limit; waited += SHUTDOWN_POLL_MS) {
      // A pause that was open before (a person's, longer) would let the stop cut the sessions mid-turn:
      // what has not stopped by the deadline is cut with one Esc, as the shutdown's own pause would.
      if (!forced && waited >= waitMs) {
        forced = true;
        await this.forceLater();
      }
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_MS));
    }
    const left = this.ctx.repos.pauses.openSessions().filter((row) => row.point === null).length;
    if (left > 0) this.ctx.logger.warn({ sessions: left }, 'sessions did not stop before the shutdown');
  }

  /** Forces the open pauses whose deadline is still ahead. */
  private async forceLater(): Promise<void> {
    const now = this.ctx.now().getTime();
    for (const pause of this.ctx.repos.pauses.open())
      if (Date.parse(pause.requestedAt) + pause.forceAfterMs > now)
        await this.force(targetOf(pause), { userId: null, source: 'system' });
  }

  /** Whether a session whose process runs has not come to its stop yet. */
  private stillStopping(): boolean {
    return this.ctx.repos.pauses
      .openSessions()
      .some((row) => row.point === null && this.sessions.isRunning(row.sessionId));
  }

  /**
   * After the server started: the pause made for the shutdown ends (the stop itself is no reason to keep
   * the team waiting), and its sessions start again with a nudge that says their process is new. A pause
   * a person made stays: the team waits for them, as before the stop.
   */
  async resumeAfterStartup(): Promise<void> {
    for (const pause of this.ctx.repos.pauses.open().filter((p) => p.kind === 'shutdown'))
      await this.resume(targetOf(pause), { userId: null, source: 'system' });
  }

  // ---------------------------------------------------------------- force

  /** Cuts the sessions still stopping with one Esc, and writes the deadline as now. */
  async force(target: PauseTarget, _by: PauseRequester): Promise<void> {
    const { pauses } = this.ctx.repos;
    const pause = pauses.findOpen(target.scope, keyOf(target));
    if (!pause) return;
    const elapsed = Math.max(0, this.ctx.now().getTime() - Date.parse(pause.requestedAt));
    pauses.setForceAfter(pause.id, Math.min(pause.forceAfterMs, elapsed));
    this.publishChanged(this.coveredProjects(target));
    for (const row of this.heldBy(pause)) {
      if (row.point !== null || !this.sessions.isRunning(row.sessionId)) continue;
      this.runner.forcePause(row.sessionId).then(
        (outcome) => this.settled(row.sessionId, outcome),
        (err: unknown) =>
          this.ctx.logger.warn({ err, sessionId: row.sessionId }, 'could not force the pause'),
      );
    }
  }

  // ---------------------------------------------------------------- the runner's events

  private handleRunnerEvent(event: RunnerEvent): void {
    if (event.type !== 'session_pausing' && event.type !== 'session_paused') return;
    try {
      const row = this.ctx.repos.pauses.openSession(event.sessionId);
      if (!row) return;
      if (event.type === 'session_pausing') {
        // A stopped session works again (an approval answered, typing in the terminal): stopping once more.
        this.ctx.repos.pauses.updateSession(row.sessionId, {
          point: null,
          tool: null,
          waitingFor: event.waitingFor,
          pausedAt: null,
          needsRestart: false,
        });
        this.publishSession(row.sessionId);
        this.publishChanged([row.projectKey]);
        return;
      }
      this.stopped(row, { point: event.point, tool: event.tool });
    } catch (err) {
      this.ctx.logger.error(
        { err, sessionId: event.sessionId, type: event.type },
        'pause event handling failed',
      );
    }
  }

  /** The session stopped at `outcome`. A process that exits after it stopped keeps where it stopped. */
  private stopped(row: SessionPauseRecord, outcome: PauseOutcome): void {
    if (outcome.point === 'exited' && row.point !== null && row.point !== 'exited') {
      this.publishSession(row.sessionId);
      this.publishChanged([row.projectKey]);
      return;
    }
    this.ctx.repos.pauses.updateSession(row.sessionId, {
      point: outcome.point,
      tool: outcome.tool,
      waitingFor: null,
      pausedAt: isoNow(this.ctx),
      needsRestart: RESTART_POINTS.includes(outcome.point),
    });
    this.publishSession(row.sessionId);
    this.publishChanged([row.projectKey]);
  }

  // ---------------------------------------------------------------- resume

  /**
   * Ends the target's pause: its row closes, and the sessions it held, but not those another pause still
   * holds (the instance's and a project's are independent), go on from where they stopped; what waited
   * is tried again. Resuming what is not paused changes nothing.
   */
  async resume(target: PauseTarget, by: PauseRequester): Promise<void> {
    const { pauses } = this.ctx.repos;
    const projectKeys = this.coveredProjects(target);
    const actors = await this.actors(projectKeys, by);
    const closed = await this.admission.exclusive(async () => {
      by.check?.();
      const pause = pauses.findOpen(target.scope, keyOf(target));
      if (!pause) return null;
      this.ctx.unitOfWork(() => {
        pauses.close(pause.id, isoNow(this.ctx), by.userId);
        for (const projectKey of projectKeys)
          this.record(pause.kind, {
            projectKey,
            actor: actors.get(projectKey) ?? SYSTEM_ACTOR,
            type: 'team_resumed',
            data: { pauseId: pause.id, scope: pause.scope, source: pause.source },
          });
      });
      return pause;
    });
    if (!closed) return;
    this.ctx.logger.info(
      { pauseId: closed.id, scope: closed.scope, projectKey: closed.projectKey },
      'the team is resumed',
    );
    this.publishChanged(projectKeys);
    await this.release(closed, actors);
    await this.afterResume(closed, projectKeys);
  }

  /** The sessions of the resumed pause whose project no pause covers any more go on. */
  private async release(pause: PauseRecord, actors: ReadonlyMap<string, Actor>): Promise<void> {
    const { pauses } = this.ctx.repos;
    const stillPaused = pauses.open();
    for (const row of this.heldBy(pause)) {
      if (isWorkPaused(stillPaused, row.projectKey)) continue;
      pauses.closeSession(row.sessionId, isoNow(this.ctx));
      const session = this.ctx.repos.sessions.get(row.sessionId);
      if (!session) continue;
      try {
        if (this.sessions.isRunning(session.id)) this.letGo(session, row);
        // No point: the process was cut before it answered (the stop of the server), in a turn.
        else if (row.needsRestart || row.point === null)
          await this.restart(session, row, pause.kind, actors.get(session.projectKey));
        else {
          // It stopped between turns and its process is gone: what came for it meanwhile wakes it as usual.
          this.delivery.dropPauseHeld(session.id);
          await this.messaging.wakeWaiting(session);
        }
      } catch (err) {
        this.ctx.logger.warn({ err, sessionId: session.id }, 'could not resume the session');
      }
      this.publishSession(session.id);
    }
    this.publishChanged(this.coveredProjects(targetOf(pause)));
  }

  /**
   * A session whose process runs goes on: released (with a nudge where it was cut mid-turn), its held
   * messages typed in. One that stopped between turns (`idle`, `turn_end`) gets no nudge, and its turn
   * ends for the refinement as it would have without the pause.
   */
  private letGo(session: Session, row: SessionPauseRecord): void {
    const nudge =
      row.point && NUDGE_POINTS.includes(row.point)
        ? this.sessions.pauseNudge(row.point, row.tool, false)
        : undefined;
    this.runner.release(session.id, nudge ? { nudge } : undefined);
    this.delivery.deliverPauseHeld(session);
    const current = this.ctx.repos.sessions.get(session.id);
    if (!current) return;
    this.sessions.afterPause(current);
    if (row.point === 'idle' || row.point === 'turn_end') {
      void this.refinement.turnEnded(current).catch((err: unknown) => {
        this.ctx.logger.warn({ err, sessionId: session.id }, 'refinement step after the pause failed');
      });
    }
  }

  /**
   * A session whose process is gone (a shutdown, a crash, a stop of the runner) and that was cut in a turn is
   * started again, with the nudge and then the messages that wait for it as its first input. Without
   * admission, as a person's restart. When its card holds the member's messages back (the fix round limit, a
   * refinement turn of another member), or the start fails, the nudge is stored as a system message instead
   * and goes the usual way: with the hold's end, or the member's next wake-up.
   */
  private async restart(
    session: Session,
    row: SessionPauseRecord,
    kind: PauseKind,
    by?: Actor,
  ): Promise<void> {
    this.delivery.dropPauseHeld(session.id);
    // A row with no point was cut at an unknown place: like a tool that was interrupted.
    const nudge = this.sessions.pauseNudge(row.point ?? 'interrupted', row.tool, true);
    this.ctx.logger.info(
      { sessionId: session.id, point: row.point, kind },
      'starting a paused session again',
    );
    if (await this.messaging.holdsMessagesOf(session)) {
      await this.nudgeAsMessage(session, nudge);
      return;
    }
    try {
      await this.delivery.startAndDeliver(session.projectKey, session.member, session.workItem, (messages) =>
        this.sessions.ensureSession(session.projectKey, session.member, session.workItem, {
          messages,
          nudge,
          pauseRestart: true,
          cause: { kind: 'pause_resume', ...(by ? { by } : {}) },
        }),
      );
    } catch (err) {
      this.ctx.logger.warn({ err, sessionId: session.id }, 'could not start a paused session again');
      await this.nudgeAsMessage(session, nudge);
    }
  }

  /** The nudge of a session that could not start with it: a stored message, so that nothing is lost. */
  private async nudgeAsMessage(session: Session, nudge: string | undefined): Promise<void> {
    if (!nudge) return;
    const { workItem } = session;
    await this.messaging.send(
      session.projectKey,
      'system',
      { to: [session.member], text: nudge, taskKey: workItem.type === 'task' ? workItem.taskKey : null },
      { actor: SYSTEM_ACTOR, workItem },
    );
  }

  /**
   * What waited for the pause to end is tried again, in the projects no pause covers any more: the fix
   * round decisions that were put off, the scheduled runs the pause swallowed (once each) and the starts
   * that were deferred for it.
   */
  private async afterResume(pause: PauseRecord, projectKeys: readonly string[]): Promise<void> {
    const stillPaused = this.ctx.repos.pauses.open();
    const since = new Date(pause.requestedAt);
    const until = new Date(isoNow(this.ctx));
    for (const projectKey of projectKeys) {
      if (isWorkPaused(stillPaused, projectKey)) continue;
      try {
        await this.fixLimit.afterResume(projectKey);
        await this.schedules.catchUp(projectKey, since, until);
      } catch (err) {
        this.ctx.logger.warn({ err, projectKey }, 'could not pick up what waited for the pause');
      }
    }
    this.handoffs.resumed(projectKeys);
    void this.admission.retryDeferred().catch((err: unknown) => {
      this.ctx.logger.warn({ err }, 'deferred start retry after the resume failed');
    });
  }

  // ---------------------------------------------------------------- helpers

  /** The projects a pause of the target covers. */
  private coveredProjects(target: PauseTarget): string[] {
    return target.scope === 'project' ? [target.projectKey] : this.projects.summaries().map((p) => p.key);
  }

  private publishSession(sessionId: string): void {
    const session = this.ctx.repos.sessions.get(sessionId);
    if (session) this.ctx.bus.publish({ type: 'session_upserted', projectKey: session.projectKey, session });
  }

  private publishChanged(projectKeys: readonly string[]): void {
    for (const projectKey of new Set(projectKeys)) {
      this.ctx.bus.publish({ type: 'pause_changed', projectKey, pause: this.projectView(projectKey) });
      void this.ctx.events.emit('pause_changed', { projectKey });
    }
  }

  /**
   * The timeline entry of a pause or a resume, in the project, by the person who asked (their member
   * there) or the system. The pause before a shutdown writes none: it would be noise at every restart.
   */
  private record(kind: PauseKind, event: AppendTimelineInput): void {
    if (kind === 'shutdown') return;
    this.timeline.append(event);
  }

  /** The requester as a member of each project (the config is read before the admission lock is taken). */
  private async actors(projectKeys: readonly string[], by: PauseRequester): Promise<Map<string, Actor>> {
    const user = by.userId ? this.ctx.repos.users.get(by.userId) : null;
    const actors = new Map<string, Actor>();
    if (!user) return actors;
    for (const projectKey of projectKeys) {
      try {
        const member = findHumanByEmail(await this.projects.config(projectKey), user.email);
        if (member)
          actors.set(projectKey, { ...humanActor(member.handle), ...(by.via ? { via: by.via } : {}) });
      } catch {
        // A project whose config cannot be read has the system as the actor.
      }
    }
    return actors;
  }
}

function keyOf(target: PauseTarget): string | null {
  return target.scope === 'project' ? target.projectKey : null;
}

function targetOf(pause: Pick<PauseRecord, 'scope' | 'projectKey'>): PauseTarget {
  return pause.scope === 'project' && pause.projectKey
    ? { scope: 'project', projectKey: pause.projectKey }
    : { scope: 'instance' };
}
