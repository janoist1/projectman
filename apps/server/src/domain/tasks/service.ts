import type {
  Actor,
  BoardMoveRequest,
  BoardMoveResult,
  Stage,
  CreateTaskCommentRequest,
  TimelineEvent,
  CancelTaskRequest,
  CreateTaskRequest,
  DeveloperLevelRequest,
  HandoffReason,
  HandoffStart,
  InboxItem,
  ProjectConfig,
  Session,
  Task,
  TaskPriority,
  TaskDetail,
  TaskFixLimit,
  TaskLink,
  TimelineEventData,
  Visibility,
} from '@projectman/shared';
import {
  actorMoveRefusal,
  boardColumnOf,
  dropStageOfColumn,
  evaluateMove,
  isHandleOnLeave,
  isOpenTask,
  isTheme,
  memberOf,
  priorityRefusal,
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
import { conflict, forbidden, invalid, projectManagerMoveRefused, themeRefused } from '../errors';
import type { AddedRelation } from '../events';
import type { InboxService } from '../inbox';
import type { ProjectService } from '../projects';
import { PullRequestRecords } from '../pull-requests';
import { LIVE_SESSION_STATES } from '../sessions';
import type { TimelineService } from '../timeline';
import { actorHandle, newId, unique } from '../util';
import { BoardOrder } from './board-order';
import { BoardGroupMove } from './group-move';
import { planDeveloperLevel } from './developer-level';
import type { DeveloperLevelChange } from './developer-level';
import { labelsChange, planLabelsOrThrow, TaskLabels } from './labels';
import { approvalRequestedError, gateBlockedError, TaskMoves } from './moves';
import type { Handover, MoveOptions, MoveResult, SourceHeadReader } from './moves';
import { SUBTASK_PARENT_REFUSALS, TaskRelations } from './relations';
import { requireStage, runEffects, TaskStore } from './store';
import type { Effect, StartWaitingReader } from './store';
import { TaskThemes } from './themes';
import type { ThemeView } from './themes';

/** A card changed its assignee (PM-342): `task` is as written, `previous` the old assignee. */
export interface HandoffTrigger {
  task: Task;
  previous: string | null;
  actor: Actor;
  reason: HandoffReason;
}

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
  priority?: TaskPriority | null;
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
  /** The recommended developer (PM-347); a change goes to the timeline and is told to the listeners. */
  developerLevel?: DeveloperLevelRequest;
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
  private readonly order: BoardOrder;
  private readonly group: BoardGroupMove;
  private readonly cardRelations: TaskRelations;
  private readonly themes: TaskThemes;
  private readonly pullRequests: PullRequestRecords;
  private readonly handoff: ((input: HandoffTrigger) => HandoffStart | null) | undefined;

  constructor(deps: {
    ctx: DomainContext;
    timeline: TimelineService;
    projects: ProjectService;
    inbox: InboxService;
    /** Why a task's AI work waits, shown on the task. */
    startWaiting: StartWaitingReader;
    /** The head of the developer's branch, read when a task is handed over for review (PM-183). */
    sourceHead: SourceHeadReader;
    /** The fix round limit hold on a card (PM-262), shown on it. */
    fixLimit?: (task: Task) => TaskFixLimit | undefined;
    /**
     * Opens the handoff of the old assignee's work when the card changes assignee (PM-342). Called in the
     * unit of work that changed the assignee, after its `task_assigned` event; null: nothing to hand over.
     */
    handoff?: (input: HandoffTrigger) => HandoffStart | null;
  }) {
    this.ctx = deps.ctx;
    this.timeline = deps.timeline;
    this.projects = deps.projects;
    this.handoff = deps.handoff;
    this.store = new TaskStore(deps);
    this.labels = new TaskLabels(this.store);
    this.order = new BoardOrder(this.store);
    this.moves = new TaskMoves({
      store: this.store,
      labels: this.labels,
      inbox: deps.inbox,
      sourceHead: deps.sourceHead,
      order: this.order,
    });
    this.group = new BoardGroupMove({ store: this.store, moves: this.moves, order: this.order });
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
    if (kind === 'theme' && req.developerLevel)
      throw invalid('task_is_theme', 'a theme has no recommended developer: leave developerLevel out');
    const level = req.developerLevel ? planDeveloperLevel(config, null, req.developerLevel, actor, at) : null;
    const task: Task = {
      ...(level ? { developerLevel: level.next } : {}),
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
      stageEnteredAt: at,
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
      // A new card goes to the top of its column (PM-118); a theme stands on no board.
      let reranked: string[] = [];
      if (kind !== 'theme') {
        const entered = this.order.enter(config, task, boardColumnOf(target) ?? target.id);
        if (entered.rank !== undefined) task.boardRank = entered.rank;
        reranked = entered.reranked;
      }
      this.ctx.repos.tasks.insert(task);
      this.order.publish(projectKey, reranked);
      this.timeline.append({
        projectKey,
        taskKey: task.key,
        sessionId: opts.sessionId ?? null,
        actor,
        type: 'task_created',
        data: { title, ...(req.importedAt !== undefined ? { imported: true } : {}) },
        createdAt: at,
      });
      if (level) this.recordDeveloperLevel(task, level, actor, opts.sessionId ?? null, effects);
      const added: AddedRelation[] = [];
      if (task.parentKey) {
        this.recordParentChange(task, null, actor, opts.sessionId);
        added.push(
          { taskKey: task.key, kind: 'part_of', ref: task.parentKey },
          { taskKey: task.parentKey, kind: 'has_part', ref: task.key },
        );
      }
      if (task.themeKey) {
        this.themes.record(task, null, task.themeKey, actor, opts.sessionId ?? null);
        this.themes.publishAround(task, [task.themeKey]);
      }
      // Relations are planned against the project with the new card in it; one refused refuses the creation.
      if (req.relations?.length) {
        const plan = this.cardRelations.plan(config, task, { add: req.relations }, actor);
        const related = this.cardRelations.execute(plan, task, actor, opts.sessionId ?? null, effects, added);
        this.announceRelations(projectKey, actor, added, effects);
        this.publish(related);
        return related;
      }
      this.announceRelations(projectKey, actor, added, effects);
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
  ): Promise<Task & { handoffStart?: HandoffStart }> {
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
    return result.handoffStart ? { ...result.task, handoffStart: result.handoffStart } : result.task;
  }

  /**
   * A card dropped on the board (PM-118): in its own column it only changes place; on another column
   * it enters that column's first stage at the placed position, through the same gates and approvals as
   * any stage change. The client names the card it saw in a stage and the card it dropped next to; the
   * server refuses (409 `board_stale`) when either is not as seen, and computes the ranks itself. A move
   * that waits for approval keeps the card where it is and remembers the placement.
   */
  async moveOnBoard(
    projectKey: string,
    taskKey: string,
    req: BoardMoveRequest,
    actor: Actor,
  ): Promise<BoardMoveResult> {
    const config = await this.projects.config(projectKey);
    const target = dropStageOfColumn(config.pipeline.stages, req.columnId);
    if (!target) throw invalid('unknown_column', `the board has no column ${req.columnId}`);
    const seen = this.get(projectKey, taskKey);
    if (isTheme(seen)) throw themeRefused(taskKey, 'be moved on the board');
    const entering = !this.inColumn(config, seen, req.columnId);
    // A collecting card entering another column takes its subtasks of the column along (PM-121).
    if (entering && req.withSubtasks && this.group.along(config, seen).length > 0)
      return this.moveGroupOnBoard(config, seen, target, req, actor);
    // A move into a review or test stage hands the branch over (PM-183): read before the write.
    const handover = entering ? await this.moves.prepareHandover(config, seen, target.id) : null;
    const effects: Effect[] = [];
    const result = this.ctx.unitOfWork((): { board: BoardMoveResult; pending?: InboxItem[] } => {
      const task = this.requireDroppable(projectKey, taskKey, req);
      const chronological = this.order.chronological(config, req.columnId);
      if (!entering) {
        if (chronological || task.status === 'done')
          throw conflict(
            'board_column_chronological',
            'a column of finished work is ordered by closing time',
          );
        return { board: this.order.reorder(config, task, req.columnId, req.placement) };
      }
      if (!chronological) this.order.requireCurrent(config, task, req.columnId, req.placement);
      const moved = this.moves.move(config, task, target.id, actor, effects, {
        handover,
        despitePrerequisites: req.despitePrerequisites,
        placement: req.placement,
      });
      if (!moved.moved)
        return {
          board: { task: moved.task, outcome: 'unchanged', reranked: [] },
          pending: moved.pendingApproval,
        };
      return { board: { task: moved.task, outcome: 'moved', reranked: moved.reranked ?? [] } };
    });
    await runEffects(effects);
    if (result.pending?.length) throw approvalRequestedError(result.pending);
    return result.board;
  }

  /**
   * A collecting card and its subtasks of its column dropped on another column (PM-121): one request, one
   * unit of work, each card through its own gates (see `BoardGroupMove`). The request's own conditions
   * (the card cancelled, not in the stage seen, the anchor gone) refuse the whole drop before any card moves;
   * after that no card's refusal stops the others. Work starts after the commit, from each card's own event.
   */
  private async moveGroupOnBoard(
    config: ProjectConfig,
    seen: Task,
    target: Stage,
    req: BoardMoveRequest,
    actor: Actor,
  ): Promise<BoardMoveResult> {
    const prepared = await this.group.prepare(config, [seen, ...this.group.along(config, seen)], target);
    const effects: Effect[] = [];
    const board = this.ctx.unitOfWork((): BoardMoveResult => {
      const task = this.requireDroppable(seen.projectKey, seen.key, req);
      if (!this.order.chronological(config, req.columnId))
        this.order.requireCurrent(config, task, req.columnId, req.placement);
      return this.group.run(config, task, target, req, actor, prepared, effects);
    });
    await runEffects(effects);
    return board;
  }

  /** The card read in the running unit of work, refused when it is cancelled or not in the stage the person saw it in. */
  private requireDroppable(projectKey: string, taskKey: string, req: BoardMoveRequest): Task {
    const task = this.get(projectKey, taskKey);
    if (task.status === 'cancelled') throw conflict('task_closed', `task ${taskKey} is cancelled`);
    if (task.stageId !== req.fromStageId)
      throw conflict('board_stale', `${taskKey} is not in the stage ${req.fromStageId} any more`, {
        reason: 'source',
        stageId: task.stageId,
      });
    return task;
  }

  private inColumn(config: ProjectConfig, task: Task, columnId: string): boolean {
    return boardColumnOf(config.pipeline.stages.find((stage) => stage.id === task.stageId)) === columnId;
  }

  private applyUpdate(
    config: ProjectConfig,
    task: Task,
    change: TaskUpdate,
    actor: Actor,
    sessionId: string | null,
    effects: Effect[],
    handover: Handover | null,
  ): { task: Task; pendingApproval?: InboxItem[]; handoffStart?: HandoffStart | undefined } {
    // A theme does not move, have an assignee or a repository (PM-192).
    if (isTheme(task)) {
      if (change.stageId !== undefined && change.stageId !== task.stageId)
        throw themeRefused(task.key, 'move between stages');
      if (change.assignee !== undefined && change.assignee !== null)
        throw themeRefused(task.key, 'have an assignee');
      if (change.repo !== undefined && change.repo !== null)
        throw themeRefused(task.key, 'have a repository');
      if (change.priority !== undefined && change.priority !== null)
        throw themeRefused(task.key, 'have a priority');
    }
    // Validate the whole change against the task as it will be.
    const patch: TaskPatch = {};
    const fields: string[] = [];
    const level = change.developerLevel
      ? planDeveloperLevel(config, task, change.developerLevel, actor, isoNow(this.ctx))
      : null;
    if (level) patch.developerLevel = level.next;
    if (change.priority !== undefined) {
      const refusal = priorityRefusal(actor, config);
      if (refusal)
        throw forbidden(refusal, 'the priority of a card is set by people and the project manager only');
      if (change.priority !== task.priority) {
        patch.priority = change.priority;
        fields.push('priority');
      }
    }
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
      // A live session of the old assignee is no obstacle (PM-342): the handoff asks it for a note.
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
      // Checked before anything is written, so a refused move leaves the rest of the change unrecorded (PM-433).
      const moveRefusal = actorMoveRefusal(config, actor, task.stageId, change.stageId!);
      if (moveRefusal) throw projectManagerMoveRefused();
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
    const added: AddedRelation[] = [];
    let next = task;
    let handoffStart: HandoffStart | undefined;
    const labelsChanged = labelsChange(labels);
    if (
      fields.length > 0 ||
      patch.assignee !== undefined ||
      patch.themeKey !== undefined ||
      patch.developerLevel !== undefined ||
      labelsChanged
    ) {
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
            ...(patch.priority !== undefined
              ? { priority: patch.priority, previousPriority: task.priority }
              : {}),
          },
        });
      if (patch.description !== undefined)
        effects.push(() => this.ctx.events.emit('task_description_changed', { task: next, actor }));
      if (level) this.recordDeveloperLevel(next, level, actor, sessionId, effects);
      if (labelsChanged)
        this.labels.record(config, next, labels, actor, { comment: note, sessionId }, effects);
      if (patch.assignee !== undefined) {
        this.timeline.append({
          projectKey: task.projectKey,
          taskKey: task.key,
          actor,
          type: 'task_assigned',
          data: { assignee: next.assignee, previous: task.assignee },
        });
        handoffStart =
          this.handoff?.({ task: next, previous: task.assignee, actor, reason: 'manual' }) ?? undefined;
        // Whoever listens to a change of assignee (a held fix round limit ends with it) hears this one too.
        const assigned = next;
        effects.push(() =>
          this.ctx.events.emit('task_assigned', { task: assigned, previous: task.assignee, actor }),
        );
      }
      if (patch.parentKey !== undefined) {
        this.recordParentChange(next, task.parentKey ?? null, actor, sessionId);
        if (patch.parentKey)
          added.push(
            { taskKey: task.key, kind: 'part_of', ref: patch.parentKey },
            { taskKey: patch.parentKey, kind: 'has_part', ref: task.key },
          );
      }
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
      next = this.cardRelations.execute(relationPlan, next, actor, sessionId, effects, added);
    this.announceRelations(task.projectKey, actor, added, effects);
    if (note && !labelsChanged) this.store.recordNote(config, next, note, actor, sessionId, effects);
    if (!moving) return { task: next, handoffStart };
    const moved = this.moves.move(config, next, change.stageId!, actor, effects, {
      handover,
      despitePrerequisites: change.despitePrerequisites,
    });
    return moved.moved
      ? { task: moved.task, handoffStart }
      : { task: moved.task, pendingApproval: moved.pendingApproval, handoffStart };
  }

  /** Tells the listeners, once the change committed, which relations it put on cards (PM-421). */
  private announceRelations(
    projectKey: string,
    actor: Actor,
    added: AddedRelation[],
    effects: Effect[],
  ): void {
    if (added.length > 0)
      effects.push(() => this.ctx.events.emit('task_relations_added', { projectKey, actor, added }));
  }

  /** Puts a change of the recommended developer on the timeline and tells the listeners once it committed. */
  private recordDeveloperLevel(
    task: Task,
    level: DeveloperLevelChange,
    actor: Actor,
    sessionId: string | null,
    effects: Effect[],
  ): void {
    this.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      sessionId,
      actor,
      type: 'task_level_changed',
      data: level.event,
    });
    effects.push(() => this.ctx.events.emit('task_level_changed', { task, actor }));
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
    effects.push(() => this.ctx.events.emit('task_cancelled', { ...cancelled, cancelledBy: actor }));
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
    opts?: Pick<MoveOptions, 'branchMoved' | 'testsFailed'>,
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
    {
      handoff,
      ...extra
    }: Pick<TimelineEventData['task_assigned'], 'reason' | 'from'> & {
      /** Why the card changes hands: set off the handoff of the old assignee's work (PM-342). */
      handoff?: HandoffReason;
    } = {},
  ): Task {
    let previous: string | null = null;
    let changed = false;
    const assigned = this.ctx.unitOfWork(() => {
      const task = this.get(projectKey, taskKey);
      if (task.assignee === assignee) return task;
      if (isTheme(task)) throw themeRefused(taskKey, 'have an assignee');
      previous = task.assignee;
      changed = true;
      const next = this.store.write(task, { assignee, updatedAt: isoNow(this.ctx) });
      this.timeline.append({
        projectKey,
        taskKey,
        actor,
        type: 'task_assigned',
        data: { assignee, previous: task.assignee, ...extra },
      });
      if (handoff) this.handoff?.({ task: next, previous: task.assignee, actor, reason: handoff });
      this.publish(next);
      return next;
    });
    // Only the listeners that run before the first asynchronous one are done when this returns.
    if (changed) void this.ctx.events.emit('task_assigned', { task: assigned, previous, actor });
    return assigned;
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
            to
              ? { reason: 'handover', from: handle, handoff: 'member_removed' }
              : { reason: 'member_removed', handoff: 'member_removed' },
          );
        }
      }
    });
  }

  publish(task: Task): void {
    this.store.publish(task);
  }
}
