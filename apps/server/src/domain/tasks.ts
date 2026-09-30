import type { PullRequestInfo } from '../contracts';
import type {
  Actor,
  CreateTaskCommentRequest,
  TimelineEvent,
  CancelTaskRequest,
  CheckName,
  CheckState,
  CreateTaskRequest,
  InboxItem,
  ProjectConfig,
  Stage,
  Task,
  TaskDetail,
  TaskStartWaiting,
  TaskPullRequest,
  TaskLink,
  UpdateTaskRequest,
} from '@projectman/shared';
import { isoNow } from './context';
import type { DomainContext } from './context';
import { conflict, forbidden, invalid, notFound } from './errors';
import { hasAccess } from './access';
import { commentMentions, taskAuthors } from '@projectman/shared';
import { evaluateGates, stagesEntered } from './gates';
import type { ApprovalRequirement, GateEvaluation } from './gates';
import { DECISION_OPTIONS } from './inbox';
import type { InboxService } from './inbox';
import type { ProjectService } from './projects';
import { LIVE_SESSION_STATES } from './sessions';
import type { TimelineService } from './timeline';
import { actorHandle, humanActor, newId, SYSTEM_ACTOR, unique } from './util';

export interface MoveResult {
  task: Task;
  moved: boolean;
  /** Decision items waiting for approvers when the target stage needs a human approval. */
  pendingApproval: InboxItem[];
}

/** Payload of a `decision` inbox item created for a human_approval gate condition. */
export interface GateRequestPayload {
  requestId: string;
  taskKey: string;
  fromStageId: string;
  toStageId: string;
  /** Stage whose gate holds the condition (moving forward may enter several gated stages). */
  stageId: string;
  conditionIndex: number;
  requestedBy: Actor;
}

export interface StageChange {
  task: Task;
  from: string;
  to: string;
  actor: Actor;
}

export type StageChangeListener = (change: StageChange) => void | Promise<void>;

export function gatePayload(item: InboxItem): GateRequestPayload | null {
  const gate = item.payload.gate;
  return gate && typeof gate === 'object' ? (gate as GateRequestPayload) : null;
}

export function gateBlockedError(evaluation: GateEvaluation) {
  return conflict('gate_blocked', 'the gate conditions of the target stage are not met', {
    unmet: evaluation.unmet,
    approvals: evaluation.approvals,
  });
}

export function approvalRequestedError(items: InboxItem[]) {
  return conflict(
    'approval_requested',
    'a human approval was requested; the task moves once it is approved',
    {
      inboxItemIds: items.map((i) => i.id),
      approvers: unique(items.flatMap((i) => i.assignees)),
    },
  );
}

const CLOSED = new Set(['done', 'cancelled']);

export function isOpenTask(task: Task): boolean {
  return !CLOSED.has(task.status);
}

/**
 * Tasks: creation (keys KEY-n), edits, checks, links, notes, assignment and stage moves.
 * Every action is attributed to an Actor in the timeline. Stage moves evaluate the gates.
 */
export class TaskService {
  private readonly ctx: DomainContext;
  private readonly timeline: TimelineService;
  private readonly projects: ProjectService;
  private readonly inbox: InboxService;
  private readonly pullRequestLogins = new Map<string, string>();
  private readonly pullRequests = new Map<string, TaskPullRequest>();
  private startWaitingReader: (task: Task) => TaskStartWaiting | undefined = () => undefined;
  private readonly stageListeners: StageChangeListener[] = [];
  private readonly cancelListeners: Array<(task: Task) => Promise<void>> = [];

  constructor(deps: {
    ctx: DomainContext;
    timeline: TimelineService;
    projects: ProjectService;
    inbox: InboxService;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
    this.inbox = deps.inbox;
  }

  private noteNotifier?: (event: TimelineEvent, mentions: string[]) => Promise<void>;

  onNoteAdded(notifier: NonNullable<TaskService['noteNotifier']>): void {
    this.noteNotifier = notifier;
  }

  onStageChanged(listener: StageChangeListener): void {
    this.stageListeners.push(listener);
  }

  onCancelled(listener: (task: Task) => Promise<void>): void {
    this.cancelListeners.push(listener);
  }

  setStartWaitingReader(reader: (task: Task) => TaskStartWaiting | undefined): void {
    this.startWaitingReader = reader;
  }

  private view(task: Task): Task {
    const { startWaiting: _, ...rest } = task;
    const startWaiting = this.startWaitingReader(task);
    return startWaiting ? { ...rest, startWaiting } : rest;
  }

  list(projectKey: string): Task[] {
    return this.ctx.repos.tasks.list(projectKey).map((task) => this.view(task));
  }

  get(projectKey: string, taskKey: string): Task {
    const task = this.ctx.repos.tasks.get(taskKey);
    if (!task || task.projectKey !== projectKey) throw notFound('task', taskKey);
    return this.view(task);
  }

  find(projectKey: string, taskKey: string): Task | null {
    const task = this.ctx.repos.tasks.get(taskKey);
    return task && task.projectKey === projectKey ? this.view(task) : null;
  }

  detail(projectKey: string, taskKey: string, timelineLimit = 100): TaskDetail {
    const task = this.get(projectKey, taskKey);
    return {
      task,
      pullRequests: task.links
        .filter((link) => link.kind === 'pull_request')
        .flatMap((link) => {
          const number = Number(link.ref);
          if (!link.repo || !Number.isInteger(number) || number <= 0) return [];
          const known = this.pullRequests.get(`${link.repo}#${number}`);
          return [
            known ?? {
              repo: link.repo,
              number,
              url: null,
              title: link.title ?? null,
              state: ['open', 'closed', 'merged', 'draft'].includes(link.state ?? '')
                ? (link.state as TaskPullRequest['state'])
                : null,
              checks: null,
              reviewDecision: null,
              additions: null,
              deletions: null,
            },
          ];
        }),
      timeline: this.timeline.list(projectKey, { taskKey, limit: timelineLimit }),
      sessions: this.ctx.repos.sessions.list(projectKey, { taskKey }),
    };
  }

  /** `sessionId`: the AI session the task was created from (recorded in the timeline). */
  async create(
    projectKey: string,
    req: CreateTaskRequest,
    actor: Actor,
    opts: { sessionId?: string | null } = {},
  ): Promise<Task> {
    const config = await this.projects.config(projectKey);
    if (req.importedAt !== undefined) {
      const member = config.team.members.find((member) => member.handle === actor.handle);
      if (actor.kind !== 'human' || member?.kind !== 'human' || member.access !== 'owner')
        throw forbidden('owner_only', 'only an owner may import tasks');
    }
    const first = config.pipeline.stages[0]!;
    const target = req.stageId ? findStage(config, req.stageId) : first;
    const title = req.title.trim();
    if (!title) throw invalid('invalid_request', 'title must not be empty');
    const repo = req.repo ?? null;
    if (repo && !config.project.repos.some((r) => r.name === repo)) {
      throw invalid('unknown_repo', `unknown repository: ${repo}`);
    }
    const at = req.importedAt ?? isoNow(this.ctx);
    const task: Task = {
      id: newId('tsk'),
      projectKey,
      key: `${projectKey}-0`,
      title,
      description: req.description ?? '',
      stageId: first.id,
      status: 'active',
      assignee: null,
      repo,
      priority: null,
      labels: req.labels ?? [],
      checks: {},
      links: [],
      visibility: req.visibility ?? 'internal',
      createdBy: actorHandle(actor),
      createdAt: at,
      updatedAt: at,
      closedAt: null,
    };
    if (target.id !== first.id) {
      // A new task has no checks or links: it may start in any stage up to the first gated one.
      if (req.importedAt === undefined) {
        const evaluation = evaluateGates(task, stagesEntered(config.pipeline, first.id, target.id), config);
        if (evaluation.unmet.length > 0 || evaluation.approvals.length > 0)
          throw gateBlockedError(evaluation);
      }
      task.stageId = target.id;
    }
    if (target.kind === 'done') {
      task.status = 'done';
      task.closedAt = at;
    }
    task.key = `${projectKey}-${this.ctx.repos.counters.next(projectKey, 'task')}`;
    this.ctx.repos.tasks.insert(task);
    this.timeline.append({
      projectKey,
      taskKey: task.key,
      sessionId: opts.sessionId ?? null,
      actor,
      type: 'task_created',
      data: { title, ...(req.importedAt !== undefined ? { imported: true } : {}) },
      createdAt: at,
    });
    this.publish(task);
    return task;
  }

  /** Applies a stage move first (gated); other fields are changed only if the move went through. */
  async update(
    projectKey: string,
    taskKey: string,
    req: UpdateTaskRequest,
    actor: Actor,
    opts: { sessionId?: string | null } = {},
  ): Promise<Task> {
    if (req.assignee !== undefined) {
      const config = await this.requireLifecycleAccess(projectKey, actor);
      this.get(projectKey, taskKey);
      if (req.assignee !== null && !config.team.members.some((m) => m.handle === req.assignee)) {
        throw invalid('unknown_member', `unknown member: ${req.assignee}`);
      }
      const live = this.ctx.repos.sessions
        .list(projectKey, { taskKey })
        .find((s) => LIVE_SESSION_STATES.includes(s.state));
      if (live) {
        throw conflict('task_session_live', `task ${taskKey} has a live session`, { sessionId: live.id });
      }
    }
    let task = this.get(projectKey, taskKey);
    if (req.stageId !== undefined && req.stageId !== task.stageId) {
      const result = await this.moveToStage(projectKey, taskKey, req.stageId, actor);
      if (!result.moved) throw approvalRequestedError(result.pendingApproval);
      task = result.task;
    }
    const next: Task = { ...task };
    const fields: string[] = [];
    if (req.title !== undefined && req.title.trim() !== task.title) {
      if (!req.title.trim()) throw invalid('invalid_request', 'title must not be empty');
      next.title = req.title.trim();
      fields.push('title');
    }
    if (req.description !== undefined && req.description !== task.description) {
      next.description = req.description;
      fields.push('description');
    }
    if (req.labels !== undefined && JSON.stringify(req.labels) !== JSON.stringify(task.labels)) {
      next.labels = req.labels;
      fields.push('labels');
    }
    if (req.visibility !== undefined && req.visibility !== task.visibility) {
      next.visibility = req.visibility;
      fields.push('visibility');
    }
    const assignmentChanged = req.assignee !== undefined && req.assignee !== task.assignee;
    if (req.assignee !== undefined) next.assignee = req.assignee;
    if (fields.length === 0 && !assignmentChanged) return task;
    next.updatedAt = isoNow(this.ctx);
    this.ctx.repos.tasks.update(next);
    if (fields.length > 0) {
      this.timeline.append({
        projectKey,
        taskKey,
        sessionId: opts.sessionId ?? null,
        actor,
        type: 'task_updated',
        data: { fields },
      });
    }
    if (assignmentChanged) {
      this.timeline.append({
        projectKey,
        taskKey,
        actor,
        type: 'task_assigned',
        data: { assignee: next.assignee, previous: task.assignee },
      });
    }
    this.publish(next);
    return next;
  }

  /** Closes the task and stops its sessions while preserving assignment, stage and files. */
  async cancel(projectKey: string, taskKey: string, req: CancelTaskRequest, actor: Actor): Promise<Task> {
    await this.requireLifecycleAccess(projectKey, actor);
    const task = this.get(projectKey, taskKey);
    if (!isOpenTask(task)) throw conflict('task_closed', `task ${taskKey} is ${task.status}`);
    const at = isoNow(this.ctx);
    const next: Task = { ...task, status: 'cancelled', closedAt: at, updatedAt: at };
    this.ctx.repos.tasks.update(next);
    this.timeline.append({
      projectKey,
      taskKey,
      actor,
      type: 'task_updated',
      data: {
        fields: ['status', 'closedAt'],
        action: 'cancelled',
        previousStatus: task.status,
        ...(req.reason !== undefined ? { reason: req.reason } : {}),
      },
    });
    this.publish(next);
    for (const listener of this.cancelListeners) await listener(next);
    return next;
  }

  /** Reopens in the same stage, with no assignee; starting work remains explicit. */
  async reopen(projectKey: string, taskKey: string, actor: Actor): Promise<Task> {
    await this.requireLifecycleAccess(projectKey, actor);
    const task = this.get(projectKey, taskKey);
    if (task.status !== 'cancelled') {
      throw conflict('task_not_cancelled', `task ${taskKey} is not cancelled`);
    }
    const next: Task = {
      ...task,
      status: 'active',
      closedAt: null,
      assignee: null,
      updatedAt: isoNow(this.ctx),
    };
    this.ctx.repos.tasks.update(next);
    this.timeline.append({
      projectKey,
      taskKey,
      actor,
      type: 'task_updated',
      data: {
        fields: ['status', 'closedAt', 'assignee'],
        action: 'reopened',
        previousAssignee: task.assignee,
      },
    });
    this.publish(next);
    return next;
  }

  private async requireLifecycleAccess(projectKey: string, actor: Actor): Promise<ProjectConfig> {
    const config = await this.projects.config(projectKey);
    const member = config.team.members.find((m) => m.handle === actor.handle);
    if (actor.kind !== 'human' || member?.kind !== 'human' || !hasAccess(member.access, 'admin')) {
      throw forbidden('insufficient_access', 'requires admin access');
    }
    return config;
  }

  /**
   * Moves a task to a stage if the gates allow it. Unmet conditions throw `gate_blocked`;
   * human approvals create `decision` inbox items for the approvers and the task moves only
   * once they approve (an AI member can never resolve inbox items).
   */
  async moveToStage(projectKey: string, taskKey: string, stageId: string, actor: Actor): Promise<MoveResult> {
    const config = await this.projects.config(projectKey);
    const task = this.get(projectKey, taskKey);
    if (task.status === 'cancelled') throw conflict('task_closed', `task ${taskKey} is cancelled`);
    const target = findStage(config, stageId);
    if (task.stageId === target.id) return { task, moved: false, pendingApproval: [] };
    const evaluation = evaluateGates(task, stagesEntered(config.pipeline, task.stageId, target.id), config);
    if (evaluation.unmet.length > 0) throw gateBlockedError(evaluation);
    if (evaluation.approvals.length > 0) {
      const pending = this.requestApproval(task, target, evaluation.approvals, actor);
      return { task: this.get(projectKey, taskKey), moved: false, pendingApproval: pending };
    }
    return { task: await this.applyMove(task, target, actor, {}), moved: true, pendingApproval: [] };
  }

  /** Handler for resolved `decision` items: completes (or drops) the requested stage move. */
  async handleDecisionResolved(item: InboxItem): Promise<void> {
    const gate = gatePayload(item);
    const resolution = item.resolution;
    if (!gate || !resolution) return;
    const task = this.find(item.projectKey, gate.taskKey);
    if (!task) return;
    const actor = humanActor(resolution.by);
    const siblings = this.inbox
      .list(item.projectKey, { kind: 'decision', taskKey: task.key })
      .filter((i) => gatePayload(i)?.requestId === gate.requestId);

    if (resolution.optionId !== 'approve') {
      for (const s of siblings) if (s.state === 'open') this.inbox.cancel(s.id);
      this.settleWaiting(task, actor, {
        gateRejected: { requestId: gate.requestId, to: gate.toStageId, inboxItemId: item.id },
      });
      return;
    }
    if (siblings.some((s) => s.state === 'open')) return; // other approvers still have to decide
    if (!siblings.every((s) => s.state === 'resolved' && s.resolution?.optionId === 'approve')) return;
    if (task.stageId !== gate.fromStageId || task.status === 'cancelled') return; // stale request

    const config = await this.projects.config(item.projectKey);
    const target = config.pipeline.stages.find((s) => s.id === gate.toStageId);
    if (!target) {
      this.settleWaiting(task, actor, { gateBlocked: { to: gate.toStageId, reason: 'unknown_stage' } });
      return;
    }
    const evaluation = evaluateGates(task, stagesEntered(config.pipeline, task.stageId, target.id), config);
    const approvalsStillValid = evaluation.approvals.every((req) =>
      siblings.some((s) => {
        const p = gatePayload(s);
        return (
          p?.stageId === req.stageId &&
          p.conditionIndex === req.conditionIndex &&
          req.approvers.includes(s.resolution!.by)
        );
      }),
    );
    if (evaluation.unmet.length > 0 || !approvalsStillValid) {
      this.settleWaiting(task, actor, {
        gateBlocked: { to: target.id, unmet: evaluation.unmet, approvalsStillValid },
      });
      return;
    }
    await this.applyMove(task, target, actor, {
      approvedBy: unique(siblings.map((s) => s.resolution!.by)),
      inboxItemIds: siblings.map((s) => s.id),
    });
  }

  setCheck(
    projectKey: string,
    taskKey: string,
    check: CheckName,
    state: CheckState,
    actor: Actor,
    sessionId: string | null = null,
  ): Task {
    const task = this.get(projectKey, taskKey);
    if (check !== 'client_test' && taskAuthors(task).includes(actor.handle ?? ''))
      throw forbidden(
        'self_review_forbidden',
        'the assignee and PR authors cannot record review or QA results',
      );
    const from = task.checks[check] ?? null;
    if (from === state) return task;
    const next: Task = { ...task, checks: { ...task.checks, [check]: state }, updatedAt: isoNow(this.ctx) };
    this.ctx.repos.tasks.update(next);
    this.timeline.append({
      projectKey,
      taskKey,
      sessionId,
      actor,
      type: 'task_check_changed',
      data: { check, from, to: state },
    });
    this.publish(next);
    return next;
  }

  async addNote(
    projectKey: string,
    taskKey: string,
    text: string,
    actor: Actor,
    sessionId: string | null = null,
    imported: Pick<CreateTaskCommentRequest, 'importedAuthor' | 'importedAt'> = {},
  ): Promise<TimelineEvent> {
    this.get(projectKey, taskKey);
    const config = await this.projects.config(projectKey);
    const isImported = imported.importedAuthor !== undefined || imported.importedAt !== undefined;
    if (
      isImported &&
      !config.team.members.some(
        (member) =>
          member.handle === actor.handle &&
          member.kind === 'human' &&
          member.access === 'owner' &&
          actor.kind === 'human',
      )
    )
      throw forbidden('insufficient_access', 'imported comments require owner access');
    const mentions = commentMentions(
      text,
      config.team.members.map((member) => member.handle),
      actor.handle,
    );
    const event = this.timeline.append({
      projectKey,
      taskKey,
      sessionId,
      actor,
      type: 'task_note',
      data: { text, mentions, ...imported },
    });
    if (!isImported && mentions.length) await this.noteNotifier?.(event, mentions);
    return event;
  }

  assign(
    projectKey: string,
    taskKey: string,
    assignee: string | null,
    actor: Actor,
    extra: Record<string, unknown> = {},
  ): Task {
    const task = this.get(projectKey, taskKey);
    if (task.assignee === assignee) return task;
    const next: Task = { ...task, assignee, updatedAt: isoNow(this.ctx) };
    this.ctx.repos.tasks.update(next);
    this.timeline.append({
      projectKey,
      taskKey,
      actor,
      type: 'task_assigned',
      data: { assignee, previous: task.assignee, ...extra },
    });
    this.publish(next);
    return next;
  }

  addLink(
    projectKey: string,
    taskKey: string,
    link: TaskLink,
    actor: Actor,
    sessionId: string | null = null,
  ): Task {
    const task = this.get(projectKey, taskKey);
    // Preserve authorship across reassignment; a linked PR defaults to its task's implementer.
    if (link.kind === 'pull_request' && !link.author) {
      const author =
        this.memberForGithubLogin(projectKey, this.pullRequestLogins.get(`${link.repo}#${link.ref}`)) ??
        task.assignee;
      if (author) link = { ...link, author };
    }
    const result = this.ctx.repos.tasks.upsertLink(task.id, link, isoNow(this.ctx));
    if (result === 'unchanged') return task;
    const next = this.get(projectKey, taskKey);
    if (result === 'inserted') {
      const data: Record<string, unknown> = { kind: link.kind, ref: link.ref };
      if (link.repo) data.repo = link.repo;
      this.timeline.append({ projectKey, taskKey, sessionId, actor, type: 'task_link_added', data });
    }
    this.publish(next);
    return next;
  }

  private memberForGithubLogin(projectKey: string, login: string | undefined): string | undefined {
    if (!login) return undefined;
    return this.projects
      .cachedConfig(projectKey)
      ?.team.members.find((member) => member.githubLogin?.toLowerCase() === login.toLowerCase())?.handle;
  }

  /** Keeps the full snapshot already fetched by GitHub; unknown links remain nullable. */
  recordPullRequest(pr: PullRequestInfo): void {
    const snapshot: TaskPullRequest = {
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      state: pr.state,
      checks:
        pr.checks === 'success'
          ? 'passing'
          : pr.checks === 'failure'
            ? 'failing'
            : pr.checks === 'pending'
              ? 'pending'
              : null,
      reviewDecision: pr.reviewDecision,
      additions: pr.additions,
      deletions: pr.deletions,
    };
    let authorChanged = false;
    if (pr.authorLogin) this.pullRequestLogins.set(`${pr.repo}#${pr.number}`, pr.authorLogin);
    for (const link of this.ctx.repos.tasks.findByPullRequest(pr.repo, pr.number)) {
      const author = this.memberForGithubLogin(link.projectKey, pr.authorLogin);
      if (author)
        authorChanged =
          this.ctx.repos.tasks.attributePullRequestAuthor(
            link.projectKey,
            pr.repo,
            pr.number,
            author,
            isoNow(this.ctx),
          ) || authorChanged;
    }
    const key = `${pr.repo}#${pr.number}`;
    if (!authorChanged && JSON.stringify(this.pullRequests.get(key)) === JSON.stringify(snapshot)) return;
    this.pullRequests.set(key, snapshot);
    for (const link of this.ctx.repos.tasks.findByPullRequest(pr.repo, pr.number)) {
      const task = this.find(link.projectKey, link.taskKey);
      if (task) this.publish(task);
    }
  }

  /** A watched pull request changed: refresh every task link to it. Returns the tasks linking it. */
  applyPullRequestUpdate(repo: string, number: number, patch: { state: string; title?: string }): Task[] {
    const changed = this.ctx.repos.tasks.updatePullRequestLinks(repo, number, patch, isoNow(this.ctx));
    const tasks: Task[] = [];
    for (const key of changed) {
      const task = this.ctx.repos.tasks.get(key);
      if (!task) continue;
      this.timeline.append({
        projectKey: task.projectKey,
        taskKey: key,
        actor: SYSTEM_ACTOR,
        type: 'task_updated',
        data: { fields: ['links'], pullRequest: { repo, number, state: patch.state } },
      });
      this.publish(task);
      tasks.push(task);
    }
    return tasks;
  }

  /** Open tasks of members who left the team lose their assignee. */
  unassignMembers(projectKey: string, handles: Iterable<string>, actor: Actor): void {
    for (const handle of handles) {
      for (const task of this.ctx.repos.tasks.listByAssignee(projectKey, handle)) {
        if (isOpenTask(task)) this.assign(projectKey, task.key, null, actor, { reason: 'member_removed' });
      }
    }
  }

  publish(task: Task): void {
    this.ctx.bus.publish({ type: 'task_upserted', projectKey: task.projectKey, task: this.view(task) });
  }

  private requestApproval(
    task: Task,
    target: Stage,
    approvals: ApprovalRequirement[],
    actor: Actor,
  ): InboxItem[] {
    const open = this.inbox
      .list(task.projectKey, { kind: 'decision', state: 'open', taskKey: task.key })
      .filter((i) => {
        const p = gatePayload(i);
        return p?.toStageId === target.id && p.fromStageId === task.stageId;
      });
    if (open.length > 0) return open;

    if (approvals.some((req) => req.approvers.length === 0))
      throw conflict('release_four_eyes', 'no independent human approver is available');
    const requestId = newId('gat');
    const items = approvals.map((req) => {
      const payload: GateRequestPayload = {
        requestId,
        taskKey: task.key,
        fromStageId: task.stageId,
        toStageId: target.id,
        stageId: req.stageId,
        conditionIndex: req.conditionIndex,
        requestedBy: actor,
      };
      return this.inbox.create({
        projectKey: task.projectKey,
        kind: 'decision',
        assignees: req.approvers,
        source: actorHandle(actor),
        taskKey: task.key,
        title: task.title,
        payload: { gate: payload },
        options: DECISION_OPTIONS,
      });
    });
    const next: Task =
      task.status === 'active' ? { ...task, status: 'waiting', updatedAt: isoNow(this.ctx) } : task;
    if (next !== task) this.ctx.repos.tasks.update(next);
    this.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_updated',
      data: {
        fields: next !== task ? ['status'] : [],
        gateRequest: { requestId, from: task.stageId, to: target.id, inboxItemIds: items.map((i) => i.id) },
      },
    });
    if (next !== task) this.publish(next);
    return items;
  }

  private async applyMove(
    task: Task,
    target: Stage,
    actor: Actor,
    extra: Record<string, unknown>,
  ): Promise<Task> {
    const at = isoNow(this.ctx);
    const next: Task = { ...task, stageId: target.id, updatedAt: at };
    if (target.kind === 'done') {
      next.status = 'done';
      next.closedAt = at;
    } else if (task.status === 'done' || task.status === 'waiting') {
      next.status = 'active';
      next.closedAt = null;
    }
    this.ctx.repos.tasks.update(next);
    this.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_stage_changed',
      data: { from: task.stageId, to: target.id, ...extra },
    });
    this.publish(next);
    // Requests made from the previous stage are stale now.
    for (const item of this.inbox.list(task.projectKey, {
      kind: 'decision',
      state: 'open',
      taskKey: task.key,
    })) {
      this.inbox.cancel(item.id);
    }
    for (const listener of this.stageListeners) {
      try {
        await listener({ task: next, from: task.stageId, to: target.id, actor });
      } catch (err) {
        this.ctx.logger.error({ err, taskKey: task.key }, 'stage change listener failed');
      }
    }
    return next;
  }

  /** Ends the "waiting for approval" status after a rejected or dropped request. */
  private settleWaiting(task: Task, actor: Actor, data: Record<string, unknown>): void {
    const next: Task =
      task.status === 'waiting' ? { ...task, status: 'active', updatedAt: isoNow(this.ctx) } : task;
    if (next !== task) this.ctx.repos.tasks.update(next);
    this.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_updated',
      data: { fields: next !== task ? ['status'] : [], ...data },
    });
    if (next !== task) this.publish(next);
  }
}

function findStage(config: ProjectConfig, stageId: string): Stage {
  const stage = config.pipeline.stages.find((s) => s.id === stageId);
  if (!stage) throw invalid('unknown_stage', `unknown stage: ${stageId}`);
  return stage;
}
