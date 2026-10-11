import { conditionHolds, isOpenTask, isTheme, ownerHandles, stageOf, startBlock } from '@projectman/shared';
import type { Session } from '@projectman/shared';
import type { ProjectStateReport, TaskStateReport } from '../contracts';
import type { DomainContext } from './context';
import type { ProjectService } from './projects';
import type { TaskService } from './tasks';
import type { PauseService } from './pause';
import { LIVE_SESSION_STATES } from './sessions';
import type { DeferredStarts } from './admission';
import { invalid } from './errors';

/** Read-only reports over the server's existing work records. */
export class ProjectState {
  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    pauses: Pick<PauseService, 'projectView'>;
    deferred: DeferredStarts;
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
        .list(projectKey, { taskKey, kind: 'question', state: 'open' })
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

  async overview(projectKey: string): Promise<ProjectStateReport> {
    const { ctx, projects, tasks, pauses } = this.deps;
    const config = await projects.config(projectKey);
    const cards = tasks.list(projectKey).filter((t) => !isTheme(t));
    const pause = pauses.projectView(projectKey);
    const owners = ownerHandles(config);
    const waitingStarts = this.deps.deferred
      .list()
      .filter(
        ({ start }) =>
          start.projectKey === projectKey &&
          start.taskKey !== null &&
          start.stillValid(cards.find((t) => t.key === start.taskKey) ?? null),
      )
      .map(({ start, waiting }) => ({
        taskKey: start.taskKey!,
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
    return {
      paused: { project: !!pause.project, instance: !!pause.instance },
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
    };
  }
}

function sessionReport(session: Session) {
  return { id: session.id, member: session.member, state: session.state, since: session.lastActivityAt };
}
