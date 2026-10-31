import type { OperatorSessions } from './ports';
import {
  answerStallEvidence,
  conditionHolds,
  dutyMembers,
  isOpenTask,
  isTheme,
  isCoordinatorOnlySignal,
  OPERATOR_ANSWER_STALL_MUTE_MINUTES,
  OPERATOR_ANSWER_STALL_WAKE_MS,
  OPERATOR_FAST_SIGNAL_KINDS,
  PENDING_INBOX_STATES,
  WAITING_ANSWER_LABEL,
  OPERATOR_DISMISSIBLE_SIGNAL_KINDS,
  memberQueueSourceId,
  coordinationMemberOf,
  OPERATOR_SIGNAL_STEP_GAP_MINUTES,
  OPERATOR_SIGNAL_STEPS,
  OPERATOR_UNRELEASED_HOURS,
  operatorSignalBudget,
  operatorSignalStepAllowed,
  operatorSignalStepGapMs,
  operatorWatchOf,
  OperatorSignal,
  LoopTriageFacts,
  OPERATOR_SIGNAL_WAKE_INTERVAL_MS,
  isOnLeave,
  isWorkPaused,
  memberOf,
  openPrerequisites,
  stageOf,
  OPERATOR_SILENT_WORK_MINUTES,
  OPERATOR_START_FETCH_FAILED_MINUTES,
  START_BLOCKED_REASONS,
  StartBlockedFacts,
} from '@projectman/shared';
import type {
  AnswerEvidence,
  AnswerStalledFacts,
  ObligationOverdueFacts,
  OperatorSignalKind,
  OperatorSignalStepTargets,
  OperatorWatch,
  ProjectConfig,
  StartBlockedReason,
  Task,
  TaskStartWaiting,
  TimelineEvent,
} from '@projectman/shared';
import type { OperatorSignalRecord } from '../../db';
import {
  StructuralPatterns,
  STRUCTURAL_KINDS,
  STRUCTURAL_WINDOW_MS,
  patternSubject,
  structuralKind,
} from './structural-patterns';
import type { StructuralEvaluation, StructuralFacts } from './structural-patterns';
import type { DomainContext } from '../../core/base';
import { isoNow } from '../../core/base';
import { answerEvidenceOf } from '../../core/messages';
import type { InboxService } from '../../core/inbox';
import type { MemberQueue } from '../../core/member-queue';
import type { ProjectService } from '../../core/projects';
import { prerequisiteCards } from '../../core/tasks';
import type { TaskWaits } from '../../core/tasks';
import type { TaskSchedulingReader, UnreleasedWork } from '../../contracts';
import { KeyedMutex, conflict, invalid } from '../../kernel';
import { newId } from '../../kernel';

/** Why a queued signal is held back: its own wake line is not due, or it is not owed now (`heldBack`). */
type SignalHold = 'interval' | 'unready';

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
  'merge_blocked',
  'unreleased',
  'answer_stalled',
]);

/**
 * The kinds of the stall detectors PM-1152 removed: nothing raises them any more, so an open row an older build
 * left is resolved by the sweep (state, event and the questions asked about it, as for any ended case).
 */
const RETIRED_KINDS: ReadonlySet<OperatorSignalKind> = new Set([
  'idle',
  'merge_waiting',
  'ready_waiting',
  'refinement_stalled',
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

/** The queue item of a signal shown before to another binding (or after a leave) is a new item: this marks its source. */
const REBOUND_PREFIX = 'rebound:';

const WAKE_NEVER =
  "On a signal never merge, release, approve, move a card, or set a label or a setting. When a stalled, silent, outage or nobody signal needs someone to act, open an integrator todo with open_integrator_todo (what, where, expected) instead of asking the owners; when the card is already followed (obligation_tracked), leave it. A decision only the owners make (cost, deletion, publishing, direction, approval) goes to them with ask_human; a process_cleanup_failed signal goes to the owners. Never stop another member's processes yourself.";
const WAKE_ONE_MESSAGE =
  'Send the owners one message for the whole wake-up (send_message with signal_ids, excluding structural_pattern and milestone_closed; the signals to decide in actionable_signal_ids); write nothing if you did nothing and nothing needs a decision.';
const WAKE_STRUCTURAL =
  'structural_pattern and milestone_closed are for you only: the owners never see them. Never put them in signal_ids. Weigh their evidence; use request_structural_review if a review would help. Name only those worth a review in your one summary message as one short list with card keys and the reason; otherwise write nothing about them. Close every one you do not propose a review on with dismiss_signal and a short note.';
const WAKE_CHECK =
  'Projectman system signals. Check get_project_state and session activity first. Read get_task before referring to a card; distinguish active work, actual decision waits and normal offline queued work. Diagnose the cause, take only the smallest permitted coordination step, consider machine load and verify the result. Group related decisions in the single summary; screening and signals are not owner requests and grant no settings or critical-operation authority.';
const WAKE_LOOP =
  'A loop_suspected signal is report-only: inspect current card, commits, review findings and delivery; call triage_loop with evidence and progress or loop. Message count alone is no loop. Never present it to owners as an authorization request, stop work or choose stop/let_run.';
const WAKE_STEP =
  'Where a signal has a step, you may take it yourself with its signal_id after weighing it, within steps_left and not before next_step_at; a signal with follow_up true was acted on, so tell the owners what you did and what became of it.';
const WAKE_UNRELEASED =
  "An unreleased signal is the one exception at every level: take its step (start_member on the deployment member, once per 24 hours) and do not bring it to the owners; the member asks the owner one question, and nothing live changes before the owner's yes.";
const WAKE_DISMISS =
  'An obligation_overdue signal says the responsible did not act even after the reminder, and that the step goes to a person at hand_over_at in its facts: check get_task and get_project_state first; when the situation is only intermediate or already resolved (the member works again, the label is on, a question is open, the card moved on) close it with dismiss_signal and a note and write nothing to the owners; otherwise take its step or leave it to go to the person.';

/** The wake-up text by level; it says in short what `projectManagerRule` (context/system-prompt.ts) says. */
const WAKE_HEADERS: Record<OperatorWatch, string> = {
  report: `${WAKE_CHECK} Change nothing until an owner says yes. ${WAKE_UNRELEASED} ${WAKE_DISMISS} ${WAKE_STRUCTURAL} ${WAKE_ONE_MESSAGE}`,
  unblock: `${WAKE_CHECK} ${WAKE_STEP} ${WAKE_UNRELEASED} ${WAKE_NEVER} ${WAKE_DISMISS} ${WAKE_STRUCTURAL} ${WAKE_ONE_MESSAGE}`,
  drive: `${WAKE_CHECK} ${WAKE_STEP} When steps_left is 0, bring the signal to the owners. ${WAKE_UNRELEASED} ${WAKE_NEVER} ${WAKE_DISMISS} ${WAKE_STRUCTURAL} ${WAKE_ONE_MESSAGE}`,
};

/** The case key of a card's blocked start: one per card and reason (PM-455). */
function startBlockedCaseKey(taskKey: string, reason: StartBlockedReason): string {
  return `start_blocked:${taskKey}:${reason}`;
}

/** The member of an `answer_stalled` case key: `answer_stalled:<taskKey>:<member>:<evidenceId>`. */
function answerStalledMember(caseKey: string): string | null {
  return caseKey.split(':')[2] ?? null;
}

/** The case key of an overdue obligation: one per obligation row (the row is unique for ever). */
function obligationOverdueCaseKey(obligationId: string): string {
  return `obligation_overdue:${obligationId}`;
}

type OpenMerge = ReturnType<DomainContext['repos']['taskMerges']['openOfProject']>[number];

/** What one pass over a project reads once and every check of that pass shares (PM-1120). */
interface BoardReads {
  waits: ReturnType<TaskWaits['of']>;
  /** The project's open merges by card. */
  merges: ReadonlyMap<string, OpenMerge>;
}

/** The board cases of a pass. */
interface BoardRead {
  cases: Map<string, SignalInput>;
}

/** One notice per system problem episode; notices never authorize a write. */
export class OperatorSignals {
  /** One sweep body per project at a time; a call that arrives while another run still waits for its turn joins that run. */
  private readonly sweepLocks = new KeyedMutex();
  private readonly queuedSweeps = new Map<string, { started: boolean; promise: Promise<void> }>();
  constructor(privateDeps: {
    ctx: DomainContext;
    projects: ProjectService;
    sessions: OperatorSessions;
    queue: Pick<MemberQueue, 'add'>;
    wake: (projectKey: string, member: string) => Promise<void>;
    taskWaits: TaskWaits;
    activeOutageIds: (projectKey: string) => ReadonlySet<string> | null;
    inbox: Pick<InboxService, 'list' | 'closeQuestionsOfSignal'>;
    startWaitingOf: (task: Task) => TaskStartWaiting | undefined;
    /** Whether a deferred start of the card is under a new attempt: its wait reads empty meanwhile. */
    startAttempting: (task: Task) => boolean;
    /** The work merged since each repository's last release (PM-1201); reads only. */
    unreleased: (projectKey: string) => UnreleasedWork[];
  }) {
    this.deps = privateDeps;
  }
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    sessions: OperatorSessions;
    /** The coordinator's work queue: a pending signal is an item of it. */
    queue: Pick<MemberQueue, 'add'>;
    /** Works the member's queue (the driver's `ensure`). */
    wake: (projectKey: string, member: string) => Promise<void>;
    taskWaits: TaskWaits;
    activeOutageIds: (projectKey: string) => ReadonlySet<string> | null;
    inbox: Pick<InboxService, 'list' | 'closeQuestionsOfSignal'>;
    /** Why the start of AI work on a stored card waits (PM-455): the scheduling reads carry no `startWaiting`. */
    startWaitingOf: (task: Task) => TaskStartWaiting | undefined;
    /** Whether a deferred start of the card is under a new attempt: its wait reads empty meanwhile. */
    startAttempting: (task: Task) => boolean;
    /** The work merged since each repository's last release (PM-1201); reads only. */
    unreleased: (projectKey: string) => UnreleasedWork[];
  };

  /** The targeted card reads (PM-771): the periodic work never lists the project's whole card history. */
  private readonly cardReader: TaskSchedulingReader = {
    readSchedulingTasks: (projectKey, query) => this.deps.ctx.repos.tasks.readScheduling(projectKey, query),
  };

  /** The cards that are not done or cancelled: everything the board cases and the waits are decided on. */
  private openCards(projectKey: string): Task[] {
    return this.cardReader.readSchedulingTasks(projectKey, { kind: 'open' });
  }

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
    // A question asked about the signal has nothing left to answer (PM-455).
    void this.deps.inbox.closeQuestionsOfSignal(projectKey, signal.id).catch(() => undefined);
  }

  /**
   * The pending signal of an obligation that reached its project manager rung (PM-1152): one per obligation
   * row, stored with the caller's write; `deliver` brings it to the project manager. Returns the signal id.
   */
  raiseObligationOverdue(input: { projectKey: string; taskKey: string; obligationId: string }): string {
    return this.raise({
      projectKey: input.projectKey,
      kind: 'obligation_overdue',
      caseKey: obligationOverdueCaseKey(input.obligationId),
      taskKey: input.taskKey,
      subject: input.obligationId,
    }).id;
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
    if (isCoordinatorOnlySignal(signal.kind))
      throw invalid(
        'invalid_request',
        'structural_pattern and milestone_closed signals are for you only: leave them out of signal_ids, name the ones worth a review in your message text, and close them with dismiss_signal',
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
    this.save({
      ...signal,
      state: 'open',
      messageId,
      actionable: structuralKind(signal.kind) ? false : actionable,
    });
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
        return member?.kind === 'ai' && !isOnLeave(member);
      });
    const allowed: OperatorSignalStepTargets = { startTask: null, members: [], taskKey: null };
    const task = signal.taskKey ? ctx.repos.tasks.get(signal.taskKey) : null;
    if (signal.kind === 'obligation_overdue' && task) {
      // The step is the responsible's: a work step is a start of the card, any other one a start of the member.
      const obligation = signal.subject ? ctx.repos.obligations.get(signal.subject) : null;
      const holders = obligation?.responsible ? startable([obligation.responsible]) : [];
      if (obligation?.kind === 'work')
        allowed.startTask = holders.includes(task.assignee ?? '') ? task.key : null;
      else {
        allowed.members = holders;
        allowed.taskKey = task.key;
      }
    } else if (signal.kind === 'merge_blocked' && task) {
      const merger = ctx.repos.taskMerges.open(projectKey, task.key)?.merger;
      allowed.members = merger ? startable([merger]) : [];
      allowed.taskKey = task.key;
    } else if (signal.kind === 'unreleased') {
      // A member who still waits for a person's answer is not started again: no second proposal beside an open one.
      const asking = new Set(
        this.deps.inbox
          .list(projectKey, { state: PENDING_INBOX_STATES, kind: 'question' })
          .map((item) => item.source),
      );
      allowed.members = startable(dutyMembers(config, 'deployment').map((m) => m.handle)).filter(
        (handle) => !asking.has(handle),
      );
    } else if (signal.kind === 'answer_stalled' && task) {
      const stage = stageOf(config, task.stageId);
      const wait = taskWaits.ofCard(config, task);
      const ready =
        !task.fixLimit &&
        (wait?.reason === 'assignee' || wait?.reason === 'queued') &&
        (stage?.gate?.conditions ?? []).every((condition) => conditionHolds(task, condition)) &&
        openPrerequisites(task, prerequisiteCards(this.cardReader, projectKey, task)).length === 0;
      allowed.members =
        ready && task.assignee === answerStalledMember(signal.caseKey) ? startable([task.assignee!]) : [];
      allowed.taskKey = task.key;
    } else if (signal.kind === 'start_blocked') {
      const facts = this.startBlockedFacts(config, signal);
      if (facts?.reason === 'workspace_dirty' && facts.member && facts.heldBy) {
        // The workspace stands on the held card's branch: the member's session there can finish or commit its work.
        allowed.members = startable([facts.member]);
        allowed.taskKey = facts.heldBy;
      } else if (facts?.reason === 'workspace_fetch_failed') {
        allowed.members = startable(dutyMembers(config, 'deployment').map((m) => m.handle));
        allowed.taskKey = signal.taskKey;
      }
    }
    return allowed;
  }

  /** The start wait of a card that a `start_blocked` signal speaks for, or null (PM-455). */
  private startBlockedReason(task: Task): StartBlockedReason | null {
    if (!isOpenTask(task) || isTheme(task)) return null;
    const reason = this.deps.startWaitingOf(task)?.reason;
    return START_BLOCKED_REASONS.find((r) => r === reason) ?? null;
  }

  /**
   * Whether the system is trying the card's deferred start right now. The wait reads empty for the length of the
   * attempt (a fetch may take a minute), which says nothing about the cause: the signal stays as it is (PM-455).
   */
  private startAttemptRunning(task: Task): boolean {
    return (
      isOpenTask(task) &&
      !isTheme(task) &&
      this.deps.startWaitingOf(task) === undefined &&
      this.deps.startAttempting(task)
    );
  }

  /**
   * The facts of a `start_blocked` signal while its case stands, else null. The git error text is not among
   * them: a remote URL in it may carry credentials, and the server log has it.
   */
  private startBlockedFacts(config: ProjectConfig, signal: OperatorSignalRecord): StartBlockedFacts | null {
    const { ctx } = this.deps;
    const task = signal.taskKey ? ctx.repos.tasks.get(signal.taskKey) : null;
    const waiting = task ? this.deps.startWaitingOf(task) : undefined;
    if (!task || !waiting || waiting.reason !== signal.subject || this.startBlockedReason(task) === null)
      return null;
    const reason = waiting.reason as StartBlockedReason;
    const branch = reason === 'repo_required' ? null : (waiting.branch ?? null);
    const heldBy =
      reason === 'workspace_dirty' && branch
        ? (this.openCards(signal.projectKey)
            .filter((card) => card.links.some((link) => link.kind === 'branch' && link.ref === branch))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.key ?? null)
        : null;
    return StartBlockedFacts.parse({
      reason,
      member: waiting.member ?? null,
      since: waiting.since,
      repos: reason === 'repo_required' ? config.project.repos.map((repo) => repo.name) : [],
      parentRepo:
        reason === 'repo_required' && task.parentKey
          ? (ctx.repos.tasks.get(task.parentKey)?.repo ?? null)
          : null,
      branch,
      heldBy,
    });
  }

  /** The one step a signal allows at this level, as the coordinator is told (the budget is told apart). */
  private stepOf(level: OperatorWatch, config: ProjectConfig, signal: OperatorSignalRecord) {
    if (!operatorSignalStepAllowed(level, signal.kind)) return null;
    const allowed = this.stepTargetsOf(config, signal);
    if (allowed.startTask) return { tool: 'start_task' as const, task_key: allowed.startTask, members: [] };
    return allowed.members.length
      ? { tool: 'start_member' as const, task_key: allowed.taskKey, members: allowed.members }
      : null;
  }

  /** The coordinator took a step on the signal: it is shown again if the case still stands after the step gap (half an hour; a day for `unreleased`). */
  stepTaken(signalId: string): void {
    const { ctx } = this.deps;
    const kind = ctx.repos.operatorSignals.get(signalId)?.kind;
    const at =
      ctx.now().getTime() +
      (kind ? operatorSignalStepGapMs(kind) : OPERATOR_SIGNAL_STEP_GAP_MINUTES * 60_000);
    ctx.repos.operatorSignals.followUp(signalId, new Date(at).toISOString());
  }

  /** Delivered, unresolved signals still awaiting presentation or a decision, oldest first. */
  active(projectKey: string): OperatorSignal[] {
    return this.deps.ctx.repos.operatorSignals
      .listOpen(projectKey)
      .filter(
        (s) =>
          s.deliveredAt !== null && s.resolvedAt === null && (s.state === 'pending' || s.state === 'open'),
      )
      .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt))
      .map((s) => OperatorSignal.parse(s));
  }

  channel(projectKey: string): { signals: OperatorSignal[]; openSignals: number } {
    const { operatorSignals } = this.deps.ctx.repos;
    const since = new Date(this.deps.ctx.now().getTime() - 7 * 24 * 60 * 60_000).toISOString();
    // Only the last week is read; the open count comes from the open signals, however old.
    return {
      signals: operatorSignals
        .listSince(projectKey, since)
        .filter((s) => !isCoordinatorOnlySignal(s.kind) && s.deliveredAt && s.state !== 'pending')
        .map((s) => OperatorSignal.parse(s)),
      openSignals: operatorSignals
        .listOpen(projectKey)
        .filter((s) => !isCoordinatorOnlySignal(s.kind) && s.deliveredAt && s.state === 'open').length,
    };
  }

  /** Server-produced evidence, reconstructed from the original timeline window and checked against now. */
  structuralFacts(signal: OperatorSignalRecord): StructuralFacts {
    const config = this.deps.projects.cachedConfig(signal.projectKey);
    return config ? new StructuralPatterns(this.deps.ctx).evaluate(config).facts(signal) : null;
  }

  /** Created anew in each synchronous phase, including each actual deferred-start validity check. */
  private lazyStructuralEvaluation(config: ProjectConfig | undefined) {
    let evaluation: StructuralEvaluation | undefined;
    return () => {
      if (config) evaluation ??= new StructuralPatterns(this.deps.ctx).evaluate(config);
      return evaluation;
    };
  }

  /** Reconcile current card and session facts before attempting any queued wake-up. */
  async sweep(projectKey?: string): Promise<void> {
    for (const key of projectKey ? [projectKey] : this.deps.projects.summaries().map((p) => p.key))
      await this.sweepProject(key);
  }

  /**
   * One body at a time per project (PM-1120). A call that arrives while another run still waits for its turn
   * joins that run: the body reads the state when it starts, so it covers every event that came before it.
   */
  private sweepProject(key: string): Promise<void> {
    const queued = this.queuedSweeps.get(key);
    if (queued && !queued.started) return queued.promise;
    const run = { started: false, promise: Promise.resolve() };
    run.promise = this.sweepLocks.run(key, async () => {
      run.started = true;
      await this.sweepBody(key);
    });
    this.queuedSweeps.set(key, run);
    const forget = () => {
      if (this.queuedSweeps.get(key) === run) this.queuedSweeps.delete(key);
    };
    run.promise.then(forget, forget);
    return run.promise;
  }

  private async sweepBody(key: string): Promise<void> {
    const config = await this.deps.projects.config(key);
    const cards = this.openCards(key);
    const reads = this.readBoard(config, cards);
    const live = this.deps.ctx.repos.sessions.listLive(key);
    const active = new Set<string>();
    for (const kind of STRUCTURAL_KINDS)
      this.deps.ctx.repos.operatorSignals.arm(key, kind, isoNow(this.deps.ctx));
    const structural = this.lazyStructuralEvaluation(config);
    const report = structural()!.report();
    const previous = this.deps.ctx.repos.operatorSignals.list(key);
    for (const facts of report.patterns) {
      const subject = patternSubject(facts.fingerprint);
      if (
        previous.some(
          (s) =>
            s.kind === 'structural_pattern' &&
            s.subject === subject &&
            this.deps.ctx.now().getTime() - Date.parse(s.raisedAt) < STRUCTURAL_WINDOW_MS,
        )
      )
        continue;
      this.raise({
        projectKey: key,
        kind: 'structural_pattern',
        subject,
        caseKey: `structural_pattern:${subject}:${facts.eventIds.at(-1)}`,
      });
    }
    for (const milestone of report.milestones) {
      const caseKey = `milestone_closed:${milestone.taskKey}:${milestone.eventId}`;
      if (!previous.some((s) => s.caseKey === caseKey))
        this.raise({
          projectKey: key,
          kind: 'milestone_closed',
          caseKey,
          taskKey: milestone.taskKey,
          subject: milestone.eventId,
        });
    }
    for (const [taskKey, wait] of reads.waits) {
      if (wait?.reason !== 'nobody') continue;
      const task = cards.find((t) => t.key === taskKey)!;
      const caseKey = `nobody:${task.key}:${task.stageId}`;
      active.add(caseKey);
      this.raise({ projectKey: key, kind: 'nobody', caseKey, taskKey, subject: task.stageId });
    }
    for (const task of cards) {
      const reason = this.startBlockedReason(task);
      if (!reason) {
        if (this.startAttemptRunning(task))
          for (const signal of previous)
            if (signal.kind === 'start_blocked' && signal.taskKey === task.key && !signal.resolvedAt)
              active.add(signal.caseKey);
        continue;
      }
      const caseKey = startBlockedCaseKey(task.key, reason);
      active.add(caseKey);
      this.raise({ projectKey: key, kind: 'start_blocked', caseKey, taskKey: task.key, subject: reason });
    }
    for (const session of live) {
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
    // Built once and reused within this sweep; never kept between sweeps.
    const board = this.boardRead(config, cards, reads);
    for (const input of board.cases.values()) {
      active.add(input.caseKey);
      this.raise(input);
    }
    const outages = this.deps.activeOutageIds(key);
    for (const signal of this.deps.ctx.repos.operatorSignals.listOpen(key)) {
      if (
        structuralKind(signal.kind) &&
        !signal.resolvedAt &&
        (signal.state === 'pending' || signal.state === 'open') &&
        this.deps.ctx.now().getTime() - Date.parse(signal.raisedAt) >= STRUCTURAL_WINDOW_MS
      )
        this.resolve(key, signal.caseKey);
      if (signal.kind === 'outage' && outages !== null && !outages.has(signal.subject ?? ''))
        this.resolve(key, signal.caseKey);
      if (
        (signal.kind === 'nobody' ||
          signal.kind === 'silent' ||
          signal.kind === 'start_blocked' ||
          BOARD_KINDS.has(signal.kind)) &&
        !active.has(signal.caseKey)
      )
        this.resolve(key, signal.caseKey);
      if (RETIRED_KINDS.has(signal.kind)) this.resolve(key, signal.caseKey);
      // The step was done, ended or handed over to a person: nothing is left to tell the project manager.
      if (signal.kind === 'obligation_overdue' && !this.caseHolds(config, signal))
        this.resolve(key, signal.caseKey);
      if (
        signal.kind === 'stalled' &&
        this.deps.ctx.repos.sessions.get(signal.subject ?? '')?.state !== 'waiting_input'
      )
        this.resolve(key, signal.caseKey);
    }
    await this.deliver(key, structural, board);
  }

  /** A recipient change or leave invalidates unpresented delivery, without touching earlier human decisions. */
  recheckRecipients(projectKey: string): void {
    const config = this.deps.projects.cachedConfig(projectKey);
    const recipient = config && coordinationMemberOf(config)?.handle;
    for (const signal of this.deps.ctx.repos.operatorSignals.listOpen(projectKey))
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
    for (const signal of this.deps.ctx.repos.operatorSignals.listOpen(projectKey))
      if (signal.state === 'pending' && signal.deliveredAt) this.save({ ...signal, state: 'open' });
  }

  /**
   * Gives the coordinator the signals it is owed (PM-885): each pending signal is an item of its work queue, and
   * the queue's driver delivers it, holding it back until the wake interval allows (`holdsBack`).
   */
  async deliver(
    projectKey: string,
    structural = this.lazyStructuralEvaluation(this.deps.projects.cachedConfig(projectKey)),
    board?: BoardRead,
  ): Promise<void> {
    const config = this.deps.projects.cachedConfig(projectKey);
    const member = config && coordinationMemberOf(config);
    if (!member || member.kind !== 'ai') return;
    const now = this.deps.ctx.now().getTime();
    for (const signal of this.pending(projectKey, structural, { board })) {
      // A new item for a signal shown before: its follow-up time came, or it was shown to another binding.
      const due = signal.followUpAt !== null && Date.parse(signal.followUpAt) <= now;
      const followUpAt = due
        ? signal.followUpAt
        : signal.deliveredAt
          ? `${REBOUND_PREFIX}${signal.deliveredAt}`
          : null;
      this.deps.queue.add({
        projectKey,
        member: member.handle,
        kind: 'signal',
        source: {
          type: 'signal',
          id: memberQueueSourceId({ type: 'signal', signalId: signal.id, followUpAt }),
        },
        place: { type: 'general' },
        taskKey: signal.taskKey,
        wake: true,
        title: `${signal.kind}${signal.taskKey ? ` ${signal.taskKey}` : ''}`,
        from: null,
      });
    }
    await this.deps.wake(projectKey, member.handle);
  }

  /**
   * Whether the signal of a queue item is still owed to the coordinator: not closed, addressed to that member, and
   * not yet shown to it (a follow-up: shown again once its time came).
   */
  owed(projectKey: string, member: string, signalId: string, followUpAt: string | null): boolean {
    const signal = this.deps.ctx.repos.operatorSignals.get(signalId);
    const config = this.deps.projects.cachedConfig(projectKey);
    const recipient = config && coordinationMemberOf(config)?.handle;
    if (!signal || signal.resolvedAt || recipient !== member) return false;
    const open = signal.state === 'pending' || signal.state === 'open';
    if (signal.messageId && signal.deliveredTo !== recipient) return false;
    const rebound = !signal.messageId && open && signal.deliveredTo !== recipient;
    if (followUpAt?.startsWith(REBOUND_PREFIX)) return rebound;
    if (followUpAt !== null) return open && signal.followUpAt === followUpAt;
    return rebound || (signal.state === 'pending' && !signal.deliveredAt);
  }

  /** Whether the wake interval (or the structural window) still holds the signal back from the coordinator. */
  holdsBack(projectKey: string, signalId: string): boolean {
    return this.heldBack(projectKey, [signalId]).has(signalId);
  }

  /**
   * Which of the signals the wake interval (or the structural window) holds back, and why: `interval` (its own
   * wake line is not due) or `unready` (the line is due but the signal is not owed now: its case is gone, or its
   * own delay lasts). One question for a whole queue run, so its cost does not grow with the signals waiting;
   * only the signals asked about are read, the cases once. A reading, it never writes: the 60 s sweep (`deliver`)
   * resolves a gone case, and the coordinator's text is built from the case read at that moment.
   */
  heldBack(projectKey: string, signalIds: string[]): Map<string, SignalHold> {
    const held = new Map<string, SignalHold>(signalIds.map((id) => [id, 'interval']));
    const wakes = this.wakeLine(projectKey);
    // Only the asked signals whose own line is due are read further; the other open signals cost nothing.
    const candidates = this.deps.ctx.repos.operatorSignals
      .listOpen(projectKey)
      .filter((s) => held.has(s.id) && wakes(s));
    if (!candidates.length) return held;
    for (const signal of candidates) held.set(signal.id, 'unready');
    for (const signal of this.pending(projectKey, undefined, { open: candidates, resolve: false }))
      held.delete(signal.id);
    return held;
  }

  /** The input that gives the coordinator these signals: the wake-up text of its level, one JSON line each. */
  noticeText(projectKey: string, signalIds: string[]): string {
    const { ctx, projects } = this.deps;
    const config = projects.cachedConfig(projectKey);
    if (!config) return '';
    const structural = this.lazyStructuralEvaluation(config);
    const signals = signalIds.flatMap((id) => {
      const signal = ctx.repos.operatorSignals.get(id);
      return signal ? [signal] : [];
    });
    const level = operatorWatchOf(config);
    const now = isoNow(ctx);
    return (
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
                  s.kind,
                );
          return JSON.stringify({
            ...OperatorSignal.parse(s),
            facts: structuralKind(s.kind)
              ? structural()!.facts(s)
              : s.kind === 'loop_suspected'
                ? LoopTriageFacts.parse(JSON.parse(s.subject!))
                : s.kind === 'obligation_overdue'
                  ? this.obligationOverdueFacts(s)
                  : s.kind === 'answer_stalled'
                    ? this.answerStalledFacts(s)
                    : s.kind === 'start_blocked'
                      ? this.startBlockedFacts(config, s)
                      : s.inboxItemId
                        ? ctx.repos.inbox.get(s.inboxItemId)?.payload
                        : s.subject
                          ? ctx.repos.sessions.get(s.subject)?.activity
                          : null,
            step: this.stepOf(level, config, s),
            steps_left: structuralKind(s.kind) ? 0 : budget.left,
            next_step_at: structuralKind(s.kind) ? null : budget.nextAt,
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
        .join('\n')
    );
  }

  /** A start for the item failed for good: the item stays queued and is tried again, and says so (`startRefused`). */
  markStartRefused(itemId: string): void {
    const repo = this.deps.ctx.repos.memberQueue;
    const payload = repo.payload<Record<string, unknown>>(itemId) ?? {};
    if (payload.startRefused !== true) repo.setPayload(itemId, { ...payload, startRefused: true });
  }

  /**
   * The coordinator got the signal (the item reached its session). A signal shown again after an own step is
   * shown from the start (PM-545): the coordinator may present it anew. A session that already ended its turn
   * has seen it: the signal is open at once.
   */
  markDelivered(projectKey: string, member: string, signalId: string, followUpAt: string | null): void {
    const { ctx, projects, sessions } = this.deps;
    const config = projects.cachedConfig(projectKey);
    if (!config || coordinationMemberOf(config)?.handle !== member) return;
    const current = ctx.repos.operatorSignals.get(signalId);
    if (!current) return;
    const at = isoNow(ctx);
    if (followUpAt === null || followUpAt.startsWith(REBOUND_PREFIX))
      ctx.repos.operatorSignals.delivered([signalId], at, member);
    else if (current.followUpAt === followUpAt) ctx.repos.operatorSignals.redelivered([signalId], at, member);
    // The turn ended before the receipt was written (the session is gone): nothing will close the signal later.
    if (!sessions.findRunning(projectKey, member, { type: 'general' })) this.finish(projectKey);
  }

  /**
   * The open signals the coordinator is owed now. A signal whose case no longer stands is resolved here
   * (`resolve`); a read-only question (the queue's hold) leaves that to the next sweep.
   */
  private pending(
    projectKey: string,
    structural = this.lazyStructuralEvaluation(this.deps.projects.cachedConfig(projectKey)),
    {
      open = this.deps.ctx.repos.operatorSignals.listOpen(projectKey),
      resolve = true,
      board: known,
    }: { open?: OperatorSignalRecord[]; resolve?: boolean; board?: BoardRead } = {},
  ): OperatorSignalRecord[] {
    const { ctx, projects } = this.deps;
    const now = ctx.now().getTime();
    let board: Map<string, SignalInput> | undefined = known?.cases;
    return open.filter((s) => {
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
      const valid = this.caseHolds(
        config,
        s,
        () => {
          board ??= config ? this.boardRead(config, this.openCards(projectKey)).cases : new Map();
          return board;
        },
        structural,
      );
      if (!valid) {
        if (resolve) this.resolve(projectKey, s.caseKey);
        return false;
      }
      // The facts of a start under a new attempt cannot be read; the signal is told after the attempt (PM-455).
      if (s.kind === 'start_blocked') {
        const card = s.taskKey ? ctx.repos.tasks.get(s.taskKey) : null;
        if (card && this.startAttemptRunning(card)) return false;
      }
      // A failed fetch may be a network blip the system's own retries mend: told only if it outlasts them (PM-455).
      return !(
        s.kind === 'start_blocked' &&
        s.subject === 'workspace_fetch_failed' &&
        !s.deliveredAt &&
        now - Date.parse(s.raisedAt) < OPERATOR_START_FETCH_FAILED_MINUTES * 60_000
      );
    });
  }

  /** Whether the case of the signal still stands, read from the cards, merges, sessions and releases now. */
  private caseHolds(
    config: ProjectConfig | undefined,
    s: OperatorSignalRecord,
    board: () => Map<string, SignalInput> = () =>
      config ? this.boardRead(config, this.openCards(s.projectKey)).cases : new Map(),
    structural = this.lazyStructuralEvaluation(config),
  ): boolean {
    if (structuralKind(s.kind)) return (structural()?.facts(s) ?? null) !== null;
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
    if (s.kind === 'start_blocked') {
      const task = s.taskKey ? ctx.repos.tasks.get(s.taskKey) : null;
      return !!task && (this.startBlockedReason(task) === s.subject || this.startAttemptRunning(task));
    }
    if (s.kind === 'obligation_overdue') {
      // The step is still the responsible's and the project manager has been told: any other end closes the case.
      const obligation = ctx.repos.obligations.get(s.subject ?? '');
      return obligation?.state === 'open' && obligation.pmToldAt !== null;
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

  /** The reads one pass shares: the waits, the open merges and the sessions' activity per card, each read once. */
  private readBoard(config: ProjectConfig, cards: readonly Task[]): BoardReads {
    const { ctx, taskWaits } = this.deps;
    const projectKey = config.project.key;
    return {
      waits: taskWaits.of(config, cards),
      merges: new Map(ctx.repos.taskMerges.openOfProject(projectKey).map((row) => [row.taskKey, row])),
    };
  }

  /**
   * The cases of the board kinds that hold now (PM-547), read from the cards, merges, sessions and releases
   * only; the sweep raises and closes by it and `pending` checks a signal against it before waking anyone.
   * The ready stall they carry is the one read of it: `trackStall` uses it as it is.
   */
  private boardRead(
    config: ProjectConfig,
    cards: readonly Task[],
    reads: BoardReads = this.readBoard(config, cards),
  ): BoardRead {
    const { ctx, sessions } = this.deps;
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
    const { waits, merges } = reads;
    const openMerges = [...merges.values()];

    if (works) {
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

    // Failed merges first, then blocked ones, each in queue order (the order the per-state lists had).
    for (const state of ['failed', 'blocked'] as const)
      for (const row of openMerges) {
        if (row.state !== state || !aiMember(row.merger)) continue;
        add({
          kind: 'merge_blocked',
          caseKey: `merge_blocked:${row.taskKey}`,
          taskKey: row.taskKey,
          subject: row.failure?.reason ?? row.block?.reason ?? state,
        });
      }

    // Work merged on a default branch that waited a day for a release (PM-1201): one case per repository and base,
    // so a release (which moves the base) ends it.
    for (const work of this.deps.unreleased(projectKey)) {
      if (now - Date.parse(work.oldestAt) < OPERATOR_UNRELEASED_HOURS * 3_600_000) continue;
      add({
        kind: 'unreleased',
        caseKey: `unreleased:${work.repo}:${work.base}`,
        taskKey: null,
        subject: String(work.count),
      });
    }

    return { cases: found };
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

  /** What the project manager needs to weigh an overdue step: the row's clock, not the reasons it stands. */
  private obligationOverdueFacts(signal: OperatorSignalRecord): ObligationOverdueFacts | null {
    const row = this.deps.ctx.repos.obligations.get(signal.subject ?? '');
    if (!row) return null;
    return {
      obligation: {
        id: row.id,
        kind: row.kind,
        responsible: row.responsible,
        subject: row.subject,
        openedAt: row.openedAt,
        wokenAt: row.wokenAt,
        // The step goes to a person when the row's deadline passes (the last rung).
        handOverAt: row.dueAt,
      },
    };
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

  /**
   * Whether a signal's line may wake the coordinator now (PM-694): the general line waits
   * `OPERATOR_SIGNAL_WAKE_INTERVAL_MS` after its last delivery, the fast line (`answer_stalled`) only
   * `OPERATOR_ANSWER_STALL_WAKE_MS` after its own. Each line counts the deliveries of its own kinds; a
   * structural signal also waits while one was delivered in the last day. Read once, asked per signal.
   */
  private wakeLine(projectKey: string): (signal: OperatorSignalRecord) => boolean {
    const signals = this.deps.ctx.repos.operatorSignals;
    const now = this.deps.ctx.now().getTime();
    const due = (last: string | null, wait: number) => last === null || now - Date.parse(last) >= wait;
    const dueFast = due(
      signals.lastDeliveredAt(projectKey, OPERATOR_FAST_SIGNAL_KINDS, 'only'),
      OPERATOR_ANSWER_STALL_WAKE_MS,
    );
    const dueGeneral = due(
      signals.lastDeliveredAt(projectKey, OPERATOR_FAST_SIGNAL_KINDS, 'except'),
      OPERATOR_SIGNAL_WAKE_INTERVAL_MS,
    );
    const structuralDelivered = signals.deliveredAfter(
      projectKey,
      STRUCTURAL_KINDS,
      new Date(now - 24 * 60 * 60_000).toISOString(),
    );
    const config = this.deps.projects.cachedConfig(projectKey);
    const recipient = config && coordinationMemberOf(config)?.handle;
    return (s) =>
      (!structuralKind(s.kind) || !structuralDelivered) &&
      !!(
        (s.deliveredAt && s.deliveredTo !== recipient) ||
        (OPERATOR_FAST_SIGNAL_KINDS.includes(s.kind) ? dueFast : dueGeneral)
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
}
