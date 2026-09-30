import type {
  Actor,
  CreateTaskCommentRequest,
  TimelineEvent,
  CancelTaskRequest,
  CreateTaskRequest,
  InboxItem,
  ProjectConfig,
  Task,
  TaskDetail,
  TaskStartWaiting,
  TaskLink,
  TimelineEventData,
  Visibility,
} from '@projectman/shared';
import { evaluateMove, isOpenTask, memberOf } from '@projectman/shared';
import type { LabelChangeReason, LabelClearTrigger } from '@projectman/shared';
import type { PullRequestInfo } from '../../contracts';
import type { TaskPatch } from '../../db';
import { requireHuman } from '../access';
import { isoNow } from '../context';
import type { DomainContext } from '../context';
import { conflict, invalid } from '../errors';
import type { InboxService } from '../inbox';
import type { ProjectService } from '../projects';
import { PullRequestRecords } from '../pull-requests';
import { LIVE_SESSION_STATES } from '../sessions';
import type { TimelineService } from '../timeline';
import { actorHandle, newId, unique } from '../util';
import { labelsChange, planLabelsOrThrow, TaskLabels } from './labels';
import { approvalRequestedError, gateBlockedError, TaskMoves } from './moves';
import type { MoveResult, StageChangeListener } from './moves';
import { requireStage, runEffects, TaskStore } from './store';
import type { Effect, LabelNotifier, NoteNotifier } from './store';

/**
 * A change of a task in one step. The REST PATCH sends the fields, the assignee and the whole
 * label set; the update_task team tool sends labels to add and remove and a note.
 */
export interface TaskUpdate {
  title?: string;
  description?: string;
  visibility?: Visibility;
  parentKey?: string | null;
  /** Owner/admin only; null clears the assignee. Starting work is a separate call. */
  assignee?: string | null;
  /** The whole label set: turned into additions and removals. */
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  /** A comment for the timeline; with a label change it is the labels' comment. */
  note?: string;
  stageId?: string;
}

/**
 * Tasks: creation (keys KEY-n), edits, subtasks, links, notes, assignment, cancel and reopen;
 * labels (TaskLabels) and stage moves (TaskMoves) are separate parts. Every action is
 * attributed to an Actor in the timeline.
 */
export class TaskService {
  private readonly ctx: DomainContext;
  private readonly timeline: TimelineService;
  private readonly projects: ProjectService;
  private readonly store: TaskStore;
  private readonly labels: TaskLabels;
  private readonly moves: TaskMoves;
  private readonly pullRequests: PullRequestRecords;
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
    this.store = new TaskStore(deps);
    this.labels = new TaskLabels(this.store);
    this.moves = new TaskMoves({ store: this.store, labels: this.labels, inbox: deps.inbox });
    this.pullRequests = new PullRequestRecords({
      ...deps,
      find: (projectKey, taskKey) => this.store.find(projectKey, taskKey),
      publish: (task) => this.store.publish(task),
    });
  }

  onNoteAdded(notifier: NoteNotifier): void {
    this.store.noteNotifier = notifier;
  }

  /** Called when an added label notifies the task's assignee (wired to team messages). */
  onLabelNotify(notifier: LabelNotifier): void {
    this.store.labelNotifier = notifier;
  }

  onStageChanged(listener: StageChangeListener): void {
    this.moves.onStageChanged(listener);
  }

  onCancelled(listener: (task: Task) => Promise<void>): void {
    this.cancelListeners.push(listener);
  }

  setStartWaitingReader(reader: (task: Task) => TaskStartWaiting | undefined): void {
    this.store.startWaitingReader = reader;
  }

  list(projectKey: string): Task[] {
    return this.store.list(projectKey);
  }

  get(projectKey: string, taskKey: string): Task {
    return this.store.get(projectKey, taskKey);
  }

  find(projectKey: string, taskKey: string): Task | null {
    return this.store.find(projectKey, taskKey);
  }

  detail(projectKey: string, taskKey: string, timelineLimit = 100): TaskDetail {
    const task = this.get(projectKey, taskKey);
    return {
      task,
      parent: task.parentKey ? this.find(projectKey, task.parentKey) : null,
      subtasks: this.ctx.repos.tasks.children(projectKey, taskKey).map((child) => this.store.view(child)),
      pullRequests: this.pullRequests.forTask(task),
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
    if (req.importedAt !== undefined)
      requireHuman(config, actor, 'owner', { code: 'owner_only', message: 'only an owner may import tasks' });
    const first = config.pipeline.stages[0]!;
    const target = req.stageId ? requireStage(config, req.stageId) : first;
    const title = req.title.trim();
    if (!title) throw invalid('invalid_request', 'title must not be empty');
    const repo = req.repo ?? null;
    if (repo && !config.project.repos.some((r) => r.name === repo)) {
      throw invalid('unknown_repo', `unknown repository: ${repo}`);
    }
    if (req.parentKey) this.validateParent(projectKey, null, req.parentKey);
    const at = req.importedAt ?? isoNow(this.ctx);
    const task: Task = {
      parentKey: req.parentKey ?? null,
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
      labels: unique((req.labels ?? []).map((label) => label.trim()).filter(Boolean)),
      links: [],
      visibility: req.visibility ?? 'internal',
      createdBy: actorHandle(actor),
      createdAt: at,
      updatedAt: at,
      closedAt: null,
    };
    if (target.id !== first.id) {
      // A new task has only the labels it is created with and no links: it may start in any
      // stage its gates let it enter.
      if (req.importedAt === undefined) {
        const evaluation = evaluateMove(task, config, first.id, target.id);
        if (evaluation.unmet.length > 0 || evaluation.approvals.length > 0)
          throw gateBlockedError(evaluation);
      }
      task.stageId = target.id;
    }
    if (target.kind === 'done') {
      task.status = 'done';
      task.closedAt = at;
    }
    if (req.importedAt === undefined)
      planLabelsOrThrow(config, { ...task, labels: [] }, { add: task.labels }, actor, undefined);
    return this.ctx.unitOfWork(() => {
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
      if (task.parentKey) this.recordParentChange(task, null, actor, opts.sessionId);
      this.publish(task);
      return task;
    });
  }

  /**
   * Changes a task in one step, all or nothing (the REST PATCH and the update_task team tool):
   * fields, assignee, labels and a note first, then the stage move, so one change can add the
   * label a gate needs and pass it. Everything is validated before anything is written: label
   * refusals, then the gates against the labels the task will have. A move that needs a human
   * approval requests it with the rest applied and throws `approval_requested`.
   */
  async update(
    projectKey: string,
    taskKey: string,
    change: TaskUpdate,
    actor: Actor,
    opts: { sessionId?: string | null } = {},
  ): Promise<Task> {
    const config =
      change.assignee !== undefined
        ? await this.requireLifecycleAccess(projectKey, actor)
        : await this.projects.config(projectKey);
    const effects: Effect[] = [];
    const result = this.ctx.unitOfWork(() =>
      this.applyUpdate(config, this.get(projectKey, taskKey), change, actor, opts.sessionId ?? null, effects),
    );
    await runEffects(effects);
    if (result.pendingApproval) throw approvalRequestedError(result.pendingApproval);
    return result.task;
  }

  private applyUpdate(
    config: ProjectConfig,
    task: Task,
    change: TaskUpdate,
    actor: Actor,
    sessionId: string | null,
    effects: Effect[],
  ): { task: Task; pendingApproval?: InboxItem[] } {
    // Validate the whole change against the task as it will be.
    const patch: TaskPatch = {};
    const fields: string[] = [];
    if (change.title !== undefined && change.title.trim() !== task.title) {
      patch.title = change.title.trim();
      if (!patch.title) throw invalid('invalid_request', 'title must not be empty');
      fields.push('title');
    }
    if (change.description !== undefined && change.description !== task.description) {
      patch.description = change.description;
      fields.push('description');
    }
    if (change.visibility !== undefined && change.visibility !== task.visibility) {
      patch.visibility = change.visibility;
      fields.push('visibility');
    }
    if (change.parentKey) this.validateParent(task.projectKey, task.key, change.parentKey);
    if (change.parentKey !== undefined && change.parentKey !== (task.parentKey ?? null)) {
      patch.parentKey = change.parentKey;
      fields.push('parentKey');
    }
    if (change.assignee !== undefined) {
      if (change.assignee !== null && !memberOf(config, change.assignee))
        throw invalid('unknown_member', `unknown member: ${change.assignee}`);
      const live = this.ctx.repos.sessions
        .list(task.projectKey, { taskKey: task.key })
        .find((s) => LIVE_SESSION_STATES.includes(s.state));
      if (live)
        throw conflict('task_session_live', `task ${task.key} has a live session`, { sessionId: live.id });
      if (change.assignee !== task.assignee) patch.assignee = change.assignee;
    }
    const note = change.note?.trim() || undefined;
    const wanted = change.labels && unique(change.labels.map((label) => label.trim()).filter(Boolean));
    const labels = planLabelsOrThrow(
      config,
      { ...task, ...patch },
      wanted
        ? {
            add: wanted.filter((label) => !task.labels.includes(label)),
            remove: task.labels.filter((label) => !wanted.includes(label)),
          }
        : { add: change.addLabels, remove: change.removeLabels },
      actor,
      note,
    );
    const moving = change.stageId !== undefined && change.stageId !== task.stageId;
    if (moving) {
      if (task.status === 'cancelled') throw conflict('task_closed', `task ${task.key} is cancelled`);
      const prospective = { ...task, ...patch, labels: labels.labels };
      const evaluation = evaluateMove(
        prospective,
        config,
        task.stageId,
        requireStage(config, change.stageId!).id,
      );
      if (evaluation.unmet.length > 0) throw gateBlockedError(evaluation);
    }

    // Apply it.
    let next = task;
    const labelsChanged = labelsChange(labels);
    if (fields.length > 0 || patch.assignee !== undefined || labelsChanged) {
      next = this.store.write(task, {
        ...patch,
        ...(labelsChanged ? { labels: labels.labels } : {}),
        updatedAt: isoNow(this.ctx),
      });
      if (fields.length > 0)
        this.timeline.append({
          projectKey: task.projectKey,
          taskKey: task.key,
          sessionId,
          actor,
          type: 'task_updated',
          data: { fields },
        });
      if (labelsChanged)
        this.labels.record(config, next, labels, actor, { comment: note, sessionId }, effects);
      if (patch.assignee !== undefined)
        this.timeline.append({
          projectKey: task.projectKey,
          taskKey: task.key,
          actor,
          type: 'task_assigned',
          data: { assignee: next.assignee, previous: task.assignee },
        });
      if (patch.parentKey !== undefined)
        this.recordParentChange(next, task.parentKey ?? null, actor, sessionId);
      this.publish(next);
    }
    if (note && !labelsChanged) this.store.recordNote(config, next, note, actor, sessionId, effects);
    if (!moving) return { task: next };
    const moved = this.moves.move(config, next, change.stageId!, actor, effects);
    return moved.moved ? { task: moved.task } : { task: moved.task, pendingApproval: moved.pendingApproval };
  }

  private validateParent(projectKey: string, taskKey: string | null, parentKey: string): void {
    if (parentKey === taskKey) throw invalid('subtask_self_parent', 'a task cannot be its own parent');
    const parent = this.ctx.repos.tasks.get(parentKey);
    if (!parent) throw invalid('subtask_parent_not_found', 'the parent task does not exist');
    if (parent.projectKey !== projectKey)
      throw invalid('subtask_parent_project', 'the parent must belong to the same project');
    if (parent.parentKey) throw invalid('subtask_parent_is_subtask', 'a subtask cannot have subtasks');
    if (taskKey && this.ctx.repos.tasks.children(projectKey, taskKey).length > 0)
      throw invalid('subtask_has_children', 'a task with subtasks cannot become a subtask');
  }

  private recordParentChange(
    task: Task,
    previous: string | null,
    actor: Actor,
    sessionId?: string | null,
  ): void {
    for (const [parentKey, type] of [
      [previous, 'task_subtask_removed'],
      [task.parentKey, 'task_subtask_added'],
    ] as const) {
      if (!parentKey) continue;
      for (const taskKey of [parentKey, task.key]) {
        this.timeline.append({
          projectKey: task.projectKey,
          taskKey,
          actor,
          sessionId: sessionId ?? null,
          type,
          data: { parentKey, subtaskKey: task.key },
        });
      }
    }
  }

  /** Closes the task and stops its sessions while preserving assignment, stage and files. */
  async cancel(projectKey: string, taskKey: string, req: CancelTaskRequest, actor: Actor): Promise<Task> {
    await this.requireLifecycleAccess(projectKey, actor);
    const next = this.ctx.unitOfWork(() => {
      const task = this.get(projectKey, taskKey);
      if (!isOpenTask(task)) throw conflict('task_closed', `task ${taskKey} is ${task.status}`);
      const at = isoNow(this.ctx);
      const cancelled = this.store.write(task, { status: 'cancelled', closedAt: at, updatedAt: at });
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
      this.publish(cancelled);
      return cancelled;
    });
    for (const listener of this.cancelListeners) await listener(next);
    return next;
  }

  /** Reopens in the same stage, with no assignee; starting work remains explicit. */
  async reopen(projectKey: string, taskKey: string, actor: Actor): Promise<Task> {
    await this.requireLifecycleAccess(projectKey, actor);
    return this.ctx.unitOfWork(() => {
      const task = this.get(projectKey, taskKey);
      if (task.status !== 'cancelled') {
        throw conflict('task_not_cancelled', `task ${taskKey} is not cancelled`);
      }
      const next = this.store.write(task, {
        status: 'active',
        closedAt: null,
        assignee: null,
        updatedAt: isoNow(this.ctx),
      });
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
    });
  }

  private async requireLifecycleAccess(projectKey: string, actor: Actor): Promise<ProjectConfig> {
    const config = await this.projects.config(projectKey);
    requireHuman(config, actor, 'admin');
    return config;
  }

  /**
   * Moves a task to a stage if the gates allow it. Unmet conditions throw `gate_blocked`;
   * human approvals create `decision` inbox items for the approvers and the task moves only
   * once they approve (an AI member can never resolve inbox items).
   */
  moveToStage(projectKey: string, taskKey: string, stageId: string, actor: Actor): Promise<MoveResult> {
    return this.moves.moveToStage(projectKey, taskKey, stageId, actor);
  }

  /** Handler for resolved `decision` items: completes (or drops) the requested stage move. */
  handleDecisionResolved(item: InboxItem): Promise<void> {
    return this.moves.handleDecisionResolved(item);
  }

  /** Adds and removes labels under the project's label rules (see TaskLabels). */
  changeLabels(
    projectKey: string,
    taskKey: string,
    change: { add?: string[]; remove?: string[] },
    actor: Actor,
    opts: { comment?: string; sessionId?: string | null; reason?: LabelChangeReason } = {},
  ): Promise<Task> {
    return this.labels.changeLabels(projectKey, taskKey, change, actor, opts);
  }

  /** Removes the labels that expire on an event (the task moving back, its PR changing). */
  clearLabels(projectKey: string, taskKey: string, trigger: LabelClearTrigger): Promise<void> {
    return this.labels.clearLabels(projectKey, taskKey, trigger);
  }

  addNote(
    projectKey: string,
    taskKey: string,
    text: string,
    actor: Actor,
    sessionId: string | null = null,
    imported: Pick<CreateTaskCommentRequest, 'importedAuthor' | 'importedAt'> = {},
  ): Promise<TimelineEvent> {
    return this.store.addNote(projectKey, taskKey, text, actor, sessionId, imported);
  }

  assign(
    projectKey: string,
    taskKey: string,
    assignee: string | null,
    actor: Actor,
    extra: Pick<TimelineEventData['task_assigned'], 'reason' | 'from'> = {},
  ): Task {
    return this.ctx.unitOfWork(() => {
      const task = this.get(projectKey, taskKey);
      if (task.assignee === assignee) return task;
      const next = this.store.write(task, { assignee, updatedAt: isoNow(this.ctx) });
      this.timeline.append({
        projectKey,
        taskKey,
        actor,
        type: 'task_assigned',
        data: { assignee, previous: task.assignee, ...extra },
      });
      this.publish(next);
      return next;
    });
  }

  addLink(
    projectKey: string,
    taskKey: string,
    link: TaskLink,
    actor: Actor,
    sessionId: string | null = null,
  ): Task {
    return this.ctx.unitOfWork(() => {
      const task = this.get(projectKey, taskKey);
      // Preserve authorship across reassignment; a linked PR defaults to its task's implementer.
      if (link.kind === 'pull_request' && !link.author) {
        const author = this.pullRequests.authorOf(projectKey, link) ?? task.assignee;
        if (author) link = { ...link, author };
      }
      const result = this.ctx.repos.tasks.upsertLink(task.id, link, isoNow(this.ctx));
      if (result === 'unchanged') return task;
      const next = this.get(projectKey, taskKey);
      if (result === 'inserted') {
        const data: TimelineEventData['task_link_added'] = { kind: link.kind, ref: link.ref };
        if (link.repo) data.repo = link.repo;
        this.timeline.append({ projectKey, taskKey, sessionId, actor, type: 'task_link_added', data });
      }
      this.publish(next);
      return next;
    });
  }

  /** Keeps the full snapshot already fetched by GitHub; unknown links remain nullable. */
  recordPullRequest(pr: PullRequestInfo): void {
    this.pullRequests.record(pr);
  }

  /** A watched pull request changed: refresh every task link to it. Returns the tasks linking it. */
  applyPullRequestUpdate(repo: string, number: number, patch: { state: string; title?: string }): Task[] {
    return this.pullRequests.applyUpdate(repo, number, patch);
  }

  /**
   * The open tasks of members who left the team go to the member named in `handovers`, or
   * lose their assignee.
   */
  handOverTasks(
    projectKey: string,
    handles: Iterable<string>,
    actor: Actor,
    handovers: Readonly<Record<string, string>> = {},
  ): void {
    this.ctx.unitOfWork(() => {
      for (const handle of handles) {
        const to = handovers[handle] ?? null;
        for (const task of this.ctx.repos.tasks.listByAssignee(projectKey, handle)) {
          if (!isOpenTask(task)) continue;
          this.assign(
            projectKey,
            task.key,
            to,
            actor,
            to ? { reason: 'handover', from: handle } : { reason: 'member_removed' },
          );
        }
      }
    });
  }

  publish(task: Task): void {
    this.store.publish(task);
  }
}
