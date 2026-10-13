import {
  conditionHolds,
  isOpenTask,
  isTheme,
  memberOf,
  messageRoute,
  messageWakeBlock,
  operatorWatchOf,
  ownerHandles,
  PENDING_INBOX_STATES,
  sessionWorkItemOf,
  stageOf,
  startBlock,
} from '@projectman/shared';
import type { Session } from '@projectman/shared';
import type { MessageStateReport, ProjectStateReport, TaskStateReport } from '../contracts';
import type { DomainContext } from './context';
import type { ProjectService } from './projects';
import type { TaskService, TaskWaits } from './tasks';
import type { OperatorSignals } from './operator-signals';
import type { PauseService } from './pause';
import type { ReleaseService } from './releases';
import { LIVE_SESSION_STATES } from './sessions';
import type { DeferredStarts, MessageStarts } from './admission';
import { invalid, notFound } from './errors';
import { staleReasonFor, wakeFactsFor } from './messaging';

/** Read-only reports over the server's existing work records. */
export class ProjectState {
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    pauses: Pick<PauseService, 'projectView'>;
    deferred: DeferredStarts;
    taskWaits: Pick<TaskWaits, 'ofCard'>;
    operatorSignals: Pick<OperatorSignals, 'active'>;
    messageStarts: Pick<MessageStarts, 'wakeKey' | 'lastFailure'>;
    releases: Pick<ReleaseService, 'overview'>;
  };

  constructor(deps: ProjectState['deps']) {
    this.deps = deps;
  }

  async task(projectKey: string, taskKey: string): Promise<TaskStateReport> {
    const { ctx, projects, tasks, pauses } = this.deps;
    const config = await projects.config(projectKey);
    const task = tasks.get(projectKey, taskKey);
    if (isTheme(task)) throw invalid('invalid_request', 'Project state requires a task, not a theme.');
    const stage = stageOf(config, task.stageId);
    if (!stage) throw invalid('unknown_stage', `Unknown stage: ${task.stageId}`);
    const next = config.pipeline.stages[config.pipeline.stages.indexOf(stage) + 1];
    const sessions = ctx.repos.sessions.list(projectKey, { taskKey });
    const session = sessions
      .filter((s) => LIVE_SESSION_STATES.includes(s.state))
      .sort(
        (a, b) =>
          Number(b.member === task.assignee) - Number(a.member === task.assignee) ||
          b.lastActivityAt.localeCompare(a.lastActivityAt),
      )[0];
    const pause = pauses.projectView(projectKey);
    const open = isOpenTask(task) && !isTheme(task);
    return {
      taskKey,
      title: task.title,
      stageId: task.stageId,
      stageKind: stage.kind,
      assignee: task.assignee,
      labels: task.labels,
      wait: this.deps.taskWaits.ofCard(config, task, null),
      signals: this.deps.operatorSignals.active(projectKey).filter((s) => s.taskKey === taskKey),
      startWaiting: task.startWaiting ?? null,
      startBlock: startBlock(task, config),
      missingGateLabels: [
        ...new Set(
          (next?.gate?.conditions ?? [])
            .filter((c) => c.type === 'has_label' && !conditionHolds(task, c))
            .map((c) => c.label),
        ),
      ],
      openQuestions: ctx.repos.inbox
        .list(projectKey, { taskKey, kind: 'question', state: PENDING_INBOX_STATES })
        .map((q) => ({ id: q.id, from: q.source, at: q.createdAt, title: q.title })),
      session: session ? sessionReport(session) : null,
      holds: [
        ...(open && task.fixLimit ? ['fix_limit' as const] : []),
        ...(open && ctx.repos.seniorWaits.open(projectKey, taskKey) ? ['senior_wait' as const] : []),
        ...(open && task.loop && task.loop.phase !== 'let_run' ? ['loop' as const] : []),
        ...(open && (pause.project || pause.instance) ? ['paused' as const] : []),
      ],
    };
  }

  /**
   * What became of one team message for each recipient (PM-543), from today's facts: the live session, the
   * admission deferral and the last failed start on the route, and why the message wakes nobody.
   */
  async message(projectKey: string, messageId: string): Promise<MessageStateReport> {
    const { ctx, projects, tasks, deferred, messageStarts } = this.deps;
    const config = await projects.config(projectKey);
    const message = ctx.repos.messages.get(messageId);
    if (!message || message.projectKey !== projectKey) throw notFound('message', messageId);
    const info = (message.kind ?? 'action') === 'info';
    return {
      messageId: message.id,
      from: message.from,
      taskKey: message.taskKey,
      kind: info ? 'info' : 'action',
      sentAt: message.createdAt,
      recipients: message.to.map((handle) => {
        const member = memberOf(config, handle);
        const route = messageRoute(message, handle);
        const base = {
          handle,
          deliveredAt: message.receipts?.find((r) => r.handle === handle)?.deliveredAt ?? null,
          route,
        };
        if (member?.kind !== 'ai')
          return {
            ...base,
            human: member?.kind === 'human',
            session: null,
            waiting: null,
            lastStartFailure: null,
            noWake: null,
            stale: null,
          };
        const live = ctx.repos.sessions.findByWorkItem(projectKey, handle, sessionWorkItemOf(member, route));
        const key = messageStarts.wakeKey(projectKey, handle, route);
        const entry = deferred.list().find(({ start }) => start.key === key);
        const card = route.type === 'task' ? tasks.find(projectKey, route.taskKey) : null;
        const stale = staleReasonFor(ctx, config, message, handle);
        return {
          ...base,
          human: false,
          session:
            live && LIVE_SESSION_STATES.includes(live.state)
              ? { id: live.id, state: live.state, since: live.lastActivityAt }
              : null,
          waiting:
            entry && entry.start.stillValid(card ?? null)
              ? { reason: entry.waiting.reason, since: entry.waiting.since }
              : null,
          lastStartFailure: messageStarts.lastFailure(projectKey, handle, route),
          noWake: info
            ? ('info' as const)
            : messageWakeBlock(message, wakeFactsFor(ctx, config, message, handle), stale),
          stale,
        };
      }),
    };
  }

  async overview(projectKey: string): Promise<ProjectStateReport> {
    const { ctx, projects, tasks, pauses } = this.deps;
    const config = await projects.config(projectKey);
    const cards = tasks.list(projectKey).filter((t) => !isTheme(t));
    const pause = pauses.projectView(projectKey);
    const owners = ownerHandles(config);
    const waitingStarts: ProjectStateReport['waitingStarts'] = this.deps.deferred
      .list()
      .filter(
        ({ start }) =>
          start.projectKey === projectKey &&
          start.stillValid(
            start.taskKey === null ? null : (cards.find((t) => t.key === start.taskKey) ?? null),
          ),
      )
      .map(({ start, waiting }) => ({
        taskKey: start.taskKey,
        member: waiting.member ?? null,
        reason: waiting.reason,
      }));
    for (const card of cards) {
      if (card.startWaiting && !waitingStarts.some((s) => s.taskKey === card.key))
        waitingStarts.push({
          taskKey: card.key,
          member: card.startWaiting.member ?? null,
          reason: card.startWaiting.reason,
        });
    }
    const waitingMessages: ProjectStateReport['waitingMessages'] = [];
    for (const member of config.team.members) {
      if (member.kind !== 'ai') continue;
      const pending = ctx.repos.messages.pending(projectKey, member.handle);
      if (pending.length === 0) continue;
      waitingMessages.push({
        member: member.handle,
        count: pending.length,
        oldestAt: pending.map((m) => m.createdAt).sort()[0]!,
      });
    }
    return {
      paused: { project: !!pause.project, instance: !!pause.instance },
      operatorWatch: operatorWatchOf(config),
      signals: this.deps.operatorSignals.active(projectKey),
      stages: config.pipeline.stages.map((s) => ({
        stageId: s.id,
        count: cards.filter((t) => t.stageId === s.id).length,
      })),
      sessions: ctx.repos.sessions
        .list(projectKey)
        .filter((s) => LIVE_SESSION_STATES.includes(s.state))
        .map((s) => ({
          ...sessionReport(s),
          taskKey: s.workItem.type === 'task' ? s.workItem.taskKey : null,
        })),
      waitingStarts,
      openOwnerItems: ctx.repos.inbox
        .list(projectKey, { state: 'open' })
        .filter((item) => item.assignees.some((handle) => owners.includes(handle)))
        .map((item) => ({ id: item.id, kind: item.kind, taskKey: item.taskKey, title: item.title })),
      release: await this.deps.releases.overview(projectKey),
      waitingMessages,
    };
  }
}

function sessionReport(session: Session) {
  return { id: session.id, member: session.member, state: session.state, since: session.lastActivityAt };
}
