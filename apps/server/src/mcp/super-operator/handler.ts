import {
  effectiveRepo,
  isOpenTask,
  isTheme,
  needsRepoChoice,
  TaskKey,
  TaskStatus as TaskStatusSchema,
} from '@projectman/shared';
import type {
  HistorySearchInput,
  HistorySearchResult,
  HistorySourceRead,
  HistoryViewer,
  Task,
} from '@projectman/shared';
import { taskWaitShort } from '../../agent-text';
import { TeamToolError } from '../../contracts';
import type {
  AttachmentOperations,
  ExternalMcpBackend,
  ExternalSentMessage,
  ExternalToolContext,
  ExternalToolsHandler,
  HistoryService,
  HistorySourceReadArgs,
  IntegratorCredentialAuthority,
  IntegratorPrincipal,
  ListTasksInput,
  TaskSummary,
  TaskToolDetail,
} from '../../contracts';
import { QUESTION_LIMIT } from '../../core/inbox';
import type { CardQuestions, InboxService } from '../../core/inbox';
import type { Messaging } from '../../core/messages';
import type { MemberService, ProjectAccess } from '../../core/members';
import { canSeeTask } from '../../core/projects';
import type { ProjectService } from '../../core/projects';
import type { ProjectFocusService, TaskService, TaskWaits } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import { attributedActor, forbidden, unique } from '../../kernel';
import type { ProjectState } from '../../services/operator';
import type { ReleaseService } from '../../services/releases';
import { relayOwnerAnswer, resolveIntegratorTodo } from '../../services/super-operator';
import type { SuperAdministration, SuperHandoffService, SuperOperator } from '../../services/super-operator';

/** Attachments get_task shows; the rest are paged with list_attachments. */
const ATTACHMENTS_IN_TASK = 20;
const MAX_ATTACHMENT_PAGE = 100;

export interface ExternalToolsDeps {
  credentials: IntegratorCredentialAuthority;
  superOperator: Pick<SuperOperator, 'access' | 'execute' | 'executeOwned'>;
  accessFor(projectKey: string, email: string): Promise<ProjectAccess | null>;
  projects: Pick<ProjectService, 'has' | 'config'>;
  tasks: Pick<
    TaskService,
    'list' | 'find' | 'get' | 'detail' | 'relationsOf' | 'themeOf' | 'update' | 'create'
  >;
  timeline: Pick<TimelineService, 'get'>;
  taskWaits: Pick<TaskWaits, 'of' | 'ofCard'>;
  projectFocus: Pick<ProjectFocusService, 'places'>;
  cardQuestions: Pick<CardQuestions, 'list'>;
  attachments: Pick<AttachmentOperations, 'list'>;
  messaging: Pick<Messaging, 'sendReporting'>;
  members: Pick<MemberService, 'rosterFor'>;
  projectState: Pick<ProjectState, 'task' | 'message' | 'overview' | 'externalDiagnostics'>;
  releases: Pick<ReleaseService, 'check'>;
  superHandoffs: Pick<SuperHandoffService, 'list' | 'execute'>;
  superAdministration: SuperAdministration;
  inbox: Pick<InboxService, 'get' | 'resolve' | 'resolveIntegratorTodo'>;
  history: Pick<HistoryService, 'search' | 'read'>;
}

/**
 * The domain calls of the bearer MCP (PM-760). The caller is an integrator key, not a member: there is no
 * session, no member handle and no working directory here. Every call is bound to one project by the context
 * `bind` produced; the ProjectAccess behind it stays in this class, so the context type carries no session field.
 */
export class ExternalTools implements ExternalToolsHandler {
  private readonly accesses = new WeakMap<ExternalToolContext, ProjectAccess>();

  private readonly deps: ExternalToolsDeps;

  constructor(deps: ExternalToolsDeps) {
    this.deps = deps;
  }

  /** The credential holder's email, the credential still active; a holder that is gone has no rights. */
  private holder(principal: IntegratorPrincipal): string {
    this.deps.credentials.assertActive(principal);
    const user = this.deps.credentials.user(principal.userId);
    if (!user) throw forbidden('insufficient_access', 'the credential owner does not exist');
    return user.email;
  }

  /**
   * The holder's ownership of the project, read now. An unknown project and a project of which the holder is no
   * owner are refused alike, so the answer does not tell which project keys exist.
   */
  async owned(principal: IntegratorPrincipal, projectKey: string): Promise<ProjectAccess> {
    const email = this.holder(principal);
    const access = this.deps.projects.has(projectKey) ? await this.deps.accessFor(projectKey, email) : null;
    if (access?.access !== 'owner')
      throw forbidden('insufficient_access', `the key's holder is not an owner of the project ${projectKey}`);
    return access;
  }

  async bind(
    input: { principal: IntegratorPrincipal; projectKey: string; requestId: string },
    operation: 'read' | 'write',
  ): Promise<ExternalToolContext> {
    const { principal, projectKey, requestId } = input;
    if (operation === 'write' && principal.mode === 'read')
      throw forbidden('integrator_read_only', 'a read-only credential cannot change anything');
    const owner = await this.owned(principal, projectKey);
    const access =
      principal.mode === 'legacy'
        ? ({ ...owner, via: 'integrator' } satisfies ProjectAccess)
        : await this.deps.superOperator.access(
            { principal, email: this.holder(principal), requestId },
            owner,
            operation,
          );
    const ctx: ExternalToolContext = { principal, projectKey, actor: attributedActor(access), requestId };
    this.accesses.set(ctx, access);
    return ctx;
  }

  /** The tool calls run inside `execute`: the key, the audit and the project bound; a legacy key has no scope (as in REST). */
  backend(): ExternalMcpBackend {
    return {
      handler: this,
      bind: (input, operation) => this.bind(input, operation),
      execute: async (context, target, run) => {
        const { principal } = context;
        await this.owned(principal, target.projectKey);
        if (principal.mode === 'legacy') return run();
        return this.deps.superOperator.execute(
          { principal, email: this.holder(principal), requestId: context.requestId },
          target,
          run,
        );
      },
    };
  }

  private access(ctx: ExternalToolContext): ProjectAccess {
    const access = this.accesses.get(ctx);
    if (!access) throw forbidden('insufficient_access', 'the call has no bound access');
    return access;
  }

  private taskKeyOf(projectKey: string, taskKey: string): string {
    if (!TaskKey.safeParse(taskKey).success)
      throw new TeamToolError(
        'invalid',
        `Invalid task key "${taskKey}"; task keys look like "${projectKey}-12".`,
      );
    if (!this.deps.tasks.find(projectKey, taskKey))
      throw new TeamToolError('not_found', `Task ${taskKey} does not exist in this project.`);
    return taskKey;
  }

  async listProjects(
    principal: IntegratorPrincipal,
    requestId: string,
  ): Promise<{ projects: { key: string; name: string }[] }> {
    const email = this.holder(principal);
    // A holder who is an owner of no project gets an empty list, never an error.
    return {
      projects: await this.deps.superOperator.executeOwned(
        { principal, email, requestId },
        'mcp_list_projects',
        async (projects) => projects,
      ),
    };
  }

  async listTasks(ctx: ExternalToolContext, args: ListTasksInput): Promise<TaskSummary[]> {
    const { projectKey } = ctx;
    const config = await this.deps.projects.config(projectKey);
    const status = args.status ?? 'open';
    const limit = args.limit ?? 50;
    if (status !== 'open' && !TaskStatusSchema.safeParse(status).success)
      throw new TeamToolError('invalid', 'Invalid task status.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new TeamToolError('invalid', 'limit must be an integer between 1 and 200.');
    if (args.assignee === 'me')
      throw new TeamToolError('invalid', 'assignee "me" has no meaning here: name a member handle.');
    const places = this.deps.projectFocus.places(projectKey);
    const access = this.access(ctx);
    const cards = this.deps.tasks
      .list(projectKey)
      .filter(
        (task) =>
          canSeeTask(access, task) &&
          (status === 'open' ? isOpenTask(task) : task.status === status) &&
          // A theme is in no stage (it carries the first one's id because the field is required).
          (args.stage === undefined || (!isTheme(task) && task.stageId === args.stage)) &&
          (args.assignee === undefined || task.assignee === args.assignee),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key))
      .slice(0, limit);
    const waits = this.deps.taskWaits.of(config, cards);
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
  }

  async getTask(
    ctx: ExternalToolContext,
    args: { taskKey: string; eventId?: string },
  ): Promise<TaskToolDetail> {
    const { projectKey } = ctx;
    const config = await this.deps.projects.config(projectKey);
    const taskKey = this.taskKeyOf(projectKey, args.taskKey);
    const detail = this.deps.tasks.detail(projectKey, taskKey, 50);
    if (args.eventId !== undefined) {
      const event = this.deps.timeline.get(projectKey, args.eventId);
      if (!event || event.taskKey !== taskKey)
        throw new TeamToolError('not_found', `${taskKey} has no timeline event ${args.eventId}.`);
      return { ...detail, event };
    }
    const attachments = await this.deps.attachments.list(projectKey, taskKey, ctx.actor);
    const themeCard = detail.task.themeKey ? this.deps.tasks.find(projectKey, detail.task.themeKey) : null;
    const theme = isTheme(detail.task) ? this.deps.tasks.themeOf(projectKey, taskKey) : null;
    const focus = this.deps.projectFocus.places(projectKey).get(taskKey);
    const wait = this.deps.taskWaits.ofCard(config, detail.task);
    return {
      ...detail,
      ...(wait ? { wait } : {}),
      effectiveRepo: effectiveRepo(config, detail.task),
      ...(focus ? { focus } : {}),
      repoChoiceNeeded: needsRepoChoice(config, detail.task),
      relations: this.deps.tasks.relationsOf(projectKey, taskKey),
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
      cardQuestions: this.deps.cardQuestions.list(projectKey, taskKey, { limit: QUESTION_LIMIT }),
      attachments: {
        attachments: attachments.slice(0, ATTACHMENTS_IN_TASK),
        total: attachments.length,
        offset: 0,
      },
    };
  }

  async createTask(
    ctx: ExternalToolContext,
    args: Parameters<ExternalToolsHandler['createTask']>[1],
  ): Promise<{ task: Task }> {
    const title = args.title.trim();
    if (!title) throw new TeamToolError('invalid', 'The title is empty.');
    const labels = unique((args.labels ?? []).map((l) => l.trim()).filter(Boolean));
    // No stage: a new task starts in the pipeline's first (queue) stage, where humans prioritise it.
    const task = await this.deps.tasks.create(
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
      ctx.actor,
    );
    return { task };
  }

  async updateTask(
    ctx: ExternalToolContext,
    args: Parameters<ExternalToolsHandler['updateTask']>[1],
  ): Promise<{ task: Task }> {
    const config = await this.deps.projects.config(ctx.projectKey);
    const taskKey = this.taskKeyOf(ctx.projectKey, args.taskKey);
    if (args.stageId && !config.pipeline.stages.some((s) => s.id === args.stageId))
      throw new TeamToolError(
        'invalid',
        `Unknown stage "${args.stageId}". Stages in pipeline order: ` +
          `${config.pipeline.stages.map((s) => s.id).join(', ')}.`,
      );
    const title = args.title?.trim();
    if (args.title !== undefined && !title) throw new TeamToolError('invalid', 'The title is empty.');
    const description = args.description?.trim();
    if (args.description !== undefined && !description)
      throw new TeamToolError('invalid', 'The description is empty; pass the whole new description.');
    // The whole call is one change, all or nothing; a gate that waits for approval is the domain's own refusal.
    const task = await this.deps.tasks.update(
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
      ctx.actor,
    );
    return { task };
  }

  async sendMessage(
    ctx: ExternalToolContext,
    args: Parameters<ExternalToolsHandler['sendMessage']>[1],
  ): Promise<ExternalSentMessage> {
    const access = this.access(ctx);
    if (args.taskKey !== undefined) this.taskKeyOf(ctx.projectKey, args.taskKey);
    const sender = access.superActor?.handle ?? access.handle;
    const { message, recipients } = await this.deps.messaging.sendReporting(
      ctx.projectKey,
      sender,
      { to: args.to, text: args.text, taskKey: args.taskKey ?? null },
      { actor: ctx.actor, kind: args.kind, workerCheck: !args.despiteWorkers },
    );
    return { messageId: message.id, deliveredTo: message.to, recipients };
  }

  async listMembers(ctx: ExternalToolContext) {
    return this.deps.members.rosterFor(await this.deps.projects.config(ctx.projectKey));
  }

  async getProjectState(ctx: ExternalToolContext, args: { taskKey?: string; messageId?: string }) {
    if (args.messageId !== undefined) {
      if (args.taskKey !== undefined)
        throw new TeamToolError('invalid', 'Give either task_key or message_id, not both.');
      return this.deps.projectState.message(ctx.projectKey, args.messageId);
    }
    return args.taskKey
      ? this.deps.projectState.task(ctx.projectKey, this.taskKeyOf(ctx.projectKey, args.taskKey))
      : this.deps.projectState.overview(ctx.projectKey);
  }

  async getOperatorDiagnostics(ctx: ExternalToolContext, args: { taskKey: string; limit?: number }) {
    const taskKey = this.taskKeyOf(ctx.projectKey, args.taskKey);
    // The machine read can wait for an engine: the key and the ownership are read again after it.
    return this.deps.projectState.externalDiagnostics(ctx.projectKey, taskKey, args.limit, async () => {
      await this.owned(ctx.principal, ctx.projectKey);
    });
  }

  async listAttachments(
    ctx: ExternalToolContext,
    args: { taskKey: string; offset?: number; limit?: number },
  ) {
    const taskKey = this.taskKeyOf(ctx.projectKey, args.taskKey);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 50;
    if (!Number.isInteger(offset) || offset < 0)
      throw new TeamToolError('invalid', 'offset must be a whole number, 0 or more.');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ATTACHMENT_PAGE)
      throw new TeamToolError('invalid', `limit must be an integer between 1 and ${MAX_ATTACHMENT_PAGE}.`);
    const all = await this.deps.attachments.list(ctx.projectKey, taskKey, ctx.actor);
    return { attachments: all.slice(offset, offset + limit), total: all.length, offset };
  }

  async checkRelease(ctx: ExternalToolContext, args: { commit?: string }) {
    return this.deps.releases.check(ctx.projectKey, args.commit);
  }

  async listSuperHandoffs(
    ctx: ExternalToolContext,
    query: Parameters<ExternalToolsHandler['listSuperHandoffs']>[1],
  ) {
    return { handoffs: this.deps.superHandoffs.list(ctx.projectKey, query) };
  }

  async executeSuperHandoff(ctx: ExternalToolContext, args: { handoffId: string; requestId: string }) {
    return {
      operation: await this.deps.superHandoffs.execute(
        ctx.projectKey,
        args.handoffId,
        args.requestId,
        this.access(ctx),
      ),
    };
  }

  async superOperate(ctx: ExternalToolContext, request: Parameters<ExternalToolsHandler['superOperate']>[1]) {
    return {
      operation: await this.deps.superAdministration.operate(ctx.projectKey, request, this.access(ctx)),
    };
  }

  async getSuperOperation(ctx: ExternalToolContext, operationId: string) {
    return this.deps.superAdministration.operation(ctx.projectKey, operationId);
  }

  async querySuperDiagnostics(
    ctx: ExternalToolContext,
    request: Parameters<ExternalToolsHandler['querySuperDiagnostics']>[1],
  ) {
    return this.deps.superAdministration.query(ctx.projectKey, request);
  }

  async getAdministrationStatus(
    ctx: ExternalToolContext,
    target: Parameters<ExternalToolsHandler['getAdministrationStatus']>[1],
  ) {
    return { status: await this.deps.superAdministration.status(ctx.projectKey, target) };
  }

  async getAdministrationLogs(
    ctx: ExternalToolContext,
    args: Parameters<ExternalToolsHandler['getAdministrationLogs']>[1],
  ) {
    return this.deps.superAdministration.logs(ctx.projectKey, args.target, args.limit);
  }

  async resolveIntegratorTodo(
    ctx: ExternalToolContext,
    args: { itemId: string; optionId: 'todo_done' | 'todo_cannot'; note?: string },
  ) {
    return resolveIntegratorTodo(
      this.deps,
      ctx.projectKey,
      args.itemId,
      { optionId: args.optionId, ...(args.note !== undefined ? { note: args.note } : {}) },
      this.access(ctx),
    );
  }

  async relayOwnerAnswer(ctx: ExternalToolContext, args: { itemId: string; answer: string }) {
    return relayOwnerAnswer(this.deps, ctx.projectKey, args.itemId, args.answer, this.access(ctx));
  }

  /**
   * The history search for the bound access (PM-787): the shared facade with the integrator's own viewer, so
   * the visibility rule and the measurement are the member tool's. The project's configuration is loaded first
   * (the authenticated read), then the facade decides synchronously from it.
   */
  private async historyViewer(ctx: ExternalToolContext): Promise<HistoryViewer> {
    await this.deps.projects.config(ctx.projectKey);
    const access = this.access(ctx);
    return { handle: access.handle, access: access.access, via: 'integrator' };
  }

  async searchHistory(ctx: ExternalToolContext, args: HistorySearchInput): Promise<HistorySearchResult> {
    return this.deps.history.search(ctx.projectKey, await this.historyViewer(ctx), args);
  }

  async readHistorySource(ctx: ExternalToolContext, args: HistorySourceReadArgs): Promise<HistorySourceRead> {
    return this.deps.history.read(ctx.projectKey, await this.historyViewer(ctx), args);
  }
}
