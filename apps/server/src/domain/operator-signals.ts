import {
  dutyMembers,
  formatInjectedTeamMessage,
  isOperator,
  operatorOf,
  projectManagersOf,
  OPERATOR_SIGNAL_STEP_GAP_MINUTES,
  OperatorSignal,
  OPERATOR_SIGNAL_WAKE_INTERVAL_MS,
  aiLimitReached,
  isOnLeave,
  isWorkPaused,
  memberOf,
  stageIndex,
  stageOf,
  stageOwners,
  OPERATOR_IDLE_MINUTES,
  OPERATOR_MERGE_WAIT_MINUTES,
  OPERATOR_READY_WAITING_MINUTES,
  OPERATOR_SILENT_WORK_MINUTES,
  OPERATOR_UNRELEASED_HOURS,
} from '@projectman/shared';
import type {
  OperatorSignalKind,
  OperatorSignalStepTargets,
  ProjectConfig,
  Stage,
  Task,
  TaskWait,
} from '@projectman/shared';
import type { OperatorSignalRecord } from '../db';
import type { DomainContext } from './context';
import { isoNow } from './context';
import type { Admission, AutomaticStart, StartSpec } from './admission';
import type { ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';
import type { MessageDelivery } from './messaging';
import type { TaskWaits } from './tasks';
import type { ReleaseService } from './releases';
import { conflict, invalid } from './errors';
import { newId } from './util';

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
]);

/** One notice per system problem episode; notices never authorize a write. */
export class OperatorSignals {
  private readonly waking = new Set<string>();
  private readonly firstDeliveries = new Map<string, Promise<void>>();
  constructor(privateDeps: {
    ctx: DomainContext;
    projects: ProjectService;
    sessions: SessionOrchestrator;
    admission: Admission;
    delivery: MessageDelivery;
    taskWaits: TaskWaits;
    activeOutageIds: (projectKey: string) => ReadonlySet<string> | null;
    releases: Pick<ReleaseService, 'unreleased'>;
  }) {
    this.deps = privateDeps;
  }
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    sessions: SessionOrchestrator;
    admission: Admission;
    delivery: MessageDelivery;
    taskWaits: TaskWaits;
    activeOutageIds: (projectKey: string) => ReadonlySet<string> | null;
    releases: Pick<ReleaseService, 'unreleased'>;
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
      resolvedAt: null,
      deliveredAt: null,
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

  presentation(projectKey: string, id: string): OperatorSignalRecord {
    const signal = this.deps.ctx.repos.operatorSignals.get(id);
    if (!signal || signal.projectKey !== projectKey)
      throw invalid('invalid_request', 'unknown signal in this project');
    if (
      signal.resolvedAt ||
      signal.messageId ||
      !signal.deliveredAt ||
      !(signal.state === 'open' || signal.state === 'pending')
    )
      throw conflict('operator_signal_closed', 'the signal is no longer open for presentation');
    return signal;
  }

  present(projectKey: string, id: string, messageId: string, actionable: boolean): void {
    const signal = this.presentation(projectKey, id);
    this.save({ ...signal, state: 'open', messageId, actionable });
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
   * What the signal lets the Operator start without an owner's request (PM-545). The case must still hold
   * and the signal be open for the Operator; a person on leave, a person and the Operator itself are never targets.
   */
  async stepTargets(
    projectKey: string,
    signalId: string,
  ): Promise<{ signal: OperatorSignalRecord; allowed: OperatorSignalStepTargets }> {
    const { ctx, projects, taskWaits } = this.deps;
    const signal = ctx.repos.operatorSignals.get(signalId);
    if (!signal || signal.projectKey !== projectKey)
      throw invalid('invalid_request', 'unknown signal in this project');
    const config = await projects.config(projectKey);
    if (
      signal.resolvedAt ||
      !signal.deliveredAt ||
      !(signal.state === 'open' || signal.state === 'pending') ||
      !this.caseHolds(config, signal)
    )
      throw conflict('operator_signal_closed', 'the signal is no longer open');
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
    }
    return { signal, allowed };
  }

  /** The Operator took a step on the signal: it is shown again if the case still stands in half an hour. */
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
        if (
          signal.kind === 'stalled' &&
          this.deps.ctx.repos.sessions.get(signal.subject ?? '')?.state !== 'waiting_input'
        )
          this.resolve(key, signal.caseKey);
      }
      await this.deliver(key);
    }
  }

  rebuild(spec: Extract<StartSpec, { kind: 'operator_signals' }>): AutomaticStart | null {
    return this.pending(spec.projectKey).length ? this.start(spec.projectKey) : null;
  }

  /** The Operator finished its turn, or startup recovered a turn that ended before being recorded. */
  finish(projectKey: string): void {
    for (const signal of this.deps.ctx.repos.operatorSignals.list(projectKey))
      if (signal.state === 'pending' && signal.deliveredAt) this.save({ ...signal, state: 'open' });
  }

  async deliver(projectKey: string): Promise<void> {
    if (this.waking.has(projectKey) || !this.pending(projectKey).length || !this.due(projectKey)) return;
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
      // A signal the Operator took a step on is shown again once its follow-up time has come (PM-545).
      const again =
        s.followUpAt !== null &&
        Date.parse(s.followUpAt) <= now &&
        (s.state === 'pending' || s.state === 'open');
      if (!again && (s.state !== 'pending' || s.deliveredAt)) return false;
      const config = projects.cachedConfig(projectKey);
      const valid = this.caseHolds(config, s, () => {
        board ??= config ? this.boardCases(config, ctx.repos.tasks.list(projectKey)) : new Map();
        return board;
      });
      if (!valid) {
        this.resolve(projectKey, s.caseKey);
        return false;
      }
      // Free capacity is raised at once but wakes the Operator only if it lasts (PM-547).
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
      const free = new Set<string>();
      for (const task of cards) {
        const index = stageIndex(config.pipeline, task.stageId);
        const next = config.pipeline.stages[index + 1];
        if (index <= 0 || next?.kind !== 'work' || stageOf(config, task.stageId)?.kind !== 'queue') continue;
        if (waits.get(task.key)?.reason !== 'ready') continue;
        for (const handle of stageOwners(config, next)) {
          const member = aiMember(handle);
          if (
            member &&
            !isOnLeave(member) &&
            !member.temp &&
            admission.memberLoad(config, handle) < member.capacity
          )
            free.add(handle);
        }
      }
      if (free.size > 0)
        add({ kind: 'ready_waiting', caseKey: 'ready_waiting', taskKey: null, subject: [...free].join(',') });
    }
    return found;
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
  private due(projectKey: string): boolean {
    const last = this.deps.ctx.repos.operatorSignals
      .list(projectKey)
      .flatMap((s) => (s.deliveredAt ? [Date.parse(s.deliveredAt)] : []))
      .sort((a, b) => b - a)[0];
    return last === undefined || this.deps.ctx.now().getTime() - last >= OPERATOR_SIGNAL_WAKE_INTERVAL_MS;
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
  private start(projectKey: string): AutomaticStart {
    const { ctx, projects, sessions, admission, delivery } = this.deps;
    return {
      key: `operator-signals:${projectKey}`,
      projectKey,
      taskKey: null,
      spec: () => ({ kind: 'operator_signals', projectKey }),
      stillValid: () => this.pending(projectKey).length > 0,
      waitsFor: () => operatorOf(projects.cachedConfig(projectKey)!)?.handle,
      retry: () => this.deliver(projectKey),
      log: {
        deferred: 'operator signal start deferred',
        retryFailed: 'operator signal retry failed',
        fields: () => ({ projectKey }),
      },
      run: async () => {
        if (!this.due(projectKey)) return;
        const config = await projects.config(projectKey);
        const member = operatorOf(config);
        if (!member) return;
        if (isWorkPaused(ctx.repos.pauses.open(), projectKey))
          throw conflict('team_paused', 'the team is paused');
        const signals = this.pending(projectKey);
        if (!signals.length) return;
        const text =
          'Projectman system signals. Check get_project_state and session activity before reporting each signal to the owners. Change nothing until an owner says yes.\n' +
          signals
            .map((s) =>
              JSON.stringify({
                ...OperatorSignal.parse(s),
                facts: s.inboxItemId
                  ? ctx.repos.inbox.get(s.inboxItemId)?.payload
                  : s.subject
                    ? ctx.repos.sessions.get(s.subject)?.activity
                    : null,
              }),
            )
            .join('\n');
        const workItem = { type: 'general' } as const;
        // A signal shown again after an own step is shown from the start (PM-545): the Operator may present it anew.
        const markDelivered = () =>
          ctx.unitOfWork(() => {
            const at = isoNow(ctx);
            ctx.repos.operatorSignals.delivered(
              signals.filter((s) => s.followUpAt === null).map((s) => s.id),
              at,
            );
            ctx.repos.operatorSignals.redelivered(
              signals.filter((s) => s.followUpAt !== null).map((s) => s.id),
              at,
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
