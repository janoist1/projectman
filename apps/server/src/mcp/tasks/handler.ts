import {
  effectiveRepo,
  isOpenTask,
  isTheme,
  needsRepoChoice,
  TaskStatus as TaskStatusSchema,
} from '@projectman/shared';
import type {
  OperatorAction,
  ProjectConfig,
  Task,
  TaskKind,
  TaskPriority,
  Visibility,
  AddRelationRef,
  DeveloperLevelRequest,
  RelationsChange,
} from '@projectman/shared';
import { taskWaitShort } from '../../agent-text';
import { TeamToolError } from '../../contracts';
import type {
  AttachmentOperations,
  ListTasksInput,
  TaskSummary,
  TaskToolDetail,
  ToolContext,
} from '../../contracts';
import type { DomainContext } from '../../core/base';
import { QUESTION_LIMIT } from '../../core/inbox';
import type { CardQuestions } from '../../core/inbox';
import { DomainError } from '../../kernel';
import { visibleTaskDetail, visibleTimelineEvent } from '../../core/projects';
import type { Viewer } from '../../core/projects';
import type { ProjectFocusService } from '../../core/tasks';
import type { SessionCloser } from '../../runtime/sessions';
import type { SessionOrchestrator } from '../../runtime/sessions';
import type { TaskService, TaskWaits } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import { aiActor, humanActor, unique } from '../../kernel';

import type { ToolCaller, GuestView } from '../caller';
import type { TaskToolsHandler } from '../../contracts';
/** Attachments get_task shows; the rest are paged with list_attachments. */
const ATTACHMENTS_IN_TASK = 20;
/** Merge checks get_task shows (PM-876); the rest are read with list_merge_checks. */
const MERGE_CHECKS_IN_TASK = 3;
export class TaskTools implements TaskToolsHandler {
  private readonly calls: ToolCaller;
  private readonly ctx: DomainContext;
  private readonly tasks: Pick<
    TaskService,
    'list' | 'find' | 'get' | 'detail' | 'relationsOf' | 'themeOf' | 'update' | 'create'
  >;
  private readonly timeline: Pick<TimelineService, 'get'>;
  private readonly attachments: Pick<AttachmentOperations, 'list'>;
  private readonly sessions: Pick<SessionOrchestrator, 'cardWorkers' | 'cardWorkersFor'>;
  private readonly cardQuestions: Pick<CardQuestions, 'list'>;
  private readonly projectFocus: Pick<ProjectFocusService, 'places'>;
  private readonly taskWaits: Pick<TaskWaits, 'of' | 'ofCard'>;
  private readonly closer: Pick<SessionCloser, 'workReturned'>;
  constructor(deps: {
    calls: ToolCaller;
    ctx: DomainContext;
    tasks: Pick<
      TaskService,
      'list' | 'find' | 'get' | 'detail' | 'relationsOf' | 'themeOf' | 'update' | 'create'
    >;
    timeline: Pick<TimelineService, 'get'>;
    attachments: Pick<AttachmentOperations, 'list'>;
    sessions: Pick<SessionOrchestrator, 'cardWorkers' | 'cardWorkersFor'>;
    cardQuestions: Pick<CardQuestions, 'list'>;
    projectFocus: Pick<ProjectFocusService, 'places'>;
    taskWaits: Pick<TaskWaits, 'of' | 'ofCard'>;
    closer: Pick<SessionCloser, 'workReturned'>;
  }) {
    this.calls = deps.calls;
    this.ctx = deps.ctx;
    this.tasks = deps.tasks;
    this.timeline = deps.timeline;
    this.attachments = deps.attachments;
    this.sessions = deps.sessions;
    this.cardQuestions = deps.cardQuestions;
    this.projectFocus = deps.projectFocus;
    this.taskWaits = deps.taskWaits;
    this.closer = deps.closer;
  }
  async listTasks(ctx: ToolContext, args: ListTasksInput): Promise<TaskSummary[]> {
    return this.calls.guard(async () => {
      const { config, guest } = await this.calls.callerWithRequest(ctx, 'list_tasks');
      const status = args.status ?? 'open';
      const limit = args.limit ?? 50;
      if (status !== 'open' && !TaskStatusSchema.safeParse(status).success) {
        throw new TeamToolError('invalid', 'Invalid task status.');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new TeamToolError('invalid', 'limit must be an integer between 1 and 200.');
      }
      const assignee = args.assignee === 'me' ? ctx.member : args.assignee;
      const places = this.projectFocus.places(ctx.projectKey);
      const cards = this.tasks
        .list(ctx.projectKey)
        .filter(
          (task) =>
            (status === 'open' ? isOpenTask(task) : task.status === status) &&
            // A theme is in no stage (it carries the first one's id because the field is required).
            (args.stage === undefined || (!isTheme(task) && task.stageId === args.stage)) &&
            (assignee === undefined || task.assignee === assignee),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key))
        .slice(0, limit);
      const waits = this.taskWaits.of(config, cards);
      return cards.map(({ key, title, stageId, status, assignee, labels, updatedAt, kind, priority }) => {
        const wait = waits.get(key);
        return {
          key,
          title,
          stageId,
          status,
          assignee,
          labels,
          updatedAt,
          ...(kind === 'theme' ? { kind } : {}),
          ...(priority !== null ? { priority } : {}),
          ...(places.has(key) ? { focus: places.get(key) } : {}),
          ...(wait ? { waitsFor: taskWaitShort(wait) } : {}),
        };
      });
    });
  }

  async getTask(ctx: ToolContext, args: { taskKey: string; eventId?: string }): Promise<TaskToolDetail> {
    return this.calls.guard(async () => {
      const { config, guest } = await this.calls.callerWithRequest(ctx, 'get_task');
      const taskKey = this.calls.validTaskKey(ctx, args.taskKey);
      const whole = await this.taskToolDetail(ctx, config, taskKey, args.eventId, guest);
      return guest ? this.taskDetailForGuest(whole, guest.viewer) : whole;
    });
  }

  async updateTask(
    ctx: ToolContext,
    args: {
      taskKey: string;
      stageId?: string;
      addLabels?: string[];
      removeLabels?: string[];
      note?: string;
      title?: string;
      description?: string;
      repo?: string | null;
      relations?: RelationsChange;
      themeKey?: string | null;
      priority?: TaskPriority | null;
      developerLevel?: DeveloperLevelRequest;
    },
  ): Promise<{ task: Task }> {
    return this.calls.guard(async () => {
      const who = await this.calls.callerWithRequest(ctx, 'update_task');
      const { config } = who;
      // One call is one step of the Operator's request: the biggest change in it names the step.
      const action: OperatorAction = args.stageId
        ? 'task_move'
        : (args.addLabels?.length ?? 0) + (args.removeLabels?.length ?? 0) > 0
          ? 'task_labels'
          : args.priority !== undefined
            ? 'task_priority'
            : 'task_update';
      let awaiting = false;
      return this.calls.recorded(
        who,
        { action, taskKey: args.taskKey },
        () => this.updateTaskOf(ctx, config, args, () => (awaiting = true)),
        () => awaiting,
      );
    });
  }

  async createTask(
    ctx: ToolContext,
    args: {
      title: string;
      description?: string;
      labels?: string[];
      visibility?: Visibility;
      parentKey?: string;
      relations?: AddRelationRef[];
      kind?: TaskKind;
      themeKey?: string;
      developerLevel?: DeveloperLevelRequest;
    },
  ): Promise<{ task: Task }> {
    return this.calls.guard(async () => {
      const who = await this.calls.callerWithRequest(ctx, 'create_task');
      const { config } = who;
      return this.calls.recorded(
        who,
        { action: 'task_create', madeTask: (made) => made.task.key },
        async () => {
          const title = args.title.trim();
          if (!title) throw new TeamToolError('invalid', 'The title is empty.');
          const labels = unique((args.labels ?? []).map((l) => l.trim()).filter(Boolean));
          // No stage: a new task starts in the pipeline's first (queue) stage, where humans prioritise it.
          const task = await this.tasks.create(
            ctx.projectKey,
            {
              title,
              parentKey: args.parentKey,
              description: args.description?.trim() ?? '',
              labels,
              visibility: args.visibility ?? 'internal',
              ...(args.relations?.length ? { relations: args.relations } : {}),
              ...(args.kind ? { kind: args.kind } : {}),
              ...(args.themeKey ? { themeKey: args.themeKey } : {}),
              ...(args.developerLevel ? { developerLevel: args.developerLevel } : {}),
            },
            aiActor(ctx.member),
            { sessionId: ctx.sessionId },
          );
          return { task };
        },
      );
    });
  }

  /**
   * The task detail as the guest of the Operator sees it (PM-475): the whole card (PM-79), but the quote of
   * a team message the guest is not a party to is cut (PM-78), and the Operator's own undelivered and
   * pending messages are not the guest's.
   */
  private taskDetailForGuest(whole: TaskToolDetail, viewer: Viewer): TaskToolDetail {
    const participants = (id: string) => this.ctx.repos.messages.get(id);
    const { event, undeliveredMessageIds: _undelivered, pendingSentMessages: _pending, ...rest } = whole;
    const shown = { ...rest, ...visibleTaskDetail(viewer, rest, participants) };
    return event ? { ...shown, event: visibleTimelineEvent(viewer, event, participants) } : shown;
  }

  private async taskToolDetail(
    ctx: ToolContext,
    config: ProjectConfig,
    taskKey: string,
    eventId: string | undefined,
    guest: GuestView | null,
  ): Promise<TaskToolDetail> {
    const detail = this.tasks.detail(ctx.projectKey, taskKey, 50);
    if (eventId !== undefined) {
      const event = this.timeline.get(ctx.projectKey, eventId);
      if (!event || event.taskKey !== taskKey)
        throw new TeamToolError('not_found', `${taskKey} has no timeline event ${eventId}.`);
      return { ...detail, event };
    }
    const attachments = await this.attachments.list(
      ctx.projectKey,
      taskKey,
      guest ? humanActor(guest.handle) : aiActor(ctx.member),
    );
    // A card shows its theme (its own, or its parent's); a theme shows its cards and how far it is (PM-192).
    const themeCard = detail.task.themeKey ? this.tasks.find(ctx.projectKey, detail.task.themeKey) : null;
    const theme = isTheme(detail.task) ? this.tasks.themeOf(ctx.projectKey, taskKey) : null;
    const cardWorkers = this.sessions.cardWorkersFor(config, detail.task, ctx.member);
    const focus = this.projectFocus.places(ctx.projectKey).get(taskKey);
    const wait = this.taskWaits.ofCard(config, detail.task);
    const mergeChecks = this.ctx.repos.mergeCheckRuns.list({
      projectKey: ctx.projectKey,
      taskKey,
      limit: MERGE_CHECKS_IN_TASK,
    }).runs;
    return {
      ...detail,
      ...(mergeChecks.length > 0 ? { mergeChecks } : {}),
      ...(wait ? { wait } : {}),
      effectiveRepo: effectiveRepo(config, detail.task),
      ...(focus ? { focus } : {}),
      repoChoiceNeeded: needsRepoChoice(config, detail.task),
      relations: this.tasks.relationsOf(ctx.projectKey, taskKey),
      ...(themeCard
        ? {
            theme: {
              key: themeCard.key,
              title: themeCard.title,
              stageId: themeCard.stageId,
              status: themeCard.status,
            },
          }
        : {}),
      ...(theme ? { themeCards: theme.cards, themeProgress: theme.progress } : {}),
      // Who works on the card now and what was asked on it (PM-249), as the brief lists them.
      workingSessionIds: this.sessions
        .cardWorkers(ctx.projectKey, detail.task, config)
        .map((session) => session.id),
      ...(cardWorkers.length ? { cardWorkers } : {}),
      cardQuestions: this.cardQuestions.list(ctx.projectKey, taskKey, { limit: QUESTION_LIMIT }),
      attachments: {
        attachments: attachments.slice(0, ATTACHMENTS_IN_TASK),
        total: attachments.length,
        offset: 0,
      },
      // The timeline shows excerpts: a message that is on its way says so (PM-180).
      undeliveredMessageIds: this.ctx.repos.messages.pending(ctx.projectKey, ctx.member).map((m) => m.id),
      // The caller's own messages on this card that are not typed in for every AI recipient yet (PM-144).
      pendingSentMessages: this.ctx.repos.messages
        .pendingFrom(ctx.projectKey, ctx.member, taskKey)
        .flatMap((m) => {
          const waiting = (m.receipts ?? []).filter((r) => r.kind === 'ai' && !r.deliveredAt);
          const handles = m.to.filter((handle) => waiting.some((r) => r.handle === handle));
          return handles.length > 0 ? [{ messageId: m.id, handles }] : [];
        }),
    };
  }

  private async updateTaskOf(
    ctx: ToolContext,
    config: ProjectConfig,
    args: Parameters<TaskToolsHandler['updateTask']>[1],
    onApproval: () => void,
  ): Promise<{ task: Task }> {
    const taskKey = this.calls.validTaskKey(ctx, args.taskKey);
    // The whole call is one change, all or nothing: title, description, labels and note are
    // recorded before the stage move, so one call can add "code review ok" and pass the gate.
    if (args.stageId && !config.pipeline.stages.some((s) => s.id === args.stageId)) {
      throw new TeamToolError(
        'invalid',
        `Unknown stage "${args.stageId}". Stages in pipeline order: ` +
          `${config.pipeline.stages.map((s) => s.id).join(', ')}.`,
      );
    }
    const title = args.title?.trim();
    if (args.title !== undefined && !title) throw new TeamToolError('invalid', 'The title is empty.');
    const description = args.description?.trim();
    if (args.description !== undefined && !description) {
      throw new TeamToolError('invalid', 'The description is empty; pass the whole new description.');
    }
    try {
      const task = await this.tasks.update(
        ctx.projectKey,
        taskKey,
        {
          title,
          description,
          repo: args.repo,
          ...(args.relations ? { relations: args.relations } : {}),
          ...(args.themeKey !== undefined ? { themeKey: args.themeKey } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.developerLevel ? { developerLevel: args.developerLevel } : {}),
          addLabels: args.addLabels,
          removeLabels: args.removeLabels,
          note: args.note,
          stageId: args.stageId,
        },
        aiActor(ctx.member),
        { sessionId: ctx.sessionId },
      );
      await this.markWorkReturned(ctx, task, args.addLabels);
      return { task };
    } catch (err) {
      if (err instanceof DomainError && err.code === 'approval_requested') {
        const { approvers } = err.details as { approvers: string[] };
        onApproval();
        // The labels of the call were recorded before the move waited for the approval.
        await this.markWorkReturned(ctx, this.tasks.get(ctx.projectKey, taskKey), args.addLabels);
        throw new TeamToolError(
          'gate_blocked',
          `Moving ${taskKey} to ${args.stageId} needs a human approval. It was requested from ` +
            `${approvers.join(', ')}; the task moves automatically once they approve. The rest of this ` +
            'call was recorded.',
        );
      }
      throw err;
    }
  }

  /** A verdict that gives the work back marks the caller's session to close when idle (PM-570); never fails the call. */
  private async markWorkReturned(
    ctx: ToolContext,
    task: Task,
    addLabels: readonly string[] | undefined,
  ): Promise<void> {
    if (!addLabels?.length) return;
    await this.closer.workReturned(ctx.sessionId, task, addLabels).catch((err: unknown) => {
      this.ctx.logger.warn({ err, taskKey: task.key }, 'could not mark the session of a returned verdict');
    });
  }
}
