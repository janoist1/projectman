import type {
  Actor,
  CreateTaskCommentRequest,
  TimelineEvent,
  CancelTaskRequest,
  CreateTaskRequest,
  InboxItem,
  ProjectConfig,
  Session,
  Task,
  TaskDetail,
  TaskLink,
  TimelineEventData,
  Visibility,
} from '@projectman/shared';
import {
  evaluateMove,
  isHandleOnLeave,
  isOpenTask,
  isTheme,
  memberOf,
  repoOf,
  subtaskParentRefusal,
} from '@projectman/shared';
import type {
  LabelChangeReason,
  LabelClearTrigger,
  RelationsChange,
  TaskKind,
  TaskRelation,
} from '@projectman/shared';
import type { PullRequestInfo } from '../../contracts';
import type { TaskPatch } from '../../db';
import { requireHuman } from '../access';
import { isoNow } from '../context';
import type { DomainContext } from '../context';
import { conflict, invalid, themeRefused } from '../errors';
import type { InboxService } from '../inbox';
import type { ProjectService } from '../projects';
import { PullRequestRecords } from '../pull-requests';
import { LIVE_SESSION_STATES } from '../sessions';
import type { TimelineService } from '../timeline';
import { actorHandle, newId, unique } from '../util';
import { labelsChange, planLabelsOrThrow, TaskLabels } from './labels';
import { approvalRequestedError, gateBlockedError, TaskMoves } from './moves';
import type { Handover, MoveOptions, MoveResult, SourceHeadReader } from './moves';
import { SUBTASK_PARENT_REFUSALS, TaskRelations } from './relations';
import { requireStage, runEffects, TaskStore } from './store';
import type { Effect, StartWaitingReader } from './store';
import { TaskThemes } from './themes';
import type { ThemeView } from './themes';

/** A repository the project's configuration does not have, with the names it does have. */
function unknownRepo(config: ProjectConfig, repo: string) {
  const names = config.project.repos.map((r) => r.name);
  return invalid(
    'unknown_repo',
    `unknown repository: ${repo} (${names.length > 0 ? `the project has: ${names.join(', ')}` : 'the project has none'})`,
  );
}

/**
 * A change of a task in one step. The REST PATCH sends the fields, the assignee and the whole
 * label set; the update_task team tool sends labels to add and remove and a note.
 */
export interface TaskUpdate {
  title?: string;
  description?: string;
  visibility?: Visibility;
  parentKey?: string | null;
  /**
   * The repository the task works in, a repository of the project's configuration; null clears it.
   * Refused while a session of the task is running: its worktree is in the old repository.
   */
  repo?: string | null;
  /** Owner/admin only; null clears the assignee. Starting work is a separate call. */
  assignee?: string | null;
  /** The whole label set: turned into additions and removals. */
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  /** A comment for the timeline; with a label change it is the labels' comment. */
  note?: string;
  stageId?: string;
  /** Relations to other cards (PM-192): removals first, then additions; all or nothing with the rest. */
  relations?: RelationsChange;
  /** The theme the card belongs to (PM-192); null removes it. Not for a theme or a subtask. */
  themeKey?: string | null;
  /** A person moves the card into the work stage despite open prerequisites (PM-204). */
  despitePrerequisites?: boolean;
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
  private readonly cardRelations: TaskRelations;
  private readonly themes: TaskThemes;
  private readonly pullRequests: PullRequestRecords;

  constructor(deps: {
    ctx: DomainContext;
    timeline: TimelineService;
    projects: ProjectService;
    inbox: InboxService;
    /** Why a task's AI work waits, shown on the task. */
    startWaiting: StartWaitingReader;
    /** The head of the developer's branch, read when a task is handed over for review (PM-183). */
    sourceHead: SourceHeadReader;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
    this.store = new TaskStore(deps);
    this.labels = new TaskLabels(this.store);
    this.moves = new TaskMoves({
      store: this.store,
      labels: this.labels,
      inbox: deps.inbox,
      sourceHead: deps.sourceHead,
    });
    this.themes = new TaskThemes(this.store);
    this.cardRelations = new TaskRelations(this.store, {
      liveSession: (task) => this.liveSession(task) !== undefined,
      recordParentChange: (task, previous, actor, sessionId) =>
        this.recordParentChange(task, previous, actor, sessionId),
      recordThemeChange: (task, previous, themeKey, actor, sessionId) =>
        this.themes.record(task, previous, themeKey, actor, sessionId),
      cancel: (task, actor, duplicate, sessionId, effects) =>
        this.closeAsCancelled(task, actor, duplicate, sessionId, effects),
    });
    this.pullRequests = new PullRequestRecords({
      ...deps,
      find: (projectKey, taskKey) => this.store.find(projectKey, taskKey),
      publish: (task) => this.store.publish(task),
    });
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

  /**
   * The cards that belong with a task, one level: its parent when it is a subtask (the parent
   * first), else its own subtasks. Siblings are not part of the family. Closed cards are included.
   */
  family(projectKey: string, taskKey: string): Task[] {
    const task = this.find(projectKey, taskKey);
    if (!task) return [];
    if (task.parentKey) {
      const parent = this.find(projectKey, task.parentKey);
      return parent ? [parent] : [];
    }
    return this.ctx.repos.tasks.children(projectKey, taskKey);
  }

  /** The task's relations to other cards, both directions, with their title, stage and status (PM-192). */
  relationsOf(projectKey: string, taskKey: string): TaskRelation[] {
    return this.cardRelations.of(this.get(projectKey, taskKey));
  }

  /** The cards of a theme (collecting cards with their subtasks) and how far it is (PM-192). */
  themeOf(projectKey: string, themeKey: string): ThemeView {
    const theme = this.get(projectKey, themeKey);
    if (!isTheme(theme)) throw conflict('task_not_theme', `${themeKey} is not a theme`);
    return this.themes.of(theme);
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
    const kind: TaskKind = req.kind ?? 'task';
    if (kind === 'theme' && (req.stageId !== undefined || req.repo))
      throw invalid('task_is_theme', 'a theme has no stage and no repository: leave stageId and repo out');
    const target = req.stageId ? requireStage(config, req.stageId) : first;
    const title = req.title.trim();
    if (!title) throw invalid('invalid_request', 'title must not be empty');
    const repo = req.repo ?? null;
    if (repo && !repoOf(config, repo)) throw unknownRepo(config, repo);
    if (req.parentKey) this.validateParent(projectKey, null, req.parentKey, kind);
    if (req.themeKey)
      this.themes.require(req.themeKey, {
        projectKey,
        kind,
        // A card created as a part of another gets that card's theme, so it has none of its own.
        parentKey: req.parentKey ?? (req.relations?.some((r) => r.kind === 'part_of') ? '-' : null),
      });
    const at = req.importedAt ?? isoNow(this.ctx);
    const task: Task = {
      ...(kind === 'theme' ? { kind } : {}),
      ...(req.themeKey ? { themeKey: req.themeKey } : {}),
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
    const effects: Effect[] = [];
    const created = this.ctx.unitOfWork(() => {
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
      if (task.themeKey) {
        this.themes.record(task, null, task.themeKey, actor, opts.sessionId ?? null);
        this.themes.publishAround(task, [task.themeKey]);
      }
      // Relations are planned against the project with the new card in it; one refused refuses the creation.
      if (req.relations?.length) {
        const plan = this.cardRelations.plan(config, task, { add: req.relations }, actor);
        const related = this.cardRelations.execute(plan, task, actor, opts.sessionId ?? null, effects);
        this.publish(related);
        return related;
      }
      // A subtask shows its parent's theme, which only a read tells.
      const stored = task.parentKey ? this.store.get(projectKey, task.key) : task;
      this.publish(stored);
      return stored;
    });
    await runEffects(effects);
    return created;
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
    // A move into a review or test stage hands the branch over (PM-183): read before the write.
    const handover =
      change.stageId !== undefined
        ? await this.moves.prepareHandover(config, this.get(projectKey, taskKey), change.stageId)
        : null;
    const result = this.ctx.unitOfWork(() =>
      this.applyUpdate(
        config,
        this.get(projectKey, taskKey),
        change,
        actor,
        opts.sessionId ?? null,
        effects,
        handover,
      ),
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
    handover: Handover | null,
  ): { task: Task; pendingApproval?: InboxItem[] } {
    // A theme does not move, have an assignee or a repository (PM-192).
    if (isTheme(task)) {
      if (change.stageId !== undefined && change.stageId !== task.stageId)
        throw themeRefused(task.key, 'move between stages');
      if (change.assignee !== undefined && change.assignee !== null)
        throw themeRefused(task.key, 'have an assignee');
      if (change.repo !== undefined && change.repo !== null)
        throw themeRefused(task.key, 'have a repository');
    }
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
    if (change.relations && change.parentKey !== undefined)
      throw invalid('invalid_request', 'give the parent in parentKey or in relations, not in both');
    const relationPlan = change.relations
      ? this.cardRelations.plan(config, task, change.relations, actor)
      : null;
    if (relationPlan?.closes && change.stageId !== undefined && change.stageId !== task.stageId)
      throw invalid(
        'invalid_request',
        'a card marked as a duplicate is closed: it cannot move in the same call',
      );
    if (change.parentKey) this.validateParent(task.projectKey, task.key, change.parentKey, task.kind);
    if (change.parentKey !== undefined && change.parentKey !== (task.parentKey ?? null)) {
      patch.parentKey = change.parentKey;
      fields.push('parentKey');
    }
    // The theme the card stores (a subtask stores none: it reads its parent's), and what it will store.
    const ownTheme = task.parentKey ? null : (task.themeKey ?? null);
    let themeAfter = ownTheme;
    let parentAfter = change.parentKey !== undefined ? change.parentKey : (task.parentKey ?? null);
    for (const step of relationPlan?.steps ?? [])
      if (step.type === 'parent' && step.child === task.key) parentAfter = step.parent;
    if (change.themeKey !== undefined && change.themeKey !== ownTheme) {
      if (change.themeKey !== null)
        this.themes.require(change.themeKey, {
          projectKey: task.projectKey,
          kind: task.kind,
          parentKey: parentAfter,
        });
      themeAfter = change.themeKey;
    }
    // A card that becomes a subtask loses the theme it had: from then on it reads its parent's. (A part_of
    // relation does the same where it is written, see `TaskRelations.execute`.)
    if (change.parentKey) themeAfter = null;
    if (themeAfter !== ownTheme) patch.themeKey = themeAfter;
    if (change.repo !== undefined && change.repo !== task.repo) {
      if (change.repo !== null && !repoOf(config, change.repo)) throw unknownRepo(config, change.repo);
      // The task's worktree and its sessions are in the old repository: they would stay there.
      const live = this.liveSession(task);
      if (live)
        throw conflict(
          'task_session_live',
          `the repository of task ${task.key} cannot change while a session of the task is running`,
          { sessionId: live.id },
        );
      patch.repo = change.repo;
      fields.push('repo');
    }
    if (change.assignee !== undefined) {
      if (change.assignee !== null && !memberOf(config, change.assignee))
        throw invalid('unknown_member', `unknown member: ${change.assignee}`);
      const live = this.liveSession(task);
      if (live)
        throw conflict('task_session_live', `task ${task.key} has a live session`, { sessionId: live.id });
      if (change.assignee !== task.assignee) {
        // A member on leave cannot take over work (decision 23); keeping it as it is stays allowed.
        if (isHandleOnLeave(config, change.assignee))
          throw conflict('member_on_leave', `${change.assignee} is on leave`, { member: change.assignee });
        patch.assignee = change.assignee;
      }
    }
    const note = change.note?.trim() || undefined;
    const wanted = change.labels && unique(change.labels.map((label) => label.trim()).filter(Boolean));
    const labelChange = wanted
      ? {
          add: wanted.filter((label) => !task.labels.includes(label)),
          remove: task.labels.filter((label) => !wanted.includes(label)),
        }
      : { add: change.addLabels, remove: change.removeLabels };
    // Reassigning in the same change never lifts the self-review rule: both the current and
    // the new assignee count as authors of the work these labels judge.
    if (patch.assignee !== undefined) planLabelsOrThrow(config, task, labelChange, actor, note);
    const labels = planLabelsOrThrow(config, { ...task, ...patch }, labelChange, actor, note);
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
    if (fields.length > 0 || patch.assignee !== undefined || patch.themeKey !== undefined || labelsChanged) {
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
          data: {
            fields,
            ...(patch.repo !== undefined ? { repo: patch.repo, previousRepo: task.repo } : {}),
          },
        });
      if (patch.description !== undefined)
        effects.push(() => this.ctx.events.emit('task_description_changed', { task: next, actor }));
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
      // A card that became a subtask, or left its collecting card, shows another theme now, which only a
      // read tells.
      if (patch.parentKey !== undefined || patch.themeKey !== undefined)
        next = this.get(task.projectKey, task.key);
      // What the card shows changed (its own theme, or the one of the parent it joined or left): the
      // timelines of the card and of both themes say so.
      const shownBefore = task.themeKey ?? null;
      const shownAfter = next.themeKey ?? null;
      if (shownBefore !== shownAfter) this.themes.record(next, shownBefore, shownAfter, actor, sessionId);
      this.publish(next);
      // A subtask of the card shows the card's theme, so a change of theme is news to them and to both themes.
      if (shownBefore !== shownAfter) this.themes.publishAround(next, [shownBefore, shownAfter]);
    }
    if (relationPlan && relationPlan.steps.length > 0)
      next = this.cardRelations.execute(relationPlan, next, actor, sessionId, effects);
    if (note && !labelsChanged) this.store.recordNote(config, next, note, actor, sessionId, effects);
    if (!moving) return { task: next };
    const moved = this.moves.move(config, next, change.stageId!, actor, effects, {
      handover,
      despitePrerequisites: change.despitePrerequisites,
    });
    return moved.moved ? { task: moved.task } : { task: moved.task, pendingApproval: moved.pendingApproval };
  }

  /** A live session of the task, if any: one that has not ended, whoever runs it. */
  private liveSession(task: Task): Session | undefined {
    return this.ctx.repos.sessions
      .list(task.projectKey, { taskKey: task.key })
      .find((s) => LIVE_SESSION_STATES.includes(s.state));
  }

  private validateParent(
    projectKey: string,
    taskKey: string | null,
    parentKey: string,
    kind?: TaskKind,
  ): void {
    const refusal = subtaskParentRefusal(parentKey, this.ctx.repos.tasks.get(parentKey), {
      key: taskKey,
      projectKey,
      hasSubtasks: taskKey !== null && this.ctx.repos.tasks.children(projectKey, taskKey).length > 0,
      kind,
    });
    if (refusal) throw invalid(refusal, SUBTASK_PARENT_REFUSALS[refusal]);
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
    const effects: Effect[] = [];
    const next = this.ctx.unitOfWork(() => {
      const task = this.get(projectKey, taskKey);
      if (isTheme(task)) throw themeRefused(taskKey, 'be cancelled: close it instead');
      if (!isOpenTask(task)) throw conflict('task_closed', `task ${taskKey} is ${task.status}`);
      return this.closeAsCancelled(task, actor, { reason: req.reason }, null, effects);
    });
    await runEffects(effects);
    return next;
  }

  /**
   * Cancels an open task inside a unit of work: the timeline says why (a duplicate names its
   * original), and the cancellation, which stops the task's sessions, is announced once it committed.
   */
  private closeAsCancelled(
    task: Task,
    actor: Actor,
    why: { reason?: string | undefined; duplicateOf?: string },
    sessionId: string | null,
    effects: Effect[],
  ): Task {
    const at = isoNow(this.ctx);
    const cancelled = this.store.write(task, { status: 'cancelled', closedAt: at, updatedAt: at });
    this.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      sessionId,
      actor,
      type: 'task_updated',
      data: {
        fields: ['status', 'closedAt'],
        action: 'cancelled',
        previousStatus: task.status,
        ...(why.reason !== undefined ? { reason: why.reason } : {}),
        ...(why.duplicateOf !== undefined ? { duplicateOf: why.duplicateOf } : {}),
      },
    });
    this.publish(cancelled);
    effects.push(() => this.ctx.events.emit('task_cancelled', cancelled));
    return cancelled;
  }

  /**
   * Closes a theme (PM-192): it is closed, like a cancelled card, and the cards that belong to it are not
   * touched. A person of developer access may; only a theme closes this way (a card is cancelled).
   */
  async closeTheme(projectKey: string, taskKey: string, actor: Actor): Promise<Task> {
    const config = await this.projects.config(projectKey);
    requireHuman(config, actor, 'developer');
    return this.ctx.unitOfWork(() => {
      const task = this.get(projectKey, taskKey);
      if (!isTheme(task)) throw conflict('task_not_theme', `${taskKey} is not a theme: cancel it instead`);
      if (!isOpenTask(task)) throw conflict('task_closed', `theme ${taskKey} is closed already`);
      const at = isoNow(this.ctx);
      const closed = this.store.write(task, { status: 'cancelled', closedAt: at, updatedAt: at });
      this.timeline.append({
        projectKey,
        taskKey,
        actor,
        type: 'task_updated',
        data: { fields: ['status', 'closedAt'], action: 'closed', previousStatus: task.status },
      });
      this.publish(closed);
      return closed;
    });
  }

  /**
   * Reopens in the same stage, with no assignee; starting work remains explicit. A theme is reopened by
   * a person of developer access, any other card by an admin.
   */
  async reopen(projectKey: string, taskKey: string, actor: Actor): Promise<Task> {
    const config = await this.projects.config(projectKey);
    requireHuman(config, actor, isTheme(this.get(projectKey, taskKey)) ? 'developer' : 'admin');
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
  moveToStage(
    projectKey: string,
    taskKey: string,
    stageId: string,
    actor: Actor,
    opts?: Pick<MoveOptions, 'branchMoved'>,
  ): Promise<MoveResult> {
    return this.moves.moveToStage(projectKey, taskKey, stageId, actor, opts);
  }

  /** The developer asked for a new review round (PM-138): the task's pinned commit follows the branch. */
  repinReview(projectKey: string, taskKey: string, by: string): Promise<void> {
    return this.moves.repin(projectKey, taskKey, by);
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
      if (isTheme(task)) throw themeRefused(taskKey, 'have an assignee');
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

  /**
   * A published task branch and its pull request (PM-142). The pull request's author is `author`,
   * the member whose authenticated session published it; polling by the bot's login never changes
   * it, and it stays when the task is reassigned, so the no-self-review rule keeps holding.
   */
  recordPublication(
    projectKey: string,
    taskKey: string,
    publication: { repo: string; branch: string; pullRequest: PullRequestInfo },
    author: string,
    actor: Actor,
    sessionId: string | null,
  ): Task {
    return this.ctx.unitOfWork(() => {
      const task = this.get(projectKey, taskKey);
      const at = isoNow(this.ctx);
      const { repo, branch, pullRequest } = publication;
      const links: Array<{ link: TaskLink; result: 'inserted' | 'updated' | 'unchanged' }> = [
        {
          link: { kind: 'branch', ref: branch, repo },
          result: this.ctx.repos.tasks.upsertLink(task.id, { kind: 'branch', ref: branch, repo }, at),
        },
      ];
      const prLink: TaskLink = {
        kind: 'pull_request',
        ref: String(pullRequest.number),
        repo: pullRequest.repo,
        title: pullRequest.title,
        state: pullRequest.state,
      };
      links.push({
        link: prLink,
        result: this.ctx.repos.tasks.recordPublication(task.id, prLink, author, at),
      });
      if (links.every((entry) => entry.result === 'unchanged')) return task;
      for (const { link, result } of links) {
        if (result !== 'inserted') continue;
        const data: TimelineEventData['task_link_added'] = { kind: link.kind, ref: link.ref };
        if (link.repo) data.repo = link.repo;
        this.timeline.append({ projectKey, taskKey, sessionId, actor, type: 'task_link_added', data });
      }
      const next = this.get(projectKey, taskKey);
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
