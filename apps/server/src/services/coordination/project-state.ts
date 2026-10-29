import type { OperatorPauses, WaitingStarts, OperatorDiagnosticSources } from './ports';
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
  isProjectManager,
  coordinationActorRefusal,
  LOCAL_ENGINE_ID,
  TaskStartWaiting,
} from '@projectman/shared';
import type { Session, OperatorDiagnostics } from '@projectman/shared';
import { z } from 'zod';
import type { ToolContext } from '../../contracts';
import type { OperatorRequests } from './requests';
import type { MessageStateReport, ProjectStateReport, TaskStateReport } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import type { TaskService, TaskWaits } from '../../core/tasks';
import type { OperatorSignals } from './signals';
import { LIVE_SESSION_STATES } from '@projectman/shared';
import { forbidden, invalid, notFound } from '../../kernel';
import { staleReasonFor, wakeFactsFor } from '../../core/messages';

/** Read-only reports over the server's existing work records. */
export class ProjectState {
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    pauses: Pick<OperatorPauses, 'projectView'>;
    deferred: WaitingStarts;
    taskWaits: Pick<TaskWaits, 'ofCard'>;
    operatorSignals: Pick<OperatorSignals, 'active'>;
    requests: Pick<OperatorRequests, 'openFor'>;
    diagnostics: OperatorDiagnosticSources;
  };

  constructor(deps: ProjectState['deps']) {
    this.deps = deps;
  }

  /** Read current records only; no transcript, log parsing, SQL or shell access. */
  async diagnostics(ctx: ToolContext, taskKey: string, limit = 10): Promise<OperatorDiagnostics> {
    return this.readDiagnostics(ctx.projectKey, taskKey, limit, () => this.diagnosticCaller(ctx));
  }

  /**
   * The same report for the integrator's bearer MCP (PM-760), which has no member and no session. The
   * caller has already been authorized for the project by the external adapter; `recheck` asks it again after
   * the machine read, which can wait for an engine.
   */
  async externalDiagnostics(
    projectKey: string,
    taskKey: string,
    limit: number | undefined,
    recheck: () => Promise<void>,
  ): Promise<OperatorDiagnostics> {
    return this.readDiagnostics(projectKey, taskKey, limit ?? 10, recheck);
  }

  private async readDiagnostics(
    projectKey: string,
    taskKey: string,
    limit: number,
    caller: () => Promise<void>,
  ): Promise<OperatorDiagnostics> {
    if (!z.number().int().min(1).max(20).safeParse(limit).success)
      throw invalid('invalid_request', 'limit must be an integer from 1 to 20');
    await caller();
    this.deps.tasks.get(projectKey, taskKey);
    const sessionsForTask = () =>
      this.deps.ctx.repos.sessions
        .list(projectKey, { taskKey })
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id));
    const machine = await this.deps.diagnostics.machine(sessionsForTask()[0]).catch(() => null);
    // Machine reads can wait for an engine: recheck the actor and card after that boundary.
    await caller();
    const task = await this.task(projectKey, taskKey);
    const sessions = sessionsForTask()
      .slice(0, limit)
      .map((session) => ({
        id: session.id,
        member: session.member,
        state: session.state,
        lastActivityAt: session.lastActivityAt,
        lastTool: session.workMetadata?.lastTool
          ? { name: session.workMetadata.lastTool.name, at: session.workMetadata.lastTool.at }
          : null,
        lastError: session.workMetadata?.lastError
          ? { code: session.workMetadata.lastError.code, at: session.workMetadata.lastError.at }
          : null,
      }));
    const messages = this.deps.ctx.repos.messages
      .list(projectKey, { taskKey, limit })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit);
    const deliveries = await Promise.all(messages.map((message) => this.message(projectKey, message.id)));
    const checks = this.deps.diagnostics
      .checks(projectKey, taskKey)
      .sort((a, b) => b.at.localeCompare(a.at) || b.runId.localeCompare(a.runId))
      .slice(0, limit)
      .map((check) => ({
        runId: check.runId,
        outcome: check.outcome,
        failedFiles: [...check.failedFiles],
        at: check.at,
      }));
    await caller();
    const latest = sessionsForTask()[0];
    const currentMachine =
      latest && (latest.engineId ?? LOCAL_ENGINE_ID) === machine?.engineId ? machine : null;
    return {
      task,
      asOf: this.deps.ctx.now().toISOString(),
      sessions,
      deliveries,
      checks,
      machine: currentMachine,
    };
  }

  private async diagnosticCaller(ctx: ToolContext): Promise<void> {
    const config = await this.deps.projects.config(ctx.projectKey);
    const member = memberOf(config, ctx.member);
    if (!isProjectManager(member))
      throw forbidden('operator_only', 'only the selected project manager may read diagnostics');
    const session = this.deps.ctx.repos.sessions.get(ctx.sessionId);
    if (
      coordinationActorRefusal(config, { kind: 'ai', handle: ctx.member }) ||
      !session ||
      session.projectKey !== ctx.projectKey ||
      session.member !== ctx.member ||
      session.workItem.type !== 'general' ||
      session.workItem.with !== undefined
    )
      throw forbidden('project_manager_only', 'diagnostics require your internal general session');
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
    const { ctx, projects } = this.deps;
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
        // The member queue says why the message has not started its session (PM-925): a limit, a pause, a login...
        const wait =
          ctx.repos.memberQueue
            .listOpenOfSource(projectKey, { type: 'message', id: message.id })
            .find((item) => item.member === handle)?.wait ?? null;
        const reason = wait ? TaskStartWaiting.shape.reason.safeParse(wait.code) : null;
        const stale = staleReasonFor(ctx, config, message, handle);
        return {
          ...base,
          human: false,
          session:
            live && LIVE_SESSION_STATES.includes(live.state)
              ? { id: live.id, state: live.state, since: live.lastActivityAt }
              : null,
          waiting: wait && reason?.success ? { reason: reason.data, since: wait.at } : null,
          lastStartFailure: wait && !reason?.success ? { code: wait.code, at: wait.at } : null,
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
    // Only open cards: a closed card has no start that waits and no place in the stage counts.
    const cards = tasks.listQuery(projectKey, { kind: 'open' }).filter((t) => !isTheme(t));
    const pause = pauses.projectView(projectKey);
    const owners = ownerHandles(config);
    const waitingStarts: ProjectStateReport['waitingStarts'] = this.deps.deferred
      .list()
      .filter(
        ({ start }) =>
          start.projectKey === projectKey &&
          // A start of a card that is not open (closed, or a theme) no longer applies.
          (start.taskKey === null
            ? start.stillValid(null)
            : cards.some((t) => t.key === start.taskKey && start.stillValid(t))),
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
    // A queued item that waits to wake its member's session says why in its wait code (PM-925).
    for (const wait of this.deps.deferred.queueWaits()) {
      const member = wait.waiting.member ?? null;
      if (
        wait.projectKey === projectKey &&
        !waitingStarts.some((s) => s.taskKey === wait.taskKey && s.member === member)
      )
        waitingStarts.push({ taskKey: wait.taskKey, member, reason: wait.waiting.reason });
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
        // The board shows only open cards; done and cancelled ones stay in their last stage.
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
      release: null,
      waitingMessages,
    };
  }
}

function sessionReport(session: Session) {
  return { id: session.id, member: session.member, state: session.state, since: session.lastActivityAt };
}
