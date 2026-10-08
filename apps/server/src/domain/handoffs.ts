import {
  DEFAULT_AGENT_PROVIDER,
  HANDOFF_CLOSE_GRACE_MS,
  HANDOFF_TIMEOUT_MS,
  isOnLeave,
  isOpenTask,
  isWorkPaused,
  memberOf,
  NUDGE_POINTS,
  planHandoff,
  routeFor,
  stageOf,
} from '@projectman/shared';
import type {
  Actor,
  AgentProvider,
  HandoffFallbackReason,
  HandoffStart,
  ProjectConfig,
  Session,
  SessionStop,
  Task,
  TaskHandoffRecord,
  TimelineEventData,
} from '@projectman/shared';
import type { ContextPackBuilder, SessionRunner } from '../contracts';
import type { TaskHandoffRow } from '../db';
import type { Admission, AutomaticStart, StartSpec } from './admission';
import type { BackgroundTasks } from './background';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, DomainError, notFound } from './errors';
import type { MessageService, Messaging } from './messaging';
import type { ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';
import type { HandoffTrigger, TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { aiActor, newId, SYSTEM_ACTOR } from './util';

/** The most characters of the waiting messages that are forwarded to the receiver in one message. */
const FORWARDED_MESSAGES_MAX = 20_000;

/** The refusals of a start that mean the old member's provider cannot take the instruction now. */
const PROVIDER_LIMITED = new Set<string>([
  'ai_limit_reached',
  'plan_usage_paused',
  'provider_rate_limited',
  'provider_not_logged_in',
]);

type HandoffEventData = Omit<
  TimelineEventData['task_handoff'],
  'handoffId' | 'from' | 'to' | 'fromProvider' | 'toProvider'
>;

/**
 * The handoff of a card's assignee (PM-342). When a card changes hands, the old AI member's session is
 * asked, at a safe point, to write a note for the new one (`hand_off`), within `HANDOFF_TIMEOUT_MS`; when
 * that is not possible or too slow, the summary of its transcript stands in. The receiver's start waits
 * for it (`task_handoff_open`), and its first session begins with the note.
 *
 * A handoff is a row (`task_handoffs`, at most one open per card) that these steps move along:
 * `waiting_point` (the old session is brought to a safe point), `writing` (it was told to write the note),
 * `paused` (the team is paused: no deadline runs), `closing` (the note or the fallback is recorded, and the
 * old session closes), then it ends with an outcome. A change of the assignee while it is open redirects it
 * (`begin`); the row survives a restart of the server (`resumeAfterStartup`).
 *
 * `begin` runs inside the unit of work that changes the assignee, so it only writes the row and the
 * timeline; what needs a session or an await (`drive`, `settle`) is scheduled after the commit. The
 * asynchronous steps do not hold a lock across an await: each reads the row again after it and writes
 * the row it read, so a cancel, a retarget or a pause that came meanwhile is not lost.
 */
export class HandoffService {
  private readonly ctx: DomainContext;
  private readonly projects: Pick<ProjectService, 'config' | 'cachedConfig'>;
  private readonly tasks: Pick<TaskService, 'find' | 'get' | 'publish'>;
  private readonly sessions: SessionOrchestrator;
  private readonly admission: Pick<Admission, 'exclusive' | 'check' | 'start' | 'attempt'>;
  private readonly runner: SessionRunner;
  private readonly messages: Pick<MessageService, 'waiting' | 'markRecipientForwarded'>;
  private readonly messaging: Pick<Messaging, 'send'>;
  private readonly timeline: TimelineService;
  private readonly contextBuilder: Pick<ContextPackBuilder, 'handoffInstruction' | 'handoffCancelled'>;
  private readonly background: BackgroundTasks;
  private readonly retry: () => void;
  /** The handoffs `drive` works on now; a call meanwhile only asks it to look again. */
  private readonly driving = new Map<string, { again: boolean }>();
  /** The handoffs `settle` records a fallback for now. */
  private readonly settling = new Set<string>();

  constructor(deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'config' | 'cachedConfig'>;
    tasks: Pick<TaskService, 'find' | 'get' | 'publish'>;
    sessions: SessionOrchestrator;
    admission: Pick<Admission, 'exclusive' | 'check' | 'start' | 'attempt'>;
    runner: SessionRunner;
    messages: Pick<MessageService, 'waiting' | 'markRecipientForwarded'>;
    messaging: Pick<Messaging, 'send'>;
    timeline: TimelineService;
    contextBuilder: Pick<ContextPackBuilder, 'handoffInstruction' | 'handoffCancelled'>;
    background: BackgroundTasks;
    /** Tries the deferred starts again (a start that waited for the handoff). */
    retry: () => void;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.admission = deps.admission;
    this.runner = deps.runner;
    this.messages = deps.messages;
    this.messaging = deps.messaging;
    this.timeline = deps.timeline;
    this.contextBuilder = deps.contextBuilder;
    this.background = deps.background;
    this.retry = deps.retry;
  }

  // ---------------------------------------------------------------- the card changes hands

  /**
   * The card changed its assignee. Returns what the request started, or null when nothing was: no
   * conversation to hand over, a human handing over, or the card went back to the member it was being
   * handed over from (the handoff is called off).
   */
  begin(trigger: HandoffTrigger): HandoffStart | null {
    const { task, previous, actor, reason } = trigger;
    const { taskHandoffs } = this.ctx.repos;
    const open = taskHandoffs.open(task.key);
    if (open) return this.redirect(open, trigger);
    if (!previous || !isOpenTask(task)) return null;
    const config = this.projects.cachedConfig(task.projectKey);
    if (!config) return null;
    const workItem = { type: 'task', taskKey: task.key } as const;
    const line = this.ctx.repos.sessions.findByWorkItem(task.projectKey, previous, workItem);
    const member = memberOf(config, previous);
    const plan = planHandoff({
      from: member
        ? {
            kind: member.kind,
            provider:
              member.kind === 'ai' ? (member.provider ?? DEFAULT_AGENT_PROVIDER) : DEFAULT_AGENT_PROVIDER,
            onLeave: isOnLeave(member),
          }
        : null,
      conversation: line
        ? { provider: line.provider ?? DEFAULT_AGENT_PROVIDER, transcript: line.transcriptPath != null }
        : null,
    });
    if (!plan) return null;
    const at = isoNow(this.ctx);
    const paused = this.teamPaused(task.projectKey);
    const row: TaskHandoffRow = {
      id: newId('hof'),
      projectKey: task.projectKey,
      taskKey: task.key,
      from: previous,
      to: task.assignee,
      fromProvider: line?.provider ?? DEFAULT_AGENT_PROVIDER,
      toProvider: this.providerOf(config, task.assignee),
      fromSessionId: line?.id ?? null,
      reason,
      step: plan.mode === 'fallback' ? 'closing' : paused ? 'paused' : 'waiting_point',
      startedAt: at,
      deadlineAt:
        plan.mode === 'live' && !paused
          ? new Date(this.ctx.now().getTime() + HANDOFF_TIMEOUT_MS).toISOString()
          : null,
      outcome: null,
      fallbackReason: plan.mode === 'fallback' ? plan.reason : null,
      note: null,
      branch: null,
      lastCommit: null,
      uncommitted: null,
      summary: null,
      closingAt: null,
      endedAt: null,
      takenOverAt: null,
      takenOverSessionId: null,
    };
    taskHandoffs.create(row);
    this.record(row, actor, {
      phase: 'started',
      reason,
      mode: plan.mode,
      ...(plan.mode === 'fallback' ? { fallbackReason: plan.reason } : {}),
    });
    this.schedule(row.id, 'handoff could not start');
    return plan.mode === 'fallback'
      ? { mode: 'fallback', from: previous, reason: plan.reason }
      : { mode: 'live', from: previous };
  }

  /** The assignee changed while a handoff was open: the card went back (called off), or on to another member. */
  private redirect(open: TaskHandoffRow, trigger: HandoffTrigger): HandoffStart | null {
    const { task, actor } = trigger;
    const at = isoNow(this.ctx);
    if (task.assignee === open.from) {
      this.ctx.repos.taskHandoffs.save({ ...open, outcome: 'cancelled', deadlineAt: null, endedAt: at });
      this.record(open, actor, { phase: 'cancelled' });
      queueMicrotask(() =>
        this.background.run(
          () => this.tellCancelled(open),
          (err) =>
            this.ctx.logger.warn(
              { err, taskKey: open.taskKey },
              'could not tell a session its handoff is called off',
            ),
        ),
      );
      return null;
    }
    const config = this.projects.cachedConfig(task.projectKey);
    const retargeted: TaskHandoffRow = {
      ...open,
      to: task.assignee,
      toProvider: config ? this.providerOf(config, task.assignee) : null,
    };
    this.ctx.repos.taskHandoffs.save(retargeted);
    this.record(retargeted, actor, { phase: 'retargeted' });
    return retargeted.fallbackReason
      ? { mode: 'fallback', from: open.from, reason: retargeted.fallbackReason }
      : { mode: 'live', from: open.from };
  }

  /** The old member's session is told the handover of its card is called off, and keeps working. */
  private async tellCancelled(row: TaskHandoffRow): Promise<void> {
    const session = this.sessions.findRunning(row.projectKey, row.from, {
      type: 'task',
      taskKey: row.taskKey,
    });
    if (!session) return;
    this.sessions.cancelClose(session.id);
    const text = this.contextBuilder.handoffCancelled({ taskKey: row.taskKey });
    // A session held by a pause of the team stays held: the text waits with the session's input.
    if (!this.ctx.repos.pauses.openSession(session.id) && this.runner.release(session.id, { nudge: text }))
      return;
    await this.sessions.typeInto(session, text);
  }

  /** A closed handoff of the card with its note or summary; unknown, open and called-off ones are not found. */
  closedRecord(projectKey: string, taskKey: string, id: string): TaskHandoffRecord {
    const row = this.ctx.repos.taskHandoffs.get(id);
    if (
      !row ||
      row.projectKey !== projectKey ||
      row.taskKey !== taskKey ||
      (row.outcome !== 'note' && row.outcome !== 'fallback') ||
      !row.endedAt
    )
      throw notFound('handoff', id);
    return {
      id: row.id,
      from: row.from,
      to: row.to,
      fromProvider: row.fromProvider,
      toProvider: row.toProvider,
      outcome: row.outcome,
      ...(row.fallbackReason ? { fallbackReason: row.fallbackReason } : {}),
      endedAt: row.endedAt,
      reason: row.reason,
      startedAt: row.startedAt,
      note: row.note,
      branch: row.branch,
      lastCommit: row.lastCommit,
      uncommitted: row.uncommitted,
      summary: row.summary,
    };
  }

  // ---------------------------------------------------------------- the note

  /**
   * The old member's session wrote its note (`hand_off`). Only the member the card is being handed over
   * from may; the session closes at its next idle moment (and is stopped if it does not within
   * `HANDOFF_CLOSE_GRACE_MS`), and the handoff ends with it.
   */
  async recordNote(
    caller: { projectKey: string; member: string; sessionId: string },
    taskKey: string,
    note: string,
  ): Promise<void> {
    const open = this.ctx.repos.taskHandoffs.open(taskKey);
    if (!open || open.projectKey !== caller.projectKey || open.from !== caller.member)
      throw conflict('handoff_not_open', `${taskKey} is not being handed over from ${caller.member}`, {
        taskKey,
      });
    if (open.step === 'closing') {
      if (open.note !== null) return;
      throw conflict(
        'handoff_not_open',
        `the time for the handoff note of ${taskKey} ran out; the summary of your conversation stands in`,
        { taskKey },
      );
    }
    const task = this.tasks.get(caller.projectKey, taskKey);
    const config = await this.projects.config(caller.projectKey);
    const head = await this.sessions.sourceHead(config, task);
    const fresh = this.ctx.repos.taskHandoffs.get(open.id);
    if (!fresh || fresh.outcome || fresh.step === 'closing')
      throw conflict(
        'handoff_not_open',
        `${taskKey} is not being handed over from ${caller.member} any more`,
        {
          taskKey,
        },
      );
    const recorded: TaskHandoffRow = {
      ...fresh,
      step: 'closing',
      deadlineAt: null,
      note,
      branch: head?.branch ?? null,
      lastCommit: head?.commit ?? null,
      uncommitted: head ? head.dirty : null,
      closingAt: isoNow(this.ctx),
    };
    this.ctx.repos.taskHandoffs.save(recorded);
    this.timeline.append({
      projectKey: recorded.projectKey,
      taskKey,
      sessionId: caller.sessionId,
      actor: aiActor(caller.member),
      type: 'task_handoff',
      data: {
        phase: 'note',
        handoffId: recorded.id,
        from: recorded.from,
        to: recorded.to,
        fromProvider: recorded.fromProvider,
        toProvider: recorded.toProvider,
        note,
        lastCommit: recorded.lastCommit,
        uncommitted: recorded.uncommitted,
      },
    });
    const session = this.sessions.find(caller.sessionId);
    if (session) this.sessions.closeWhenIdle(session, { kind: 'handed_off', taskKey });
    this.publish(recorded);
  }

  // ---------------------------------------------------------------- driving the old session

  /** Looks at the handoff again, in the background (after the unit of work that changed it committed). */
  private schedule(id: string, failure: string): void {
    queueMicrotask(() => {
      this.background.run(
        () => this.drive(id),
        (err) => this.ctx.logger.warn({ err, handoffId: id }, failure),
      );
    });
  }

  /**
   * Brings the handoff on: the old session is stopped at a safe point and told to write its note, or
   * started to be told; a decided fallback is carried out. Does nothing for a handoff that waits for
   * the note, or for the team to resume.
   */
  async drive(id: string): Promise<void> {
    const row = this.ctx.repos.taskHandoffs.get(id);
    if (!row || row.outcome) return;
    if (row.step === 'closing') return this.settle(id);
    const running = this.driving.get(id);
    if (running) {
      running.again = true;
      return;
    }
    const mine = { again: false };
    this.driving.set(id, mine);
    try {
      let again = true;
      while (again || mine.again) {
        mine.again = false;
        again = await this.driveOnce(id);
      }
    } finally {
      this.driving.delete(id);
    }
  }

  /** One look at a handoff that waits for the old session; true: look again at once. */
  private async driveOnce(id: string): Promise<boolean> {
    const row = this.ctx.repos.taskHandoffs.get(id);
    if (!row || row.outcome || row.step === 'closing') return false;
    if (row.step === 'paused') {
      if (this.teamPaused(row.projectKey)) return false;
      this.resumeRow(row);
      return true;
    }
    const session = this.sessions.findRunning(row.projectKey, row.from, {
      type: 'task',
      taskKey: row.taskKey,
    });
    if (!session) return this.driveStopped(row);
    if (row.step === 'writing') return false;
    return this.driveRunning(row, session);
  }

  /** The old session runs: it is stopped at a safe point, then told to write the note. */
  private async driveRunning(row: TaskHandoffRow, session: Session): Promise<boolean> {
    if (this.heldByPause(row.projectKey, session.id)) {
      this.setStep(row.id, 'paused');
      return false;
    }
    let outcome;
    try {
      outcome = await this.runner.pause(session.id);
    } catch (err) {
      this.ctx.logger.warn(
        { err, handoffId: row.id, sessionId: session.id },
        'could not stop the session at a safe point',
      );
      return false;
    }
    const fresh = this.ctx.repos.taskHandoffs.get(row.id);
    const current = !!fresh && !fresh.outcome && fresh.step === 'waiting_point';
    // The pause was taken back (a release, a resume of the team): look again, if the handoff still waits.
    if (!outcome) return current;
    if (outcome.point === 'exited') return current;
    if (!current || this.heldByPause(row.projectKey, session.id)) {
      // Its own pause goes; a pause of the team keeps holding the session.
      if (!this.ctx.repos.pauses.openSession(session.id)) this.runner.release(session.id);
      if (fresh && !fresh.outcome && fresh.step === 'waiting_point') this.setStep(fresh.id, 'paused');
      return false;
    }
    const instruction = this.contextBuilder.handoffInstruction({
      taskKey: fresh.taskKey,
      to: fresh.to,
      toProvider: fresh.toProvider,
      deadlineAt: fresh.deadlineAt,
    });
    if (NUDGE_POINTS.includes(outcome.point)) this.runner.release(session.id, { nudge: instruction });
    else {
      this.runner.release(session.id);
      this.typeInstruction(session, instruction);
    }
    this.setStep(fresh.id, 'writing');
    return false;
  }

  /** The old session does not run: it is started with the instruction, or the fallback stands in. */
  private async driveStopped(row: TaskHandoffRow): Promise<boolean> {
    const workItem = { type: 'task', taskKey: row.taskKey } as const;
    const config = await this.projects.config(row.projectKey);
    const member = memberOf(config, row.from);
    const line = this.ctx.repos.sessions.findByWorkItem(row.projectKey, row.from, workItem);
    const blocked = this.cannotResume(config, row, line);
    if (blocked) return this.toFallback(row.id, blocked);
    if (!member || member.kind !== 'ai' || !line) return this.toFallback(row.id, 'not_startable');
    if (!(await this.sessions.transcriptWritten(line))) return this.toFallback(row.id, 'no_conversation');
    const instruction = this.contextBuilder.handoffInstruction({
      taskKey: row.taskKey,
      to: row.to,
      toProvider: row.toProvider,
      deadlineAt: row.deadlineAt,
    });
    try {
      await this.admission.exclusive(async () => {
        await this.admission.check({ config, member, workItem, capacity: false });
        await this.sessions.ensureSession(row.projectKey, row.from, workItem, {
          messages: [instruction],
          cause: { kind: 'handoff', from: row.from, ...(row.to ? { to: row.to } : {}), by: SYSTEM_ACTOR },
        });
      });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'team_paused') {
        this.setStep(row.id, 'paused');
        return false;
      }
      const reason: HandoffFallbackReason =
        err instanceof DomainError && PROVIDER_LIMITED.has(err.code) ? 'provider_limited' : 'not_startable';
      this.ctx.logger.info(
        { err, handoffId: row.id, reason },
        'the old session could not be started for its handoff note',
      );
      return this.toFallback(row.id, reason);
    }
    this.setStep(row.id, 'writing');
    return false;
  }

  /** Why the old member's conversation cannot be asked now; null when it can. */
  private cannotResume(
    config: ProjectConfig,
    row: TaskHandoffRow,
    line: Session | null,
  ): HandoffFallbackReason | null {
    const member = memberOf(config, row.from);
    if (!member) return 'member_removed';
    if (isOnLeave(member)) return 'on_leave';
    if (!line || line.transcriptPath == null) return 'no_conversation';
    if (
      member.kind === 'ai' &&
      (member.provider ?? DEFAULT_AGENT_PROVIDER) !== (line.provider ?? DEFAULT_AGENT_PROVIDER)
    )
      return 'provider_changed';
    return null;
  }

  /** Types the instruction into a session that was let go; it waits for the session to idle. */
  private typeInstruction(session: Session, text: string): void {
    this.sessions.typeInto(session, text).catch((err: unknown) => {
      this.ctx.logger.warn(
        { err, sessionId: session.id },
        'could not tell a session to write its handoff note',
      );
    });
  }

  /** Decides the fallback and settles it; false for `drive`, which has nothing more to do. */
  private async toFallback(id: string, reason: HandoffFallbackReason): Promise<false> {
    if (this.decideFallback(id, reason)) await this.settle(id);
    return false;
  }

  /** The handoff is to end with the transcript summary: its step is `closing`. False: it is not open, or decided. */
  private decideFallback(id: string, reason: HandoffFallbackReason): boolean {
    const row = this.ctx.repos.taskHandoffs.get(id);
    if (!row || row.outcome || row.step === 'closing') return false;
    this.ctx.repos.taskHandoffs.save({ ...row, step: 'closing', deadlineAt: null, fallbackReason: reason });
    return true;
  }

  // ---------------------------------------------------------------- closing

  /**
   * A handoff whose step is `closing`. With a note, it ends once the old session has closed (at once when it
   * does not run). With a fallback, the old session is stopped, the summary and the state of the worktree
   * are recorded, and it ends.
   */
  private async settle(id: string): Promise<void> {
    const row = this.ctx.repos.taskHandoffs.get(id);
    if (!row || row.outcome || row.step !== 'closing') return;
    const workItem = { type: 'task', taskKey: row.taskKey } as const;
    if (row.note !== null) {
      if (!this.sessions.findRunning(row.projectKey, row.from, workItem)) await this.finish(id);
      return;
    }
    if (this.settling.has(id)) return;
    this.settling.add(id);
    try {
      const reason = row.fallbackReason ?? 'timeout';
      const line = this.ctx.repos.sessions.findByWorkItem(row.projectKey, row.from, workItem);
      const stop: SessionStop =
        reason === 'timeout'
          ? { kind: 'handoff_timeout', taskKey: row.taskKey }
          : { kind: 'handed_off', taskKey: row.taskKey };
      if (line && this.sessions.isRunning(line.id)) await this.sessions.stop(row.projectKey, line.id, stop);
      const summary = line ? await this.sessions.transcriptSummary(line) : null;
      const task = this.tasks.find(row.projectKey, row.taskKey);
      const config = await this.projects.config(row.projectKey);
      const head = task ? await this.sessions.sourceHead(config, task) : null;
      const fresh = this.ctx.repos.taskHandoffs.get(id);
      if (!fresh || fresh.outcome) return;
      const recorded: TaskHandoffRow = {
        ...fresh,
        summary,
        branch: head?.branch ?? null,
        lastCommit: head?.commit ?? null,
        uncommitted: head ? head.dirty : null,
        closingAt: isoNow(this.ctx),
      };
      this.ctx.repos.taskHandoffs.save(recorded);
      this.record(recorded, SYSTEM_ACTOR, {
        phase: 'fallback',
        fallbackReason: reason,
        summary: summary !== null,
        lastCommit: recorded.lastCommit,
        uncommitted: recorded.uncommitted,
      });
    } finally {
      this.settling.delete(id);
    }
    await this.finish(id);
  }

  /**
   * The handoff is over: its outcome is set, the messages that waited for the old member go to the receiver,
   * and the receiver, if it is an AI member and the card is at work, starts.
   */
  private async finish(id: string): Promise<void> {
    const row = this.ctx.repos.taskHandoffs.get(id);
    if (!row || row.outcome) return;
    const ended: TaskHandoffRow = {
      ...row,
      outcome: row.note !== null ? 'note' : 'fallback',
      step: 'closing',
      deadlineAt: null,
      endedAt: isoNow(this.ctx),
    };
    this.ctx.repos.taskHandoffs.save(ended);
    this.publish(ended);
    const config = await this.projects.config(ended.projectKey);
    const receiver = ended.to ? memberOf(config, ended.to) : undefined;
    if (receiver?.kind === 'ai') {
      try {
        await this.forwardMessages(ended, receiver.handle);
      } catch (err) {
        this.ctx.logger.warn(
          { err, handoffId: id },
          'could not forward the messages that waited for the old assignee',
        );
      }
      try {
        await this.admission.attempt(
          this.takeoverStart(ended.projectKey, ended.taskKey, ended.id, receiver.handle),
        );
      } catch (err) {
        this.ctx.logger.warn({ err, handoffId: id }, 'could not start the receiver of a handoff');
      }
    }
    this.retry();
  }

  /** The messages that waited for the old member on the card reach the receiver, in one message. */
  private async forwardMessages(row: TaskHandoffRow, to: string): Promise<void> {
    const waiting = this.messages.waiting(row.projectKey, row.from, routeFor(row.taskKey));
    if (waiting.length === 0) return;
    let body = '';
    let omitted = 0;
    for (const message of waiting) {
      const line = `- ${message.from}: ${message.body}\n`;
      if (body.length + line.length > FORWARDED_MESSAGES_MAX) omitted++;
      else body += line;
    }
    const text =
      `These messages were waiting for ${row.from} on ${row.taskKey} when the card was handed over to you:\n${body}` +
      (omitted > 0 ? `(${omitted} more are not shown.)` : '');
    await this.messaging.send(
      row.projectKey,
      'system',
      { to: [to], text, taskKey: row.taskKey },
      { actor: SYSTEM_ACTOR },
    );
    for (const message of waiting) this.messages.markRecipientForwarded(message.id, row.from, to);
  }

  // ---------------------------------------------------------------- the receiver's start

  /** The start of the receiver once the handoff is over, kept and retried like the other automatic starts. */
  takeoverStart(projectKey: string, taskKey: string, handoffId: string, handle: string): AutomaticStart {
    const stageId = this.tasks.find(projectKey, taskKey)?.stageId ?? '';
    const start: AutomaticStart = {
      key: `handoff-takeover:${projectKey}:${taskKey}`,
      projectKey,
      taskKey,
      spec: () => ({ kind: 'handoff_takeover', projectKey, taskKey, handoffId, handle, stageId }),
      stillValid: (task) =>
        task !== null && task.status === 'active' && task.stageId === stageId && task.assignee === handle,
      waitsFor: () => handle,
      retry: () => this.admission.attempt(start),
      log: {
        deferred: 'handoff takeover deferred',
        retryFailed: 'handoff takeover retry failed',
        fields: () => ({ taskKey, member: handle }),
      },
      run: async () => {
        const task = this.tasks.get(projectKey, taskKey);
        if (!start.stillValid(task)) return;
        const row = this.ctx.repos.taskHandoffs.get(handoffId);
        const open = this.ctx.repos.taskHandoffs.open(taskKey);
        if (open)
          throw conflict('task_handoff_open', `${taskKey} is being handed over from ${open.from}`, {
            taskKey,
            from: open.from,
          });
        const config = await this.projects.config(projectKey);
        const member = memberOf(config, handle);
        if (member?.kind !== 'ai' || stageOf(config, task.stageId)?.kind !== 'work') return;
        await this.admission.start({
          config,
          member,
          workItem: { type: 'task', taskKey },
          cause: { kind: 'handoff', from: row?.from, to: handle, by: SYSTEM_ACTOR },
        });
      },
    };
    return start;
  }

  /** A takeover start that was deferred when the server stopped, made again; null when its card is gone. */
  rebuild(spec: Extract<StartSpec, { kind: 'handoff_takeover' }>): AutomaticStart | null {
    return this.tasks.find(spec.projectKey, spec.taskKey)
      ? this.takeoverStart(spec.projectKey, spec.taskKey, spec.handoffId, spec.handle)
      : null;
  }

  // ---------------------------------------------------------------- what the world does meanwhile

  /** The old member's session ended: a handoff waiting for it closes, and one still waiting for its note starts it again. */
  sessionEnded(session: Session): void {
    if (session.workItem.type !== 'task') return;
    const row = this.ctx.repos.taskHandoffs.open(session.workItem.taskKey);
    if (!row || row.from !== session.member || row.projectKey !== session.projectKey) return;
    if (row.step === 'closing' && row.note === null) return;
    if (row.step === 'paused') return;
    this.schedule(row.id, 'handoff could not go on after the session ended');
  }

  /** The configuration changed: a member who left or went on leave can no longer be asked. */
  configChanged(projectKey: string, config: ProjectConfig): void {
    for (const row of this.ctx.repos.taskHandoffs.listOpen(projectKey)) {
      if (row.step === 'closing') continue;
      const reason = this.cannotResume(config, row, this.lineOf(row));
      if (reason === 'member_removed' || reason === 'on_leave') this.fallBack(row.id, reason);
      else if (
        reason === 'provider_changed' &&
        !this.sessions.findRunning(projectKey, row.from, { type: 'task', taskKey: row.taskKey })
      )
        this.fallBack(row.id, reason);
    }
  }

  /** The card was cancelled or done: nothing is handed over any more. */
  taskClosed(task: Pick<Task, 'projectKey' | 'key'>, actor: Actor = SYSTEM_ACTOR): void {
    const row = this.ctx.repos.taskHandoffs.open(task.key);
    if (!row) return;
    const ended: TaskHandoffRow = {
      ...row,
      outcome: 'cancelled',
      deadlineAt: null,
      endedAt: isoNow(this.ctx),
    };
    this.ctx.repos.taskHandoffs.save(ended);
    this.record(ended, actor, { phase: 'cancelled' });
    this.publish(ended);
  }

  private fallBack(id: string, reason: HandoffFallbackReason): void {
    if (!this.decideFallback(id, reason)) return;
    this.background.run(
      () => this.settle(id),
      (err) => this.ctx.logger.warn({ err, handoffId: id }, 'could not record the fallback of a handoff'),
    );
  }

  // ---------------------------------------------------------------- time, pauses and restarts

  /** The periodic look: a note that is late falls back to the summary, a session that does not close is stopped. */
  async sweep(): Promise<void> {
    const now = this.ctx.now().getTime();
    for (const row of this.ctx.repos.taskHandoffs.listOpen()) {
      try {
        if (this.teamPaused(row.projectKey)) continue;
        if ((row.step === 'waiting_point' || row.step === 'writing') && row.deadlineAt) {
          if (now >= Date.parse(row.deadlineAt)) {
            if (this.decideFallback(row.id, 'timeout')) await this.settle(row.id);
          }
        } else if (row.step === 'closing' && row.note !== null) {
          await this.closeStuck(row, now);
        } else if (row.step === 'closing') {
          await this.settle(row.id);
        }
      } catch (err) {
        this.ctx.logger.warn({ err, handoffId: row.id }, 'handoff sweep failed');
      }
    }
  }

  /** The note is recorded and the old session does not close: it is stopped after the grace. */
  private async closeStuck(row: TaskHandoffRow, now: number): Promise<void> {
    const line = this.lineOf(row);
    if (!line || !this.sessions.isRunning(line.id)) return this.settle(row.id);
    if (row.closingAt && now - Date.parse(row.closingAt) < HANDOFF_CLOSE_GRACE_MS) return;
    await this.sessions.stop(row.projectKey, line.id, { kind: 'handed_off', taskKey: row.taskKey });
    await this.finish(row.id);
  }

  /** The projects' work was paused: no deadline runs while it is. */
  paused(projectKeys: readonly string[]): void {
    for (const projectKey of projectKeys)
      for (const row of this.ctx.repos.taskHandoffs.listOpen(projectKey))
        if (row.step === 'waiting_point' || row.step === 'writing') this.setStep(row.id, 'paused');
  }

  /** The projects' work was resumed: the deadline of what was paused runs from now, and the old session is looked at again. */
  resumed(projectKeys: readonly string[]): void {
    for (const projectKey of projectKeys) {
      if (this.teamPaused(projectKey)) continue;
      for (const row of this.ctx.repos.taskHandoffs.listOpen(projectKey)) {
        if (row.step === 'paused') this.resumeRow(row);
        else if (row.step === 'closing' && row.note !== null)
          this.ctx.repos.taskHandoffs.save({ ...row, closingAt: isoNow(this.ctx) });
        this.schedule(row.id, 'handoff could not go on after the pause');
      }
    }
  }

  /** The server started: every open handoff goes on (its sessions are gone). */
  resumeAfterStartup(): void {
    for (const row of this.ctx.repos.taskHandoffs.listOpen()) {
      if (this.teamPaused(row.projectKey)) {
        if (row.step === 'waiting_point' || row.step === 'writing') this.setStep(row.id, 'paused');
        continue;
      }
      if (row.step === 'paused') this.resumeRow(row);
      this.schedule(row.id, 'handoff could not go on after the start');
    }
  }

  // ---------------------------------------------------------------- helpers

  private teamPaused(projectKey: string): boolean {
    return isWorkPaused(this.ctx.repos.pauses.open(), projectKey);
  }

  /** The session is held by a pause of the team, or its project's work is paused. */
  private heldByPause(projectKey: string, sessionId: string): boolean {
    return this.teamPaused(projectKey) || this.ctx.repos.pauses.openSession(sessionId) !== null;
  }

  private lineOf(row: TaskHandoffRow): Session | null {
    return this.ctx.repos.sessions.findByWorkItem(row.projectKey, row.from, {
      type: 'task',
      taskKey: row.taskKey,
    });
  }

  private providerOf(config: ProjectConfig, handle: string | null): AgentProvider | null {
    const member = memberOf(config, handle);
    return member?.kind === 'ai' ? (member.provider ?? DEFAULT_AGENT_PROVIDER) : null;
  }

  /** A paused handoff goes on: its note is due `HANDOFF_TIMEOUT_MS` from now. */
  private resumeRow(row: TaskHandoffRow): void {
    const fresh = this.ctx.repos.taskHandoffs.get(row.id);
    if (!fresh || fresh.outcome || fresh.step !== 'paused') return;
    const saved: TaskHandoffRow = {
      ...fresh,
      step: 'waiting_point',
      deadlineAt: new Date(this.ctx.now().getTime() + HANDOFF_TIMEOUT_MS).toISOString(),
    };
    this.ctx.repos.taskHandoffs.save(saved);
    this.publish(saved);
  }

  /** Moves an open handoff to `step`; a paused one has no deadline. */
  private setStep(id: string, step: 'writing' | 'paused'): void {
    const fresh = this.ctx.repos.taskHandoffs.get(id);
    if (!fresh || fresh.outcome || fresh.step === 'closing') return;
    const saved: TaskHandoffRow = { ...fresh, step, deadlineAt: step === 'paused' ? null : fresh.deadlineAt };
    this.ctx.repos.taskHandoffs.save(saved);
    this.publish(saved);
  }

  private record(row: TaskHandoffRow, actor: Actor, data: HandoffEventData): void {
    this.timeline.append({
      projectKey: row.projectKey,
      taskKey: row.taskKey,
      actor,
      type: 'task_handoff',
      data: {
        handoffId: row.id,
        from: row.from,
        to: row.to,
        fromProvider: row.fromProvider,
        toProvider: row.toProvider,
        ...data,
      },
    });
  }

  /** The card shows the handoff as it is now. */
  private publish(row: Pick<TaskHandoffRow, 'projectKey' | 'taskKey'>): void {
    const task = this.tasks.find(row.projectKey, row.taskKey);
    if (task) this.tasks.publish(task);
  }
}
