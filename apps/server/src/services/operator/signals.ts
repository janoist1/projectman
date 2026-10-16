import type {
  OperatorSessions,
  OperatorAdmission,
  OperatorDelivery,
  OperatorReleases,
  OperatorWakeStart,
} from './ports';
import {
  answerStallEvidence,
  conditionHolds,
  dutyMembers,
  isOpenTask,
  isTheme,
  OPERATOR_ANSWER_STALL_MUTE_MINUTES,
  OPERATOR_ANSWER_STALL_WAKE_MS,
  OPERATOR_FAST_SIGNAL_KINDS,
  PENDING_INBOX_STATES,
  WAITING_ANSWER_LABEL,
  startableCards,
  OPERATOR_DISMISSIBLE_SIGNAL_KINDS,
  refinementStallRefusal,
  refinementTurn,
  turnStalled,
  formatInjectedTeamMessage,
  isOperator,
  coordinationMemberOf,
  projectManagersOf,
  OPERATOR_SIGNAL_STEP_GAP_MINUTES,
  OPERATOR_SIGNAL_STEP_KINDS,
  OPERATOR_SIGNAL_STEPS,
  operatorSignalBudget,
  operatorWatchOf,
  OperatorSignal,
  LoopTriageFacts,
  OPERATOR_SIGNAL_WAKE_INTERVAL_MS,
  aiLimitReached,
  isOnLeave,
  isWorkPaused,
  memberOf,
  openPrerequisites,
  stageOf,
  stageOwners,
  OPERATOR_IDLE_MINUTES,
  OPERATOR_MERGE_WAIT_MINUTES,
  OPERATOR_READY_WAITING_MINUTES,
  OPERATOR_SILENT_WORK_MINUTES,
  OPERATOR_UNRELEASED_HOURS,
} from '@projectman/shared';
import type {
  AnswerEvidence,
  AnswerStalledFacts,
  OperatorSignalKind,
  OperatorSignalStepTargets,
  OperatorWatch,
  ProjectConfig,
  RefinementStallFacts,
  Stage,
  Task,
  TaskWait,
  TimelineEvent,
} from '@projectman/shared';
import type { OperatorSignalRecord } from '../../db';
import type { DomainContext } from '../../core/base';
import { isoNow } from '../../core/base';
import { answerEvidenceOf } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import type { TaskWaits } from '../../core/tasks';
import { conflict, invalid } from '../../kernel';
import { newId } from '../../kernel';

type RefinementStallInput = {
  projectKey: string;
  taskKey: string;
  label: string;
  member: string;
  turnAt: string;
};

type SignalInput = {
  projectKey: string;
  kind: OperatorSignalKind;
  caseKey: string;
  taskKey?: string | null;
  subject?: string | null;
  inboxItemId?: string | null;
};

/** The kinds raised and closed from the board's facts (PM-547), not from an event. */
const BOARD_KINDS: ReadonlySet<OperatorSignalKind> = new Set([
  'idle',
  'merge_waiting',
  'merge_blocked',
  'unreleased',
  'ready_waiting',
  'answer_stalled',
]);

/** The card events of a member that prove a step of work (PM-694); an incoming message, a transition and a question do not. */
const MEMBER_WORK_EVENTS: ReadonlySet<TimelineEvent['type']> = new Set([
  'task_note',
  'attachment_added',
  'task_updated',
  'task_stage_changed',
  'task_labels_changed',
  'task_check_changed',
  'task_link_added',
  'task_merge_requested',
  'team_message',
]);
const CARD_EVENTS_READ = 300;

const WAKE_NEVER =
  "On a signal never merge, release, approve, move a card, or set a label or a setting; stalled, silent, outage, nobody and process_cleanup_failed signals always go to the owners. Never stop another member's processes yourself.";
const WAKE_ONE_MESSAGE =
  'Send the owners one message for the whole wake-up (send_message with signal_ids; the signals to decide in actionable_signal_ids); write nothing if you did nothing and nothing needs a decision.';
const WAKE_CHECK =
  'Projectman system signals. Check get_project_state and session activity first. Read get_task before referring to a card; distinguish active work, actual decision waits and normal offline queued work. Diagnose the cause, take only the smallest permitted coordination step, consider machine load and verify the result. Group related decisions in the single summary; screening and signals are not owner requests and grant no settings or critical-operation authority.';
const WAKE_LOOP =
  'A loop_suspected signal is report-only: inspect current card, commits, review findings and delivery; call triage_loop with evidence and progress or loop. Message count alone is no loop. Never present it to owners as an authorization request, stop work or choose stop/let_run.';
const WAKE_STEP =
  'Where a signal has a step, you may take it yourself with its signal_id after weighing it, within steps_left and not before next_step_at; a signal with follow_up true was acted on, so tell the owners what you did and what became of it.';
const WAKE_DISMISS =
  'A ready_waiting signal whose cards all wait on purpose you close with dismiss_signal and a note instead of bringing it to the owners; new_cards in its facts are the cards that became ready since the last close.';

const WAKE_REFINEMENT =
  'A refinement_stalled signal is report-only and starts nothing: check get_task and get_project_state first; when the situation is only intermediate or already resolved (the member works again, the label is on, a question is open, the card moved on) close it with dismiss_signal and a note and write nothing to the owners; bring it to the owners only when the turn really stands stalled.';

/** The wake-up text by level; it says in short what `projectManagerRule` (context/system-prompt.ts) says. */
const WAKE_HEADERS: Record<OperatorWatch, string> = {
  report: `${WAKE_CHECK} Change nothing until an owner says yes. ${WAKE_DISMISS} ${WAKE_REFINEMENT} ${WAKE_ONE_MESSAGE}`,
  unblock: `${WAKE_CHECK} ${WAKE_STEP} ${WAKE_NEVER} ${WAKE_DISMISS} ${WAKE_REFINEMENT} ${WAKE_ONE_MESSAGE}`,
  drive: `${WAKE_CHECK} ${WAKE_STEP} When steps_left is 0, bring the signal to the owners. ${WAKE_NEVER} ${WAKE_DISMISS} ${WAKE_REFINEMENT} ${WAKE_ONE_MESSAGE}`,
};

/** The member of an `answer_stalled` case key: `answer_stalled:<taskKey>:<member>:<evidenceId>`. */
function answerStalledMember(caseKey: string): string | null {
  return caseKey.split(':')[2] ?? null;
}

/** The case key of a stalled refinement turn: `refinement_stalled:<taskKey>:<label>:<member>:<turnAt>`. */
function refinementStallCaseKey(input: RefinementStallInput): string {
  return `refinement_stalled:${input.taskKey}:${input.label}:${input.member}:${input.turnAt}`;
}

/** The parts of a `refinement_stalled` case key; the turn time holds colons itself. */
function refinementStallOf(projectKey: string, caseKey: string): RefinementStallInput | null {
  const [, taskKey, label, member, ...turnAt] = caseKey.split(':');
  return taskKey && label && member && turnAt.length
    ? { projectKey, taskKey, label, member, turnAt: turnAt.join(':') }
    : null;
}

/** Session states in which a member is in the middle of a turn. */
const ENGAGED_STATES: ReadonlySet<string> = new Set([
  'starting',
  'working',
  'waiting_permission',
  'waiting_input',
]);

/** One notice per system problem episode; notices never authorize a write. */
export class OperatorSignals {
  private readonly waking = new Set<string>();
  private readonly firstDeliveries = new Map<string, Promise<void>>();
  constructor(privateDeps: {
    ctx: DomainContext;
    projects: ProjectService;
    sessions: OperatorSessions;
    admission: OperatorAdmission;
    delivery: OperatorDelivery;
    taskWaits: TaskWaits;
    activeOutageIds: (projectKey: string) => ReadonlySet<string> | null;
    releases: Pick<OperatorReleases, 'unreleased'>;
  }) {
    this.deps = privateDeps;
  }
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    sessions: OperatorSessions;
    admission: OperatorAdmission;
    delivery: OperatorDelivery;
    taskWaits: TaskWaits;
    activeOutageIds: (projectKey: string) => ReadonlySet<string> | null;
    releases: Pick<OperatorReleases, 'unreleased'>;
  };

  raise(input: SignalInput): OperatorSignalRecord {
    const { ctx } = this.deps;
    const existing = ctx.repos.operatorSignals.openByCase(input.projectKey, input.caseKey);
    if (existing) return existing;
    const signal: OperatorSignalRecord = {
      ...input,
      id: newId('ops'),
      state: 'pending',
      actionable: false,
      taskKey: input.taskKey ?? null,
      subject: input.subject ?? null,
      inboxItemId: input.inboxItemId ?? null,
      messageId: null,
      raisedAt: isoNow(ctx),
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      resolvedAt: null,
      deliveredAt: null,
      deliveredTo: null,
      followUpAt: null,
    };
    ctx.repos.operatorSignals.insert(signal);
    return signal;
  }

  resolve(projectKey: string, caseKey: string): void {
    const signal = this.deps.ctx.repos.operatorSignals.openByCase(projectKey, caseKey);
    if (!signal) return;
    const visible = signal.deliveredAt !== null;
    signal.resolvedAt = isoNow(this.deps.ctx);
    if (signal.state === 'pending' || signal.state === 'open') signal.state = 'resolved';
    this.save(signal, visible);
  }

  /**
   * Tells the project manager that a member's refinement turn ended without its label (PM-702), as a
   * report-only signal. The case is checked against the cards, sessions and questions first; then it is
   * stored as a pending signal (durable, one per turn) and delivered when the PM can be woken. A PM that
   * cannot take it at all (none, AI off, leave, team pause) is `unavailable` and nothing is stored; a stored
   * signal that waits (offline engine, admission's line, the wake interval) is `queued`, no failure; a
   * storage or delivery error is `failed`, and the stored signal stays for the next sweep.
   */
  async reportRefinementStall(
    input: RefinementStallInput,
  ): Promise<'delivered' | 'queued' | 'unavailable' | 'failed'> {
    const { ctx, projects } = this.deps;
    try {
      const config = await projects.config(input.projectKey);
      if (
        !coordinationMemberOf(config) ||
        !config.team.limits.aiEnabled ||
        isWorkPaused(ctx.repos.pauses.open(), input.projectKey)
      )
        return 'unavailable';
      // Nothing left to report: the turn changed or the member works again since the runtime looked.
      if (!this.refinementStall(config, input)) return 'delivered';
      const signal = this.raise({
        projectKey: input.projectKey,
        kind: 'refinement_stalled',
        caseKey: refinementStallCaseKey(input),
        taskKey: input.taskKey,
        subject: input.label,
      });
      await this.deliver(input.projectKey);
      const current = ctx.repos.operatorSignals.get(signal.id);
      return !current || current.resolvedAt || current.deliveredAt ? 'delivered' : 'queued';
    } catch {
      return 'failed';
    }
  }

  /**
   * The facts of a stalled refinement turn when it still stands, else null: the one rule
   * (`refinementStallRefusal`) read from the card, its recorded turn, the member's sessions and the open
   * questions of the card now.
   */
  private refinementStall(config: ProjectConfig, input: RefinementStallInput): RefinementStallFacts | null {
    const { ctx, sessions } = this.deps;
    const { projectKey, taskKey, label, member, turnAt } = input;
    const task = ctx.repos.tasks.get(taskKey);
    const inProject = task?.projectKey === projectKey ? task : null;
    const turn = ctx.repos.timeline.latestOfType(projectKey, taskKey, 'refinement_turn');
    const step = inProject ? refinementTurn(inProject, config) : null;
    const data = (turn?.data ?? {}) as Record<string, unknown>;
    const memberSessions = ctx.repos.sessions.list(projectKey, { member, taskKey });
    const questions = ctx.repos.inbox.list(projectKey, {
      state: PENDING_INBOX_STATES,
      kind: 'question',
      taskKey,
    });
    const refusal = refinementStallRefusal({
      taskOpen: !!inProject && isOpenTask(inProject),
      sameTurn:
        step?.kind === 'step' &&
        step.label === label &&
        !!turn &&
        turn.createdAt === turnAt &&
        data.label === label &&
        data.member === member &&
        data.reason !== 'done' &&
        data.reason !== 'stopped',
      labelMissing: !!inProject && !inProject.labels.includes(label),
      memberActive: memberSessions.some((s) => sessions.isRunning(s.id) && ENGAGED_STATES.has(s.state)),
      hasOpenQuestion: !turnStalled(questions, config),
    });
    if (refusal) return null;
    const latest = [...memberSessions].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
    return {
      label,
      member,
      turnAt,
      session: latest ? { id: latest.id, state: latest.state, lastActivityAt: latest.lastActivityAt } : null,
      openQuestionIds: questions.map((q) => q.id),
    };
  }

  presentation(projectKey: string, id: string, by?: string): OperatorSignalRecord {
    const signal = this.deps.ctx.repos.operatorSignals.get(id);
    if (!signal || signal.projectKey !== projectKey)
      throw invalid('invalid_request', 'unknown signal in this project');
    if (signal.kind === 'loop_suspected')
      throw invalid(
        'invalid_request',
        'use triage_loop for a suspected loop, not an owner signal presentation',
      );
    if (
      signal.resolvedAt ||
      signal.messageId ||
      !signal.deliveredAt ||
      signal.deliveredTo !== coordinationMemberOf(this.deps.projects.cachedConfig(projectKey)!)?.handle ||
      (by !== undefined && signal.deliveredTo !== by) ||
      !(signal.state === 'open' || signal.state === 'pending')
    )
      throw conflict('operator_signal_closed', 'the signal is no longer open for presentation');
    return signal;
  }

  present(projectKey: string, id: string, messageId: string, actionable: boolean): void {
    const signal = this.presentation(projectKey, id);
    this.save({ ...signal, state: 'open', messageId, actionable });
  }

  dismissByOperator(projectKey: string, id: string, by: string, note: string): OperatorSignal {
    const signal = this.deps.ctx.repos.operatorSignals.get(id);
    if (!signal || signal.projectKey !== projectKey)
      throw invalid('invalid_request', 'unknown signal in this project');
    if (!OPERATOR_DISMISSIBLE_SIGNAL_KINDS.includes(signal.kind))
      throw invalid('operator_signal_not_dismissible', 'the PM may not dismiss this signal kind');
    if (
      !signal.deliveredAt ||
      signal.deliveredTo !== by ||
      coordinationMemberOf(this.deps.projects.cachedConfig(projectKey)!)?.handle !== by ||
      signal.messageId ||
      signal.resolvedAt ||
      !['pending', 'open'].includes(signal.state) ||
      !this.caseHolds(this.deps.projects.cachedConfig(projectKey), signal)
    )
      throw conflict('operator_signal_closed', 'the signal is no longer open');
    const updated = {
      ...signal,
      state: 'dismissed' as const,
      decidedBy: by,
      decidedAt: isoNow(this.deps.ctx),
      decisionNote: note,
    };
    this.save(updated);
    return OperatorSignal.parse(updated);
  }

  decision(projectKey: string, id: string, by: string, accepted: boolean): OperatorSignal {
    const signal = this.deps.ctx.repos.operatorSignals.get(id);
    if (
      !signal ||
      signal.projectKey !== projectKey ||
      !signal.deliveredAt ||
      signal.state !== 'open' ||
      signal.resolvedAt ||
      (accepted && !signal.actionable)
    )
      throw conflict('operator_signal_closed', 'the signal is no longer open');
    const updated = {
      ...signal,
      state: accepted ? ('accepted' as const) : ('dismissed' as const),
      decidedBy: by,
      decidedAt: isoNow(this.deps.ctx),
    };
    this.save(updated);
    return OperatorSignal.parse(updated);
  }

  /**
   * What the signal lets the coordinator start without an owner's request (PM-545). The case must still hold
   * and the signal be open for the coordinator; a person on leave, a person and the coordinator itself are never targets.
   */
  async stepTargets(
    projectKey: string,
    signalId: string,
  ): Promise<{ signal: OperatorSignalRecord; allowed: OperatorSignalStepTargets }> {
    await this.deps.projects.config(projectKey);
    return this.currentStepTargets(projectKey, signalId);
  }

  /** The same facts at the synchronous write boundary, after asynchronous admission or git reads. */
  currentStepTargets(
    projectKey: string,
    signalId: string,
  ): { signal: OperatorSignalRecord; allowed: OperatorSignalStepTargets } {
    const { ctx, projects } = this.deps;
    const signal = ctx.repos.operatorSignals.get(signalId);
    if (!signal || signal.projectKey !== projectKey)
      throw invalid('invalid_request', 'unknown signal in this project');
    const config = projects.cachedConfig(projectKey)!;
    if (
      signal.resolvedAt ||
      !signal.deliveredAt ||
      signal.deliveredTo !== coordinationMemberOf(config)?.handle ||
      !(signal.state === 'open' || signal.state === 'pending') ||
      !this.caseHolds(config, signal)
    )
      throw conflict('operator_signal_closed', 'the signal is no longer open');
    return { signal, allowed: this.stepTargetsOf(config, signal) };
  }

  /** The targets by the case alone, whether or not the signal is open for the coordinator yet. */
  private stepTargetsOf(config: ProjectConfig, signal: OperatorSignalRecord): OperatorSignalStepTargets {
    const { ctx, taskWaits } = this.deps;
    const projectKey = signal.projectKey;
    const startable = (handles: readonly string[]) =>
      handles.filter((handle) => {
        const member = memberOf(config, handle);
        return member?.kind === 'ai' && !isOperator(member) && !isOnLeave(member);
      });
    const allowed: OperatorSignalStepTargets = { startTask: null, members: [], taskKey: null };
    const task = signal.taskKey ? ctx.repos.tasks.get(signal.taskKey) : null;
    if (signal.kind === 'idle' && task) {
      const stage = stageOf(config, task.stageId);
      const wait = taskWaits.ofCard(config, task);
      const holders = stage && wait ? startable(this.idleHolders(config, stage, wait)) : [];
      if (stage?.kind === 'work') allowed.startTask = holders.includes(task.assignee ?? '') ? task.key : null;
      else {
        allowed.members = holders;
        allowed.taskKey = task.key;
      }
    } else if ((signal.kind === 'merge_waiting' || signal.kind === 'merge_blocked') && task) {
      const merger = ctx.repos.taskMerges.open(projectKey, task.key)?.merger;
      allowed.members = merger ? startable([merger]) : [];
      allowed.taskKey = task.key;
    } else if (signal.kind === 'unreleased') {
      allowed.members = startable(dutyMembers(config, 'deployment').map((m) => m.handle));
    } else if (signal.kind === 'ready_waiting') {
      allowed.members = startable(projectManagersOf(config).map((m) => m.handle));
    } else if (signal.kind === 'answer_stalled' && task) {
      const stage = stageOf(config, task.stageId);
      const wait = taskWaits.ofCard(config, task);
      const ready =
        !task.fixLimit &&
        (wait?.reason === 'assignee' || wait?.reason === 'queued') &&
        (stage?.gate?.conditions ?? []).every((condition) => conditionHolds(task, condition)) &&
        openPrerequisites(task, ctx.repos.tasks.list(projectKey)).length === 0;
      allowed.members =
        ready && task.assignee === answerStalledMember(signal.caseKey) ? startable([task.assignee!]) : [];
      allowed.taskKey = task.key;
    }
    return allowed;
  }

  /** The one step a signal allows at this level, as the coordinator is told (the budget is told apart). */
  private stepOf(level: OperatorWatch, config: ProjectConfig, signal: OperatorSignalRecord) {
    if (!OPERATOR_SIGNAL_STEP_KINDS[level].includes(signal.kind)) return null;
    const allowed = this.stepTargetsOf(config, signal);
    if (allowed.startTask) return { tool: 'start_task' as const, task_key: allowed.startTask, members: [] };
    return allowed.members.length
      ? { tool: 'start_member' as const, task_key: allowed.taskKey, members: allowed.members }
      : null;
  }

  /** The coordinator took a step on the signal: it is shown again if the case still stands in half an hour. */
  stepTaken(signalId: string): void {
    const at = this.deps.ctx.now().getTime() + OPERATOR_SIGNAL_STEP_GAP_MINUTES * 60_000;
    this.deps.ctx.repos.operatorSignals.followUp(signalId, new Date(at).toISOString());
  }

  /** Delivered, unresolved signals still awaiting presentation or a decision, oldest first. */
  active(projectKey: string): OperatorSignal[] {
    return this.deps.ctx.repos.operatorSignals
      .list(projectKey)
      .filter(
        (s) =>
          s.deliveredAt !== null && s.resolvedAt === null && (s.state === 'pending' || s.state === 'open'),
      )
      .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt))
      .map((s) => OperatorSignal.parse(s));
  }

  channel(projectKey: string): { signals: OperatorSignal[]; openSignals: number } {
    const all = this.deps.ctx.repos.operatorSignals.list(projectKey);
    const since = this.deps.ctx.now().getTime() - 7 * 24 * 60 * 60_000;
    return {
      signals: all
        .filter((s) => s.deliveredAt && s.state !== 'pending' && Date.parse(s.raisedAt) >= since)
        .map((s) => OperatorSignal.parse(s)),
      openSignals: all.filter((s) => s.deliveredAt && s.state === 'open' && !s.resolvedAt).length,
    };
  }

  /** Reconcile current card and session facts before attempting any queued wake-up. */
  async sweep(projectKey?: string): Promise<void> {
    for (const key of projectKey ? [projectKey] : this.deps.projects.summaries().map((p) => p.key)) {
      const config = await this.deps.projects.config(key);
      const cards = this.deps.ctx.repos.tasks.list(key);
      const active = new Set<string>();
      for (const [taskKey, wait] of this.deps.taskWaits.of(config, cards)) {
        if (wait?.reason !== 'nobody') continue;
        const task = cards.find((t) => t.key === taskKey)!;
        const caseKey = `nobody:${task.key}:${task.stageId}`;
        active.add(caseKey);
        this.raise({ projectKey: key, kind: 'nobody', caseKey, taskKey, subject: task.stageId });
      }
      for (const session of this.deps.ctx.repos.sessions.list(key)) {
        if (
          session.state !== 'working' ||
          this.deps.ctx.now().getTime() - Date.parse(session.lastActivityAt) <
            OPERATOR_SILENT_WORK_MINUTES * 60_000
        )
          continue;
        const caseKey = `silent:${session.id}`;
        active.add(caseKey);
        this.raise({
          projectKey: key,
          kind: 'silent',
          caseKey,
          subject: session.id,
          taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
        });
      }
      for (const input of this.boardCases(config, cards).values()) {
        active.add(input.caseKey);
        // A card may re-enter between sweeps with the same set key after dismissal.
        if (
          input.kind === 'ready_waiting' &&
          this.deps.ctx.repos.operatorSignals.openByCase(key, input.caseKey)?.state === 'dismissed'
        )
          this.resolve(key, input.caseKey);
        this.raise(input);
      }
      const outages = this.deps.activeOutageIds(key);
      for (const signal of this.deps.ctx.repos.operatorSignals.list(key)) {
        if (signal.kind === 'outage' && outages !== null && !outages.has(signal.subject ?? ''))
          this.resolve(key, signal.caseKey);
        if (
          (signal.kind === 'nobody' || signal.kind === 'silent' || BOARD_KINDS.has(signal.kind)) &&
          !active.has(signal.caseKey)
        )
          this.resolve(key, signal.caseKey);
        if (signal.kind === 'refinement_stalled' && !signal.resolvedAt && !this.caseHolds(config, signal))
          this.resolve(key, signal.caseKey);
        if (
          signal.kind === 'stalled' &&
          this.deps.ctx.repos.sessions.get(signal.subject ?? '')?.state !== 'waiting_input'
        )
          this.resolve(key, signal.caseKey);
      }
      await this.deliver(key);
    }
  }

  rebuild(spec: { kind: 'operator_signals'; projectKey: string }): OperatorWakeStart | null {
    return this.pending(spec.projectKey).length ? this.start(spec.projectKey) : null;
  }

  /** A recipient change or leave invalidates unpresented delivery, without touching earlier human decisions. */
  recheckRecipients(projectKey: string): void {
    const config = this.deps.projects.cachedConfig(projectKey);
    const recipient = config && coordinationMemberOf(config)?.handle;
    for (const signal of this.deps.ctx.repos.operatorSignals.list(projectKey))
      if (
        !signal.resolvedAt &&
        !signal.messageId &&
        ['pending', 'open'].includes(signal.state) &&
        signal.deliveredTo &&
        signal.deliveredTo !== recipient
      )
        this.save({ ...signal, deliveredTo: null }, false);
  }

  /** The coordinator finished its turn, or startup recovered a turn that ended before being recorded. */
  finish(projectKey: string): void {
    for (const signal of this.deps.ctx.repos.operatorSignals.list(projectKey))
      if (signal.state === 'pending' && signal.deliveredAt) this.save({ ...signal, state: 'open' });
  }

  async deliver(projectKey: string): Promise<void> {
    if (this.waking.has(projectKey) || !this.wakeable(projectKey).length) return;
    this.waking.add(projectKey);
    try {
      await this.deps.admission.attempt(this.start(projectKey));
      // The CLI may still wait for its first input. Waiting must release admission's lock so
      // permission decisions, pause and the rest of the project's starts can proceed.
      await this.firstDeliveries.get(projectKey);
    } finally {
      this.firstDeliveries.delete(projectKey);
      this.waking.delete(projectKey);
    }
  }

  private pending(projectKey: string): OperatorSignalRecord[] {
    const { ctx, projects } = this.deps;
    const now = ctx.now().getTime();
    let board: Map<string, SignalInput> | undefined;
    return ctx.repos.operatorSignals.list(projectKey).filter((s) => {
      if (s.resolvedAt) return false;
      // A signal the coordinator took a step on is shown again once its follow-up time has come (PM-545).
      const config = projects.cachedConfig(projectKey);
      const recipient = config && coordinationMemberOf(config)?.handle;
      // A proposal already shown to a person stays on its original decision path during handover.
      if (s.messageId && s.deliveredTo !== recipient) return false;
      const rebound =
        !s.messageId && (s.state === 'pending' || s.state === 'open') && s.deliveredTo !== recipient;
      const again =
        s.followUpAt !== null &&
        Date.parse(s.followUpAt) <= now &&
        (s.state === 'pending' || s.state === 'open');
      if (!again && !rebound && (s.state !== 'pending' || s.deliveredAt)) return false;
      const valid = this.caseHolds(config, s, () => {
        board ??= config ? this.boardCases(config, ctx.repos.tasks.list(projectKey)) : new Map();
        return board;
      });
      if (!valid) {
        this.resolve(projectKey, s.caseKey);
        return false;
      }
      // Free capacity is raised at once but wakes the coordinator only if it lasts (PM-547).
      return !(
        s.kind === 'ready_waiting' &&
        !again &&
        now - Date.parse(s.raisedAt) < OPERATOR_READY_WAITING_MINUTES * 60_000
      );
    });
  }

  /** Whether the case of the signal still stands, read from the cards, merges, sessions and releases now. */
  private caseHolds(
    config: ProjectConfig | undefined,
    s: OperatorSignalRecord,
    board: () => Map<string, SignalInput> = () =>
      config ? this.boardCases(config, this.deps.ctx.repos.tasks.list(s.projectKey)) : new Map(),
  ): boolean {
    const { ctx, taskWaits } = this.deps;
    if (s.kind === 'loop_suspected') {
      const facts = LoopTriageFacts.parse(JSON.parse(s.subject!));
      const loop = ctx.repos.taskLoops.get(facts.loopId);
      return (
        !!loop &&
        !loop.endedAt &&
        loop.phase === 'notified' &&
        loop.triage?.generation === facts.generation &&
        !loop.triage.assessed
      );
    }
    if (BOARD_KINDS.has(s.kind)) return board().has(s.caseKey);
    if (s.kind === 'nobody') {
      const task = s.taskKey ? ctx.repos.tasks.get(s.taskKey) : null;
      return (
        !!task &&
        !!config &&
        task.stageId === s.subject &&
        taskWaits.ofCard(config, task)?.reason === 'nobody'
      );
    }
    if (s.kind === 'refinement_stalled') {
      const stall = refinementStallOf(s.projectKey, s.caseKey);
      return !!config && !!stall && !!this.refinementStall(config, stall);
    }
    if (s.kind === 'silent' || s.kind === 'stalled') {
      const session = ctx.repos.sessions.get(s.subject ?? '');
      return (
        !!session &&
        (s.kind === 'stalled'
          ? session.state === 'waiting_input'
          : session.state === 'working' &&
            ctx.now().getTime() - Date.parse(session.lastActivityAt) >= OPERATOR_SILENT_WORK_MINUTES * 60_000)
      );
    }
    return true;
  }
  /**
   * The cases of the board kinds that hold now (PM-547), read from the cards, merges, sessions and releases
   * only; the sweep raises and closes by it and `pending` checks a signal against it before waking anyone.
   */
  private boardCases(config: ProjectConfig, cards: readonly Task[]): Map<string, SignalInput> {
    const { ctx, taskWaits, admission, sessions, releases } = this.deps;
    const projectKey = config.project.key;
    const now = ctx.now().getTime();
    const found = new Map<string, SignalInput>();
    const add = (input: Omit<SignalInput, 'projectKey'>) =>
      found.set(input.caseKey, { projectKey, ...input });
    const works = config.team.limits.aiEnabled && !isWorkPaused(ctx.repos.pauses.open(), projectKey);
    const aiMember = (handle: string) => {
      const member = memberOf(config, handle);
      return member?.kind === 'ai' ? member : null;
    };
    const waits = taskWaits.of(config, cards);

    if (works) {
      const activeAt = new Map<string, number>();
      for (const session of ctx.repos.sessions.list(projectKey)) {
        if (session.workItem.type !== 'task') continue;
        const at = Math.max(
          Date.parse(session.lastActivityAt),
          session.endedAt ? Date.parse(session.endedAt) : 0,
        );
        activeAt.set(session.workItem.taskKey, Math.max(activeAt.get(session.workItem.taskKey) ?? 0, at));
      }
      for (const task of cards) {
        const wait = waits.get(task.key);
        const stage = stageOf(config, task.stageId);
        if (!wait || !stage || (stage.kind !== 'work' && stage.kind !== 'step')) continue;
        const holders = this.idleHolders(config, stage, wait);
        const idleSince = Math.max(Date.parse(wait.since), activeAt.get(task.key) ?? 0);
        if (holders.length === 0 || now - idleSince < OPERATOR_IDLE_MINUTES * 60_000) continue;
        add({
          kind: 'idle',
          caseKey: `idle:${task.key}:${task.stageId}`,
          taskKey: task.key,
          subject: holders.join(','),
        });
      }
      for (const row of ctx.repos.taskMerges.list('requested')) {
        if (
          row.projectKey !== projectKey ||
          row.startedAt ||
          !aiMember(row.merger) ||
          now - Date.parse(row.requestedAt) < OPERATOR_MERGE_WAIT_MINUTES * 60_000
        )
          continue;
        add({
          kind: 'merge_waiting',
          caseKey: `merge_waiting:${row.taskKey}`,
          taskKey: row.taskKey,
          subject: row.merger,
        });
      }
      for (const task of cards) {
        const stage = stageOf(config, task.stageId);
        const member = task.assignee ? aiMember(task.assignee) : null;
        if (
          !member ||
          isOnLeave(member) ||
          !isOpenTask(task) ||
          isTheme(task) ||
          (stage?.kind !== 'work' && stage?.kind !== 'step')
        )
          continue;
        const stall = this.answerStall(projectKey, task, member.handle);
        if (!stall.evidence) continue;
        const caseKey = `answer_stalled:${task.key}:${member.handle}:${stall.evidence.id}`;
        if (this.mutedAnswerStall(projectKey, task.key, member.handle, caseKey)) continue;
        add({ kind: 'answer_stalled', caseKey, taskKey: task.key, subject: stall.evidence.id });
      }
    }

    for (const state of ['failed', 'blocked'] as const)
      for (const row of ctx.repos.taskMerges.list(state)) {
        if (row.projectKey !== projectKey || !aiMember(row.merger)) continue;
        add({
          kind: 'merge_blocked',
          caseKey: `merge_blocked:${row.taskKey}`,
          taskKey: row.taskKey,
          subject: row.failure?.reason ?? row.block?.reason ?? state,
        });
      }

    const unreleased = releases.unreleased(projectKey);
    if (unreleased && now - Date.parse(unreleased.oldestAt) >= OPERATOR_UNRELEASED_HOURS * 3_600_000)
      add({
        kind: 'unreleased',
        caseKey: `unreleased:${unreleased.base}`,
        taskKey: null,
        subject: String(unreleased.taskKeys.length),
      });

    if (works && !aiLimitReached(config, sessions.busyCount())) {
      const ready: Task[] = [];
      for (const [index, stage] of config.pipeline.stages.entries()) {
        const next = config.pipeline.stages[index + 1];
        if (index <= 0 || next?.kind !== 'work' || stage.kind !== 'queue') continue;
        const free = stageOwners(config, next).some((handle) => {
          const member = aiMember(handle);
          if (
            member &&
            !isOnLeave(member) &&
            !member.temp &&
            admission.memberLoad(config, handle) < member.capacity
          )
            return true;
          return false;
        });
        if (free)
          ready.push(
            ...startableCards({ config, tasks: cards, fromStageId: stage.id, toStageId: next.id }).filter(
              (task) => waits.get(task.key)?.reason === 'ready',
            ),
          );
      }
      const ack = ctx.repos.operatorSignals.latestDismissed(projectKey, 'ready_waiting');
      if (ready.some((task) => !this.acknowledged(task, ack))) {
        const keys = ready
          .map((task) => task.key)
          .sort((a, b) => Number(a.split('-').at(-1)) - Number(b.split('-').at(-1)));
        add({
          kind: 'ready_waiting',
          caseKey: 'ready_waiting:' + keys.join(','),
          taskKey: null,
          subject: keys.join(','),
        });
      }
    }
    return found;
  }

  /**
   * Whether something reached the assignee after their last proven step and they have not worked since
   * (PM-694), read from receipts, sessions and the card's own timeline only; never from the chat text.
   */
  private answerStall(
    projectKey: string,
    task: Task,
    member: string,
  ): { evidence: AnswerEvidence | null; all: AnswerEvidence[]; lastStepAt: number | null } {
    const { ctx } = this.deps;
    const sessions = ctx.repos.sessions.list(projectKey, { member, taskKey: task.key });
    let lastStepAt: number | null = null;
    const step = (at: number) => {
      if (!Number.isNaN(at) && (lastStepAt === null || at > lastStepAt)) lastStepAt = at;
    };
    for (const session of sessions)
      if (session.workMetadata?.lastWorkAt) step(Date.parse(session.workMetadata.lastWorkAt));
    // The card's own timeline is the sure fallback; the member's questions and a label put on by the
    // system are no work, and neither is anything that reached them.
    for (const event of ctx.repos.timeline.list(projectKey, { taskKey: task.key, limit: CARD_EVENTS_READ })) {
      if (event.actor.kind !== 'ai' || event.actor.handle !== member || !MEMBER_WORK_EVENTS.has(event.type))
        continue;
      if (event.type === 'task_labels_changed') {
        const added = (event.data.added as string[] | undefined) ?? [];
        const removed = (event.data.removed as string[] | undefined) ?? [];
        if (removed.length === 0 && added.every((label) => label === WAITING_ANSWER_LABEL)) continue;
      }
      step(Date.parse(event.createdAt));
    }
    const busy = (state: string) => sessions.some((s) => s.state === state);
    const idleSince = sessions
      .filter((s) => !['working', 'starting', 'waiting_input'].includes(s.state))
      .reduce((max, s) => Math.max(max, Date.parse(s.endedAt ?? s.stateSince ?? s.lastActivityAt) || 0), 0);
    // What reached the member before the card entered its stage belongs to the stage it left.
    const enteredAt = task.stageEnteredAt ? Date.parse(task.stageEnteredAt) : 0;
    const all = answerEvidenceOf(ctx, projectKey, task.key, member).filter(
      (e) => !(enteredAt > Date.parse(e.at)),
    );
    const openQuestion =
      ctx.repos.inbox
        .list(projectKey, { state: PENDING_INBOX_STATES, kind: 'question', taskKey: task.key })
        .filter((item) => item.source === member).length > 0;
    return {
      all,
      lastStepAt,
      evidence: answerStallEvidence({
        now: ctx.now().getTime(),
        labelled: task.labels.includes(WAITING_ANSWER_LABEL),
        openQuestion,
        permissionWaiting: busy('waiting_permission'),
        working: busy('working') || busy('starting'),
        waitingInput: busy('waiting_input'),
        idleSince,
        lastStepAt,
        evidence: all,
      }),
    };
  }

  /**
   * A card and member stay quiet for half an hour after the coordinator's own step on any earlier signal of
   * theirs (PM-694), so new evidence is no unlimited authority. The open signal of the case itself is never
   * muted (its follow-up stays), but a case that came back after its signal closed counts its steps all
   * together: once they used up the largest step budget it stays quiet.
   */
  private mutedAnswerStall(projectKey: string, taskKey: string, member: string, caseKey: string): boolean {
    const { ctx } = this.deps;
    const since = ctx.now().getTime() - OPERATOR_ANSWER_STALL_MUTE_MINUTES * 60_000;
    const earlier = ctx.repos.operatorSignals
      .list(projectKey)
      .filter(
        (s) =>
          s.kind === 'answer_stalled' && s.taskKey === taskKey && answerStalledMember(s.caseKey) === member,
      );
    if (earlier.some((s) => s.caseKey === caseKey && !s.resolvedAt)) return false;
    let sameCaseSteps = 0;
    for (const s of earlier) {
      const steps = ctx.repos.operatorRequests
        .stepsOfSignal(s.id)
        .filter((step) => step.status !== 'refused');
      if (s.caseKey === caseKey) sameCaseSteps += steps.length;
      if (steps.some((step) => Date.parse(step.at) > since)) return true;
    }
    return sameCaseSteps >= OPERATOR_SIGNAL_STEPS.drive;
  }

  private refinementStallFacts(config: ProjectConfig, signal: OperatorSignalRecord) {
    const stall = refinementStallOf(signal.projectKey, signal.caseKey);
    return stall ? this.refinementStall(config, stall) : null;
  }

  private answerStalledFacts(signal: OperatorSignalRecord): AnswerStalledFacts | null {
    const member = answerStalledMember(signal.caseKey);
    const task = signal.taskKey ? this.deps.ctx.repos.tasks.get(signal.taskKey) : null;
    if (!member || !task) return null;
    const stall = this.answerStall(signal.projectKey, task, member);
    const evidence = stall.all.find((e) => e.id === signal.subject);
    if (!evidence) return null;
    return {
      evidenceId: evidence.id,
      evidenceAt: evidence.at,
      member,
      lastActionAt: stall.lastStepAt === null ? null : new Date(stall.lastStepAt).toISOString(),
    };
  }

  /** The latest dismissal covers cards that have not re-entered their stage since it. */
  private acknowledged(task: Task, ack: OperatorSignalRecord | null): boolean {
    return (
      !!ack?.decidedAt &&
      !!ack.subject?.split(',').includes(task.key) &&
      (task.stageEnteredAt ?? task.createdAt) <= ack.decidedAt
    );
  }

  private readyFacts(signal: OperatorSignalRecord) {
    const ack = this.deps.ctx.repos.operatorSignals.latestDismissed(signal.projectKey, 'ready_waiting');
    const cards = signal.subject?.split(',') ?? [];
    return {
      cards,
      new_cards: cards.filter((key) => {
        const task = this.deps.ctx.repos.tasks.get(key);
        return task && !this.acknowledged(task, ack);
      }),
      last_dismissed: ack
        ? {
            at: ack.decidedAt,
            by: ack.decidedBy,
            note: ack.decisionNote,
            cards: ack.subject?.split(',') ?? [],
          }
        : null,
    };
  }

  /** The AI members, not on leave, that hold an idle card: its assignee, or the owners of the step it stands in. */
  private idleHolders(config: ProjectConfig, stage: Stage, wait: TaskWait): string[] {
    const available = (handles: readonly string[]) =>
      handles.filter((handle) => {
        const member = memberOf(config, handle);
        return member?.kind === 'ai' && !isOnLeave(member);
      });
    if (wait.reason === 'assignee') return available(wait.next.map((entry) => entry.handle));
    if (wait.reason !== 'queued') return [];
    if (wait.next.length > 0) return available(wait.next.map((entry) => entry.handle));
    return stage.kind === 'step' ? available(stageOwners(config, stage)) : [];
  }
  /**
   * The pending signals whose line may wake the coordinator now (PM-694): the general line waits
   * `OPERATOR_SIGNAL_WAKE_INTERVAL_MS` after its last delivery, the fast line (`answer_stalled`) only
   * `OPERATOR_ANSWER_STALL_WAKE_MS` after its own. Each line counts the deliveries of its own kinds.
   */
  private wakeable(projectKey: string): OperatorSignalRecord[] {
    const now = this.deps.ctx.now().getTime();
    const delivered = (fast: boolean) =>
      this.deps.ctx.repos.operatorSignals
        .list(projectKey)
        .flatMap((s) =>
          s.deliveredAt && OPERATOR_FAST_SIGNAL_KINDS.includes(s.kind) === fast
            ? [Date.parse(s.deliveredAt)]
            : [],
        )
        .sort((a, b) => b - a)[0];
    const due = (fast: boolean) => {
      const last = delivered(fast);
      return (
        last === undefined ||
        now - last >= (fast ? OPERATOR_ANSWER_STALL_WAKE_MS : OPERATOR_SIGNAL_WAKE_INTERVAL_MS)
      );
    };
    const signals = this.pending(projectKey);
    if (!signals.length) return signals;
    const dueFast = due(true);
    const dueGeneral = due(false);
    const config = this.deps.projects.cachedConfig(projectKey);
    const recipient = config && coordinationMemberOf(config)?.handle;
    return signals.filter(
      (s) =>
        (s.deliveredAt && s.deliveredTo !== recipient) ||
        (OPERATOR_FAST_SIGNAL_KINDS.includes(s.kind) ? dueFast : dueGeneral),
    );
  }
  private save(signal: OperatorSignalRecord, publish = true): void {
    this.deps.ctx.repos.operatorSignals.save(signal);
    if (publish && signal.deliveredAt && signal.state !== 'pending')
      this.deps.ctx.bus.publish({
        type: 'operator_signal',
        projectKey: signal.projectKey,
        signal: OperatorSignal.parse(signal),
      });
  }
  private start(projectKey: string): OperatorWakeStart {
    const { ctx, projects, sessions, admission, delivery } = this.deps;
    return {
      key: `operator-signals:${projectKey}`,
      projectKey,
      taskKey: null,
      spec: () => ({ kind: 'operator_signals', projectKey }),
      stillValid: () => this.pending(projectKey).length > 0,
      waitsFor: () => coordinationMemberOf(projects.cachedConfig(projectKey)!)?.handle,
      retry: () => this.deliver(projectKey),
      log: {
        deferred: 'operator signal start deferred',
        retryFailed: 'operator signal retry failed',
        fields: () => ({ projectKey }),
      },
      run: async () => {
        if (!this.wakeable(projectKey).length) return;
        const config = await projects.config(projectKey);
        const member = coordinationMemberOf(config);
        if (!member) return;
        if (isWorkPaused(ctx.repos.pauses.open(), projectKey))
          throw conflict('team_paused', 'the team is paused');
        const signals = this.wakeable(projectKey);
        if (!signals.length) return;
        const level = operatorWatchOf(config);
        const now = isoNow(ctx);
        const text =
          `${WAKE_HEADERS[level]} ${WAKE_LOOP}\n` +
          signals
            .map((s) => {
              const steps = ctx.repos.operatorRequests.stepsOfSignal(s.id);
              const budget =
                s.kind === 'loop_suspected'
                  ? { left: 0, nextAt: null }
                  : operatorSignalBudget(
                      level,
                      steps.filter((step) => step.status !== 'refused').map((step) => step.at),
                      now,
                    );
              return JSON.stringify({
                ...OperatorSignal.parse(s),
                facts:
                  s.kind === 'loop_suspected'
                    ? LoopTriageFacts.parse(JSON.parse(s.subject!))
                    : s.kind === 'ready_waiting'
                      ? this.readyFacts(s)
                      : s.kind === 'answer_stalled'
                        ? this.answerStalledFacts(s)
                        : s.kind === 'refinement_stalled'
                          ? { refinement: this.refinementStallFacts(config, s) }
                          : s.inboxItemId
                            ? ctx.repos.inbox.get(s.inboxItemId)?.payload
                            : s.subject
                              ? ctx.repos.sessions.get(s.subject)?.activity
                              : null,
                step: this.stepOf(level, config, s),
                steps_left: budget.left,
                next_step_at: budget.nextAt,
                steps: steps.map((step) => ({
                  at: step.at,
                  by:
                    ctx.repos.sessions.get(ctx.repos.operatorRequests.get(step.requestId)?.sessionId ?? '')
                      ?.member ?? null,
                  member: step.member,
                  task_key: step.taskKey,
                  status: step.status,
                })),
                follow_up: steps.length > 0,
              });
            })
            .join('\n');
        const workItem = { type: 'general' } as const;
        // A signal shown again after an own step is shown from the start (PM-545): the coordinator may present it anew.
        const markDelivered = () =>
          ctx.unitOfWork(() => {
            if (coordinationMemberOf(projects.cachedConfig(projectKey)!)?.handle !== member.handle) return;
            const at = isoNow(ctx);
            ctx.repos.operatorSignals.delivered(
              signals.filter((s) => s.followUpAt === null).map((s) => s.id),
              at,
              member.handle,
            );
            ctx.repos.operatorSignals.redelivered(
              signals
                .filter((s) => {
                  const current = ctx.repos.operatorSignals.get(s.id);
                  return (
                    s.followUpAt !== null &&
                    current?.followUpAt === s.followUpAt &&
                    current.messageId === s.messageId &&
                    current.deliveredTo === s.deliveredTo
                  );
                })
                .map((s) => s.id),
              at,
              member.handle,
            );
          });
        const running = sessions.findRunning(projectKey, member.handle, workItem);
        if (running && !sessions.isPaused(running)) {
          if (!(await delivery.notice(running, 'projectman', text, null)))
            throw new Error('operator signal delivery failed');
        } else {
          let firstInput: Promise<boolean> | undefined;
          await delivery.startAndDeliver(projectKey, member.handle, workItem, async (messages) => {
            const result = await admission.start({
              config,
              member,
              workItem,
              cause: { kind: 'operator_signal' },
              messages: [...messages, formatInjectedTeamMessage('projectman', text, null)],
            });
            firstInput = result.firstInput;
            return result;
          });
          const delivered = firstInput!.then((typed) => {
            if (!typed) throw new Error('operator signal first input was not delivered');
            markDelivered();
            const current = sessions.findRunning(projectKey, member.handle, workItem);
            if (!current || current.state === 'idle') this.finish(projectKey);
          });
          // Install a rejection handler before the admission attempt releases its lock.
          void delivered.catch(() => undefined);
          this.firstDeliveries.set(projectKey, delivered);
          return;
        }
        markDelivered();
      },
    };
  }
}
