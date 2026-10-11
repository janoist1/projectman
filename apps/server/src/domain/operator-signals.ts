import {
  formatInjectedTeamMessage,
  operatorOf,
  OperatorSignal,
  OPERATOR_SIGNAL_WAKE_INTERVAL_MS,
  isWorkPaused,
  OPERATOR_SILENT_WORK_MINUTES,
} from '@projectman/shared';
import type { OperatorSignalKind } from '@projectman/shared';
import type { OperatorSignalRecord } from '../db';
import type { DomainContext } from './context';
import { isoNow } from './context';
import type { Admission, AutomaticStart, StartSpec } from './admission';
import type { ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';
import type { MessageDelivery } from './messaging';
import type { TaskWaits } from './tasks';
import { conflict } from './errors';
import { newId } from './util';

type SignalInput = {
  projectKey: string;
  kind: OperatorSignalKind;
  caseKey: string;
  taskKey?: string | null;
  subject?: string | null;
  inboxItemId?: string | null;
};

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
    if (
      !signal ||
      signal.projectKey !== projectKey ||
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
      const outages = this.deps.activeOutageIds(key);
      for (const signal of this.deps.ctx.repos.operatorSignals.list(key)) {
        if (signal.kind === 'outage' && outages !== null && !outages.has(signal.subject ?? ''))
          this.resolve(key, signal.caseKey);
        if ((signal.kind === 'nobody' || signal.kind === 'silent') && !active.has(signal.caseKey))
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
    const { ctx, projects, taskWaits } = this.deps;
    return ctx.repos.operatorSignals.list(projectKey).filter((s) => {
      if (s.state !== 'pending' || s.resolvedAt || s.deliveredAt) return false;
      let valid = true;
      if (s.kind === 'nobody') {
        const task = s.taskKey ? ctx.repos.tasks.get(s.taskKey) : null;
        const config = projects.cachedConfig(projectKey);
        valid =
          !!task &&
          !!config &&
          task.stageId === s.subject &&
          taskWaits.ofCard(config, task)?.reason === 'nobody';
      } else if (s.kind === 'silent' || s.kind === 'stalled') {
        const session = ctx.repos.sessions.get(s.subject ?? '');
        valid =
          !!session &&
          (s.kind === 'stalled'
            ? session.state === 'waiting_input'
            : session.state === 'working' &&
              ctx.now().getTime() - Date.parse(session.lastActivityAt) >=
                OPERATOR_SILENT_WORK_MINUTES * 60_000);
      }
      if (!valid) this.resolve(projectKey, s.caseKey);
      return valid;
    });
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
            ctx.unitOfWork(() =>
              ctx.repos.operatorSignals.delivered(
                signals.map((s) => s.id),
                isoNow(ctx),
              ),
            );
            const current = sessions.findRunning(projectKey, member.handle, workItem);
            if (!current || current.state === 'idle') this.finish(projectKey);
          });
          // Install a rejection handler before the admission attempt releases its lock.
          void delivered.catch(() => undefined);
          this.firstDeliveries.set(projectKey, delivered);
          return;
        }
        ctx.unitOfWork(() =>
          ctx.repos.operatorSignals.delivered(
            signals.map((s) => s.id),
            isoNow(ctx),
          ),
        );
      },
    };
  }
}
