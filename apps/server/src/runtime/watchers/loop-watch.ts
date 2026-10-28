import {
  LOOP_LET_RUN_OPTION,
  LOOP_STOP_OPTION,
  OperatorSignal,
  coordinationActorRefusal,
  coordinationMemberOf,
  countsForLoop,
  findLoop,
  isLoopTriageEvidence,
  isOpenTask,
  isTheme,
  loopDecisionOf,
  loopDeciders,
  loopWatchOf,
  loopTriageDeadline,
  ownerHandles,
} from '@projectman/shared';
import type {
  InboxItem,
  LoopDecisionPayload,
  LoopFinding,
  LoopTalk,
  LoopTriageFacts,
  ProjectConfig,
  Task,
  TimelineEvent,
  TimelineEventData,
} from '@projectman/shared';
import type { TaskLoopRecord } from '../../db';
import type { AutomaticStart, StartSpec } from '../admission';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import type { InboxService } from '../../core/inbox';
import type { ConfigChange, ProjectService } from '../../core/projects';
import type { SessionOrchestrator } from '../sessions';
import type { TaskService } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import {
  KeyedMutex,
  SYSTEM_ACTOR,
  aiActor,
  conflict,
  forbidden,
  humanActor,
  invalid,
  newId,
} from '../../kernel';
import type { LoopTriageEngine, LoopTriageNotices } from './ports';

const TALK_LIMIT = 1000;
const MINUTE_MS = 60_000;
type EndReason = NonNullable<TimelineEventData['task_loop']['endReason']>;
type Head = LoopTriageFacts['head'];

/** Detects unchanged conversations. The PM filters candidates; only people stop or let work run. */
export class LoopWatch {
  private readonly cards = new KeyedMutex();
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    inbox: InboxService;
    timeline: TimelineService;
    notices: LoopTriageNotices;
    engine: LoopTriageEngine;
  };
  constructor(deps: LoopWatch['deps']) {
    this.deps = deps;
  }

  check(event: TimelineEvent): Promise<void> | void {
    if (!event.taskKey || event.type !== 'team_message' || !event.actor.handle) return;
    return this.cards.run(event.taskKey, () => this.looked(event.projectKey, event.taskKey!, event));
  }

  worked(event: TimelineEvent): Promise<void> | void {
    if (event.taskKey) return this.progressed({ projectKey: event.projectKey, key: event.taskKey }, 'work');
  }

  progressed(
    task: Pick<Task, 'projectKey' | 'key'>,
    reason: 'stage' | 'label' | 'work' | 'closed',
  ): Promise<void> | void {
    if (!this.deps.ctx.repos.taskLoops.open(task.key)) return;
    return this.cards.run(task.key, async () => {
      const loop = this.deps.ctx.repos.taskLoops.open(task.key);
      if (loop) this.end(loop, reason);
    });
  }

  configChanged(change: ConfigChange): Promise<void> {
    return this.sweep(change.projectKey);
  }

  decided(item: InboxItem): Promise<void> | void {
    const payload = loopDecisionOf(item);
    if (!payload || !item.taskKey || item.resolution?.rule === 'loop_ended') return;
    return this.cards.run(item.taskKey, async () => {
      const loop = this.deps.ctx.repos.taskLoops.get(payload.loopId);
      if (!loop || loop.endedAt) return;
      const by = item.resolution?.by ?? 'system';
      if (item.resolution?.optionId === LOOP_STOP_OPTION.id) {
        await this.deps.sessions.stopTask(loop.projectKey, loop.taskKey, {
          kind: 'loop_stopped',
          ...(by !== 'system' ? { by: humanActor(by) } : {}),
        });
        this.end(loop, 'stopped', by);
      } else if (item.resolution?.optionId === LOOP_LET_RUN_OPTION.id) {
        this.end(loop, 'let_run', by);
      }
    });
  }

  /** Old deferred loop notices are replaced by the persisted PM signal on the next sweep. */
  rebuild(_spec: Extract<StartSpec, { kind: 'loop_notice' }>): AutomaticStart | null {
    return null;
  }

  async sweep(projectKey?: string): Promise<void> {
    for (const loop of this.deps.ctx.repos.taskLoops.listOpen(projectKey)) {
      try {
        await this.cards.run(loop.taskKey, async () => {
          const current = await this.checked(loop.id);
          if (!current || current.loop.phase !== 'notified') return;
          await this.request(current.config, current.task, current.loop, current.head);
        });
      } catch (err) {
        this.deps.ctx.logger.warn({ err, taskKey: loop.taskKey }, 'could not check the loop on a card');
      }
    }
  }

  /** Re-read the card and timeline after the asynchronous engine git read, under the task lock. */
  private async checked(
    loopId: string,
  ): Promise<{ config: ProjectConfig; task: Task; loop: TaskLoopRecord; head: Head } | null> {
    const { ctx, projects, tasks, sessions, timeline } = this.deps;
    const before = ctx.repos.taskLoops.get(loopId);
    if (!before || before.endedAt) return null;
    const initialTask = tasks.find(before.projectKey, before.taskKey);
    const initialConfig = projects.cachedConfig(before.projectKey);
    const head = initialTask && initialConfig ? await sessions.sourceHead(initialConfig, initialTask) : null;
    const loop = ctx.repos.taskLoops.get(loopId);
    if (!loop || loop.endedAt) return null;
    const task = tasks.find(loop.projectKey, loop.taskKey);
    const config = projects.cachedConfig(loop.projectKey);
    if (!task || !isOpenTask(task)) {
      this.end(loop, 'closed');
      return null;
    }
    if (!config) return null;
    if (initialTask && (initialTask.updatedAt !== task.updatedAt || initialTask.repo !== task.repo))
      return this.checked(loopId);
    if (!loopWatchOf(config.team.limits).enabled) {
      this.end(loop, 'disabled');
      return null;
    }
    const events: Array<[EndReason, TimelineEvent | null]> = [
      ['stage', timeline.latest(loop.projectKey, loop.taskKey, 'task_stage_changed')],
      ['label', timeline.latest(loop.projectKey, loop.taskKey, 'task_labels_changed')],
      ['work', timeline.latestWork(loop.projectKey, loop.taskKey)],
    ];
    const progress = events.find(
      ([, event]) => event && Date.parse(event.createdAt) >= Date.parse(loop.startedAt),
    );
    if (progress) {
      this.end(loop, progress[0]);
      return null;
    }
    // Null/offline is never evidence of progress.
    if (head && head.commit !== loop.headCommit) {
      this.end(loop, 'commit');
      return null;
    }
    if (
      ctx.now().getTime() - Date.parse(loop.lastMessageAt) >=
      loopWatchOf(config.team.limits).minutes * MINUTE_MS
    ) {
      this.end(loop, 'quiet');
      return null;
    }
    return {
      config,
      task,
      loop,
      head: head?.committedAt ? { commit: head.commit, committedAt: head.committedAt } : null,
    };
  }

  private async looked(projectKey: string, taskKey: string, event: TimelineEvent): Promise<void> {
    const { ctx, projects, tasks } = this.deps;
    const config = projects.cachedConfig(projectKey);
    const task = tasks.find(projectKey, taskKey);
    if (!config || !task || !loopWatchOf(config.team.limits).enabled || !isOpenTask(task) || isTheme(task))
      return;
    const open = ctx.repos.taskLoops.open(taskKey);
    if (open) {
      // A PM taking part still filters the loop. Its messages remain counted like any participant's.
      if (!countsForLoop(config, talkOf(event), [])) return;
      const grown = {
        ...open,
        count: open.count + 1,
        lastMessageAt: event.createdAt,
        members: [...new Set([...open.members, event.actor.handle!, ...talkOf(event).to])].sort(),
      };
      ctx.repos.taskLoops.save(grown);
      const current = await this.checked(open.id);
      if (current && current.loop.phase === 'notified')
        await this.request(current.config, current.task, current.loop, current.head);
      tasks.publish(task);
      return;
    }
    if (!countsForLoop(config, talkOf(event), [])) return;
    const watch = loopWatchOf(config.team.limits);
    if (!this.findSince(config, task, this.progressPoint(task, null), watch)) return;
    const head = await this.deps.sessions.sourceHead(config, task);
    // Changes during the engine read must also reset the detector's window.
    const freshTask = tasks.find(projectKey, taskKey);
    const freshConfig = projects.cachedConfig(projectKey);
    if (!freshTask || !freshConfig || !isOpenTask(freshTask)) return;
    const finding = this.findSince(
      freshConfig,
      freshTask,
      this.progressPoint(freshTask, head?.committedAt ?? null),
      loopWatchOf(freshConfig.team.limits),
    );
    if (!finding) return;
    const loop: TaskLoopRecord = {
      id: newId('loop'),
      projectKey,
      taskKey,
      startedAt: finding.startedAt,
      raisedAt: isoNow(ctx),
      lastMessageAt: finding.lastMessageAt,
      members: finding.members,
      count: finding.count,
      notified: null,
      notifiedCount: 0,
      phase: 'notified',
      ownerReason: null,
      deciders: [],
      inboxItemId: null,
      headCommit: head?.commit ?? null,
      endedAt: null,
      endReason: null,
      letRunBy: null,
      triage: { generation: 0, pendingSignalId: null, requestedCount: finding.count, assessed: null },
    };
    ctx.repos.taskLoops.create(loop);
    tasks.publish(freshTask);
    const current = await this.checked(loop.id);
    if (current) await this.request(current.config, current.task, current.loop, current.head);
  }

  private findSince(
    config: ProjectConfig,
    task: Task,
    since: string,
    watch: ReturnType<typeof loopWatchOf>,
  ): LoopFinding | null {
    const now = isoNow(this.deps.ctx);
    const from = new Date(Math.max(Date.parse(since), Date.parse(now) - watch.minutes * MINUTE_MS));
    const talk = this.deps.ctx.repos.timeline
      .talkSince(task.projectKey, task.key, from.toISOString(), TALK_LIMIT)
      .filter((entry) => entry.type === 'team_message')
      .map(talkOf)
      .filter((entry) => countsForLoop(config, entry, []));
    return findLoop(talk, since, now, watch);
  }

  private progressPoint(task: Task, committedAt: string | null): string {
    const { timeline, ctx } = this.deps;
    return [
      task.createdAt,
      timeline.latest(task.projectKey, task.key, 'task_stage_changed')?.createdAt,
      timeline.latest(task.projectKey, task.key, 'task_labels_changed')?.createdAt,
      timeline.latestWork(task.projectKey, task.key)?.createdAt,
      ctx.repos.taskLoops.lastEndedAt(task.key),
      committedAt,
    ]
      .filter((time): time is string => typeof time === 'string')
      .reduce((latest, time) => (Date.parse(time) > Date.parse(latest) ? time : latest));
  }

  /** One persisted signal per generation, checkpointed from the most recent PM assessment. */
  private async request(
    config: ProjectConfig,
    task: Task,
    original: TaskLoopRecord,
    head: Head,
  ): Promise<void> {
    const { ctx, notices } = this.deps;
    let loop = original;
    let triage = loop.triage;
    if (triage?.assessed) {
      if (loop.count - triage.assessed.count < loopWatchOf(config.team.limits).count) return;
      triage = {
        generation: triage.generation + 1,
        pendingSignalId: null,
        requestedCount: loop.count,
        assessed: null,
      };
    }
    triage ??= { generation: 0, pendingSignalId: null, requestedCount: loop.count, assessed: null };
    loop = { ...loop, triage };
    ctx.repos.taskLoops.save(loop);
    const facts: LoopTriageFacts = {
      loopId: loop.id,
      generation: triage.generation,
      reason: triage.generation === 0 ? 'initial' : 'continued',
      members: loop.members.slice(0, 50),
      count: loop.count,
      startedAt: loop.startedAt,
      lastMessageAt: loop.lastMessageAt,
      head,
      latestWorkAt: this.deps.timeline.latestWork(task.projectKey, task.key)?.createdAt ?? null,
      evidenceIds: ctx.repos.timeline
        .list(task.projectKey, { taskKey: task.key, limit: TALK_LIMIT })
        .filter(isLoopTriageEvidence)
        .slice(0, 20)
        .map((event) => event.id),
    };
    const result = await notices.report({ projectKey: task.projectKey, taskKey: task.key, facts });
    loop = { ...loop, triage: { ...triage, pendingSignalId: result.signalId } };
    ctx.repos.taskLoops.save(loop);
    // Progress may have arrived while reporting/delivering the signal.
    const fresh = await this.checked(loop.id);
    if (!fresh) return;
    loop = fresh.loop;
    config = fresh.config;
    task = fresh.task;
    const pending = result.signalId ? ctx.repos.operatorSignals.get(result.signalId) : null;
    const selected = coordinationMemberOf(config);
    const offlineDelivery =
      result.state === 'failed' &&
      pending &&
      !pending.resolvedAt &&
      selected &&
      this.deps.engine.read(task.projectKey, selected.handle).state !== 'online';
    if (
      !selected ||
      !config.team.limits.aiEnabled ||
      result.state === 'unavailable' ||
      (result.state === 'failed' && !offlineDelivery)
    ) {
      this.escalate(config, task, loop, 'no_watcher');
      return;
    }
    const signal = result.signalId ? ctx.repos.operatorSignals.get(result.signalId) : null;
    const deliveredAt = signal?.deliveredTo === selected.handle ? signal.deliveredAt : null;
    const engine = this.deps.engine.read(task.projectKey, selected.handle);
    const deadline = loopTriageDeadline({
      deadline: loop.triage!.deadline,
      deliveredAt,
      engineOnline: engine.state === 'online',
      lastConfirmedOnlineAt: engine.lastConfirmedOnlineAt,
      now: isoNow(ctx),
    });
    if (!deadline) return;
    const wasTold = loop.notifiedCount > 0;
    loop = {
      ...loop,
      ...(deliveredAt ? { notified: selected.handle, notifiedCount: loop.notifiedCount || loop.count } : {}),
      triage: { ...loop.triage!, deadline },
    };
    ctx.repos.taskLoops.save(loop);
    if (!wasTold && deliveredAt) this.record(task, loop, 'raised', { notified: loop.notified });
    if (deliveredAt && engine.state === 'online' && deadline.remainingMs === 0)
      this.escalate(config, task, loop, 'no_watcher');
    else this.deps.tasks.publish(task);
  }

  async assess(input: {
    projectKey: string;
    taskKey: string;
    loopId: string;
    generation: number;
    by: string;
    outcome: 'progress' | 'loop';
    note: string;
    evidenceIds: string[];
  }): Promise<{
    state: 'observing' | 'awaiting_owner' | 'resolved';
    loopId: string;
    inboxItemId: string | null;
  }> {
    return this.cards.run(input.taskKey, async () => {
      const { ctx, projects } = this.deps;
      const current = await this.checked(input.loopId);
      const config = projects.cachedConfig(input.projectKey);
      if (!config || coordinationActorRefusal(config, { kind: 'ai', handle: input.by }))
        throw forbidden('project_manager_only', 'only the selected PM may assess a loop');
      const loop = ctx.repos.taskLoops.get(input.loopId);
      if (
        !loop ||
        loop.projectKey !== input.projectKey ||
        loop.taskKey !== input.taskKey ||
        loop.triage?.generation !== input.generation
      )
        throw conflict('operator_signal_closed', 'the loop generation is no longer current');
      const response = (state: 'observing' | 'awaiting_owner' | 'resolved') => ({
        state,
        loopId: loop.id,
        inboxItemId: ctx.repos.taskLoops.get(loop.id)?.inboxItemId ?? null,
      });
      if (!current || loop.endedAt) return response('resolved');
      if (loop.triage.assessed) return response(loop.phase === 'owner' ? 'awaiting_owner' : 'observing');
      // An AI assessment never retracts a decision already shown to a person.
      if (loop.phase === 'owner')
        throw conflict('operator_signal_closed', 'the loop already awaits a person');
      const signal = loop.triage.pendingSignalId
        ? ctx.repos.operatorSignals.get(loop.triage.pendingSignalId)
        : null;
      if (
        !signal ||
        signal.resolvedAt ||
        !signal.deliveredAt ||
        signal.deliveredTo !== input.by ||
        !['pending', 'open'].includes(signal.state)
      )
        throw conflict('operator_signal_closed', 'the loop signal is no longer delivered to this PM');
      if (
        input.evidenceIds.length > 20 ||
        new Set(input.evidenceIds).size !== input.evidenceIds.length ||
        input.evidenceIds.some((id) => {
          const event = ctx.repos.timeline.get(input.projectKey, id);
          return !event || event.taskKey !== input.taskKey || !isLoopTriageEvidence(event);
        })
      )
        throw invalid('invalid_request', 'loop evidence must belong to this card and project');
      if (!input.note.trim() || input.note.length > 2000)
        throw invalid('invalid_request', 'an assessment needs a short note');
      const assessed = {
        by: input.by,
        at: isoNow(ctx),
        outcome: input.outcome,
        note: input.note,
        evidenceIds: input.evidenceIds,
        headCommit: current.head?.commit ?? null,
        count: loop.count,
      };
      const updated: TaskLoopRecord = {
        ...loop,
        triage: { ...loop.triage, assessed, pendingSignalId: null },
      };
      ctx.unitOfWork(() => {
        ctx.repos.taskLoops.save(updated);
        this.resolveSignal(loop);
        this.deps.timeline.append({
          projectKey: loop.projectKey,
          taskKey: loop.taskKey,
          actor: aiActor(input.by),
          type: 'loop_triaged',
          data: {
            loopId: loop.id,
            generation: input.generation,
            outcome: input.outcome,
            evidenceIds: input.evidenceIds,
            headCommit: assessed.headCommit,
          },
        });
        if (input.outcome === 'loop') this.escalate(current.config, current.task, updated, 'continued');
      });
      this.deps.tasks.publish(current.task);
      return response(input.outcome === 'loop' ? 'awaiting_owner' : 'observing');
    });
  }

  private resolveSignal(loop: TaskLoopRecord): void {
    const { ctx } = this.deps;
    const signal = loop.triage?.pendingSignalId
      ? ctx.repos.operatorSignals.get(loop.triage.pendingSignalId)
      : loop.triage
        ? ctx.repos.operatorSignals.openByCase(
            loop.projectKey,
            `loop_suspected:${loop.id}:${loop.triage.generation}`,
          )
        : null;
    if (signal && !signal.resolvedAt) {
      const resolved = { ...signal, state: 'resolved' as const, resolvedAt: isoNow(ctx) };
      ctx.repos.operatorSignals.save(resolved);
      if (signal.deliveredAt)
        ctx.bus.publish({
          type: 'operator_signal',
          projectKey: loop.projectKey,
          signal: OperatorSignal.parse(resolved),
        });
    }
  }

  private escalate(
    config: ProjectConfig,
    task: Task,
    loop: TaskLoopRecord,
    reason: 'no_watcher' | 'continued',
  ): void {
    if (loop.phase === 'owner' || loop.endedAt) return;
    const { ctx, inbox } = this.deps;
    ctx.unitOfWork(() => {
      const deciders = loopDeciders(config, ownerHandles(config));
      const payload: LoopDecisionPayload = {
        loopId: loop.id,
        taskKey: task.key,
        members: loop.members,
        count: loop.count,
        minutes: loopWatchOf(config.team.limits).minutes,
        startedAt: loop.startedAt,
        reason,
        watcher: loop.notified,
      };
      const item = deciders.length
        ? inbox.create({
            projectKey: task.projectKey,
            kind: 'decision',
            assignees: deciders,
            source: 'system',
            taskKey: task.key,
            title: `Loop on ${task.key}: ${loop.members.join(', ')}`,
            payload: { loop: payload },
            options: [LOOP_STOP_OPTION, LOOP_LET_RUN_OPTION],
          })
        : null;
      const updated: TaskLoopRecord = {
        ...loop,
        phase: 'owner',
        ownerReason: reason,
        deciders,
        inboxItemId: item?.id ?? null,
        triage: loop.triage ? { ...loop.triage, pendingSignalId: null } : null,
      };
      ctx.repos.taskLoops.save(updated);
      this.resolveSignal(loop);
      this.record(task, updated, reason === 'continued' ? 'escalated' : 'raised', {
        notified: loop.notified,
        deciders,
        reason,
      });
    });
    this.deps.tasks.publish(task);
  }

  private end(loop: TaskLoopRecord, reason: EndReason, by?: string): void {
    const { ctx, inbox, timeline, tasks } = this.deps;
    ctx.unitOfWork(() => {
      if (loop.triage)
        ctx.repos.taskLoops.save({ ...loop, triage: { ...loop.triage, pendingSignalId: null } });
      ctx.repos.taskLoops.close(loop.id, isoNow(ctx), reason);
      this.resolveSignal(loop);
      if (loop.inboxItemId) inbox.resolveByRule(loop.inboxItemId, 'ended', 'loop_ended');
      timeline.append({
        projectKey: loop.projectKey,
        taskKey: loop.taskKey,
        actor: SYSTEM_ACTOR,
        type: 'task_loop',
        data: {
          loopId: loop.id,
          phase: 'ended',
          members: loop.members,
          count: loop.count,
          minutes: this.minutesOf(loop.projectKey),
          endReason: reason,
          ...(by ? { by } : {}),
        },
      });
    });
    const task = tasks.find(loop.projectKey, loop.taskKey);
    if (task) tasks.publish(task);
  }

  private minutesOf(projectKey: string): number {
    return loopWatchOf(this.deps.projects.cachedConfig(projectKey)?.team.limits).minutes;
  }

  private record(
    task: Pick<Task, 'projectKey' | 'key'>,
    loop: TaskLoopRecord,
    phase: 'raised' | 'escalated',
    extra: { notified?: string | null; deciders?: string[]; reason?: 'no_watcher' | 'continued' },
  ): void {
    this.deps.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor: SYSTEM_ACTOR,
      type: 'task_loop',
      data: {
        loopId: loop.id,
        phase,
        members: loop.members,
        count: loop.count,
        minutes: this.minutesOf(task.projectKey),
        ...extra,
      },
    });
  }
}

function talkOf(event: TimelineEvent): LoopTalk {
  const to = Array.isArray(event.data.to)
    ? event.data.to.filter((t): t is string => typeof t === 'string')
    : [];
  return { at: event.createdAt, from: event.actor.handle ?? '', to };
}
