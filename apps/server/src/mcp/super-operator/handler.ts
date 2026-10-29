import {
  EXTERNAL_ATTACHMENT_DEFAULT_CHUNK_BYTES,
  EXTERNAL_ATTACHMENT_MAX_FILE_BYTES,
  effectiveRepo,
  isIntegratorInboxItem,
  isOpenTask,
  isTheme,
  machineTodoIssuerAllowed,
  machineTodoIssuerOf,
  memberOf,
  needsRepoChoice,
  questionPayloadOf,
  roleBundle,
  TaskKey,
  TaskStatus as TaskStatusSchema,
} from '@projectman/shared';
import type { HostRequestState } from '@projectman/shared';
import type {
  ExternalAttachmentRead,
  ExternalDocWriteState,
  ExternalQuestionRead,
  HistorySearchInput,
  HistorySearchResult,
  HistorySourceRead,
  HistoryViewer,
  ProjectDoc,
  ResolveIntegratorFixLimitRequest,
  Task,
} from '@projectman/shared';
import type { Readable } from 'node:stream';
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
  HumanQuestionsPort,
  IntegratorCredentialAuthority,
  IntegratorPrincipal,
  ListTasksInput,
  OperatorKnowledgeStore,
  ProjectDocWrite,
  TaskSummary,
  TaskToolDetail,
} from '../../contracts';
import { QUESTION_LIMIT } from '../../core/inbox';
import type { CardQuestions, InboxService } from '../../core/inbox';
import type { Messaging } from '../../core/messages';
import type { MemberService, ProjectAccess } from '../../core/members';
import type { ProjectService } from '../../core/projects';
import type { TaskService, TaskWaits } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import {
  attributedActor,
  conflict,
  DomainError,
  externalToolOrigin,
  forbidden,
  integratorOwnerId,
  invalid,
  unique,
} from '../../kernel';
import type { HostRequestsService } from '../../services/host-requests';
import type { ProjectState, StructuralReviews } from '../../services/operator';
import { docWindow } from '../../services/project-docs';
import type { DocWrites } from '../../services/project-docs';
import {
  INTEGRATOR_INBOX_LIMIT,
  listIntegratorInbox,
  relayOwnerAnswer,
  resolveIntegratorFixLimit,
  resolveIntegratorTodo,
  updateInstanceKnowledge,
} from '../../services/super-operator';
import type { SuperOperations, SuperHandoffService, SuperOperator } from '../../services/super-operator';

/** Attachments get_task shows; the rest are paged with list_attachments. */
const ATTACHMENTS_IN_TASK = 20;
const MAX_ATTACHMENT_PAGE = 100;

interface ExternalToolsDeps {
  credentials: IntegratorCredentialAuthority;
  superOperator: Pick<SuperOperator, 'access' | 'execute' | 'executeOwned'>;
  accessFor(projectKey: string, email: string): Promise<ProjectAccess | null>;
  projects: Pick<ProjectService, 'has' | 'config' | 'load'>;
  tasks: Pick<
    TaskService,
    'list' | 'find' | 'get' | 'detail' | 'relationsOf' | 'themeOf' | 'update' | 'create'
  >;
  timeline: Pick<TimelineService, 'get'>;
  taskWaits: Pick<TaskWaits, 'of' | 'ofCard'>;
  cardQuestions: Pick<CardQuestions, 'list'>;
  attachments: Pick<AttachmentOperations, 'list' | 'open'>;
  messaging: Pick<Messaging, 'sendReporting'>;
  members: Pick<MemberService, 'rosterFor'>;
  projectState: Pick<ProjectState, 'task' | 'message' | 'overview' | 'externalDiagnostics'>;
  docWrites: Pick<DocWrites, 'read' | 'requestExternal' | 'externalState'>;
  humanQuestions: HumanQuestionsPort;
  structuralReviews: Pick<StructuralReviews, 'requestExternal'>;
  superHandoffs: Pick<SuperHandoffService, 'list' | 'execute'>;
  superOperations: SuperOperations;
  inbox: Pick<
    InboxService,
    'get' | 'list' | 'resolve' | 'resolveIntegratorTodo' | 'resolveIntegratorFixLimit'
  >;
  history: Pick<HistoryService, 'search' | 'read'>;
  operatorKnowledge: Pick<
    OperatorKnowledgeStore,
    'readInstanceKnowledge' | 'compareAndSwapInstanceKnowledge'
  >;
  hostRequests: Pick<HostRequestsService, 'listForHost' | 'answer'>;
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

  /**
   * The member a step on an open queue item is made as (decision 66): the issuer of an integrator queue item
   * that is open for the key's holder and was put in the queue by a member with machine access (the screening
   * member of a screened question, otherwise the item's source: `machineTodoIssuerOf`). An item the system
   * issued has no member behind it: null, and the holder acts in person.
   */
  async queueIssuer(
    input: { principal: IntegratorPrincipal; projectKey: string },
    queueItemId: string,
  ): Promise<string | null> {
    const holder = await this.owned(input.principal, input.projectKey);
    const item = (() => {
      try {
        return this.deps.inbox.get(input.projectKey, queueItemId);
      } catch {
        return null;
      }
    })();
    if (
      !item ||
      item.state !== 'open' ||
      !isIntegratorInboxItem(item) ||
      !item.assignees.includes(holder.handle)
    )
      throw forbidden('queue_item_not_yours', 'the queue item is not open for the key’s holder');
    const config = await this.deps.projects.config(input.projectKey);
    const issuer = machineTodoIssuerOf(item.source, questionPayloadOf(item)?.screening?.by);
    if (!machineTodoIssuerAllowed(config, issuer))
      throw conflict(
        'issuer_without_machine_access',
        'the member who issued the queue item has no machine access',
      );
    return memberOf(config, issuer) ? issuer : null;
  }

  async bind(
    input: { principal: IntegratorPrincipal; projectKey: string; requestId: string; issuer?: string },
    operation: 'read' | 'write',
  ): Promise<ExternalToolContext> {
    const { principal, projectKey, requestId, issuer } = input;
    if (operation === 'write' && principal.mode === 'read')
      throw forbidden('integrator_read_only', 'a read-only credential cannot change anything');
    const owner = await this.owned(principal, projectKey);
    const access = await this.deps.superOperator.access(
      { principal, email: this.holder(principal), requestId, ...(issuer ? { issuer } : {}) },
      owner,
      operation,
    );
    const ctx: ExternalToolContext = { principal, projectKey, actor: attributedActor(access), requestId };
    this.accesses.set(ctx, access);
    return ctx;
  }

  /** The tool calls run inside `execute`: the key, the audit and the project bound. */
  backend(): ExternalMcpBackend {
    return {
      handler: this,
      isHost: (principal) => this.deps.credentials.isHostOwner?.(principal.userId) ?? false,
      bind: (input, operation) => this.bind(input, operation),
      queueIssuer: (input, queueItemId) => this.queueIssuer(input, queueItemId),
      execute: async (context, target, run) => {
        const { principal } = context;
        await this.owned(principal, target.projectKey);
        return this.deps.superOperator.execute(
          {
            principal,
            email: this.holder(principal),
            requestId: context.requestId,
            ...(context.issuer ? { issuer: context.issuer } : {}),
          },
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
    const cards = this.deps.tasks
      .list(projectKey)
      .filter(
        (task) =>
          (status === 'open' ? isOpenTask(task) : task.status === status) &&
          // A theme is in no stage (it carries the first one's id because the field is required).
          (args.stage === undefined || (!isTheme(task) && task.stageId === args.stage)) &&
          (args.assignee === undefined || task.assignee === args.assignee),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key))
      .slice(0, limit);
    const waits = this.deps.taskWaits.of(config, cards);
    return cards.map(
      ({ key, title, stageId, status, assignee, labels, updatedAt, kind, priority, complexity }) => {
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
          ...(complexity ? { complexity: complexity.points } : {}),
          ...(priority !== null ? { priority } : {}),
          ...(wait ? { waitsFor: taskWaitShort(wait) } : {}),
        };
      },
    );
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
    const wait = this.deps.taskWaits.ofCard(config, detail.task);
    return {
      ...detail,
      ...(wait ? { wait } : {}),
      effectiveRepo: effectiveRepo(config, detail.task),
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
        ...(args.relations?.length ? { relations: args.relations } : {}),
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.themeKey ? { themeKey: args.themeKey } : {}),
        ...(args.complexity ? { complexity: args.complexity } : {}),
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
        ...(args.complexity ? { complexity: args.complexity } : {}),
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
      operation: await this.deps.superOperations.operate(ctx.projectKey, request, this.access(ctx)),
    };
  }

  async getSuperOperation(ctx: ExternalToolContext, operationId: string) {
    return this.deps.superOperations.operation(ctx.projectKey, operationId);
  }

  async querySuperDiagnostics(
    ctx: ExternalToolContext,
    request: Parameters<ExternalToolsHandler['querySuperDiagnostics']>[1],
  ) {
    return this.deps.superOperations.query(ctx.projectKey, request);
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

  async resolveIntegratorFixLimit(
    ctx: ExternalToolContext,
    args: { itemId: string; optionId: ResolveIntegratorFixLimitRequest['optionId']; note?: string },
  ) {
    return resolveIntegratorFixLimit(
      this.deps,
      ctx.projectKey,
      args.itemId,
      { optionId: args.optionId, ...(args.note !== undefined ? { note: args.note } : {}) },
      this.access(ctx),
    );
  }

  /**
   * What is addressed to the integrator: in one project, or without `projectKey` in every project of the key.
   * The access is checked per project, so a project the holder does not own is left out, never an error.
   */
  async listIntegratorInbox(
    principal: IntegratorPrincipal,
    requestId: string,
    args: { projectKey?: string; state: 'open' | 'all' },
  ) {
    const read = async (projectKey: string) => {
      const ctx = await this.bind({ principal, projectKey, requestId }, 'read');
      return listIntegratorInbox(this.deps, projectKey, args.state, this.access(ctx)).items;
    };
    if (args.projectKey !== undefined) {
      const { projectKey } = args;
      const target = { projectKey, operation: 'mcp_list_integrator_inbox' };
      return {
        items: await this.backend().execute({ principal, requestId }, target, () => read(projectKey)),
      };
    }
    const email = this.holder(principal);
    const items = await this.deps.superOperator.executeOwned(
      { principal, email, requestId },
      'mcp_list_integrator_inbox',
      async (projects) => (await Promise.all(projects.map((project) => read(project.key)))).flat(),
    );
    return {
      items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, INTEGRATOR_INBOX_LIMIT),
    };
  }

  /**
   * What only the instance host's key does (the instance knowledge, PM-1061; the requests to the host, PM-1064):
   * it needs at least one project the key's holder owns, where the audit lands.
   */
  private async hostScope<T>(
    principal: IntegratorPrincipal,
    requestId: string,
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const email = this.holder(principal);
    // The instance knowledge describes the host's machine: only the host owner's key reads or changes it (PM-1061).
    if (!this.deps.credentials.isHostOwner?.(principal.userId))
      throw forbidden('host_only', 'only the host owner’s key may use this');
    return this.deps.superOperator.executeOwned(
      { principal, email, requestId },
      operation,
      async (projects) => {
        if (projects.length === 0)
          throw forbidden('insufficient_access', 'the key’s holder is not an owner of any project');
        return run();
      },
    );
  }

  async getInstanceKnowledge(principal: IntegratorPrincipal, requestId: string) {
    return this.hostScope(principal, requestId, 'mcp_get_operator_instance_knowledge', () =>
      this.deps.operatorKnowledge.readInstanceKnowledge(),
    );
  }

  async updateInstanceKnowledge(
    principal: IntegratorPrincipal,
    requestId: string,
    args: Parameters<ExternalToolsHandler['updateInstanceKnowledge']>[2],
  ) {
    return this.hostScope(principal, requestId, 'mcp_update_operator_instance_knowledge', () =>
      updateInstanceKnowledge(this.deps.operatorKnowledge, args, new Date().toISOString()),
    );
  }

  async listHostInbox(principal: IntegratorPrincipal, requestId: string, args: { state?: HostRequestState }) {
    return this.hostScope(principal, requestId, 'mcp_list_host_inbox', () =>
      this.deps.hostRequests.listForHost(principal.userId, args.state),
    );
  }

  async answerHostRequest(
    principal: IntegratorPrincipal,
    requestId: string,
    args: Parameters<ExternalToolsHandler['answerHostRequest']>[2],
  ) {
    return this.hostScope(principal, requestId, 'mcp_answer_host_request', () =>
      this.deps.hostRequests.answer(
        principal.userId,
        args.id,
        { outcome: args.outcome, answer: args.answer },
        'super',
      ),
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

  async readProjectDoc(
    ctx: ExternalToolContext,
    args: { doc: ProjectDoc; fromLine?: number; lineCount?: number },
  ) {
    const read = await this.deps.docWrites.read(ctx.projectKey, this.access(ctx).handle, args.doc);
    return docWindow(args.doc, read, args.fromLine, args.lineCount);
  }

  async writeProjectDocs(
    ctx: ExternalToolContext,
    args: Parameters<ExternalToolsHandler['writeProjectDocs']>[1],
  ): Promise<ProjectDocWrite> {
    const outcome = await this.deps.docWrites.requestExternal({ projectKey: ctx.projectKey, ...args });
    switch (outcome.state) {
      case 'published':
        return {
          write_id: outcome.id,
          state: 'published',
          commit: outcome.commit,
          paths: outcome.paths,
          ...(outcome.warning
            ? {
                warning:
                  'The default branch is up, but the local checkout could not follow it; tell the owner.',
              }
            : {}),
        };
      case 'queued':
        return { write_id: outcome.id, state: 'queued', waiting_for: outcome.waitingFor };
      case 'running':
        return { write_id: outcome.id, state: 'running' };
      case 'stale':
        throw conflict(
          'docs_stale',
          'a file changed since the commit you read. Read it again with read_project_doc and show the owner the new text.',
          { write_id: outcome.id },
        );
      case 'failed':
        // The raw message may carry git output: the reader gets the failure kind and reads the rest from the write.
        throw new DomainError('docs_write_failed', `the write failed: ${outcome.failure}`, {
          status: 422,
          details: { write_id: outcome.id, failure: outcome.failure },
        });
    }
  }

  async getProjectDocWrite(
    ctx: ExternalToolContext,
    args: { writeId: string },
  ): Promise<ExternalDocWriteState> {
    return this.deps.docWrites.externalState(ctx.projectKey, args.writeId);
  }

  async getRoleConfiguration(
    ctx: ExternalToolContext,
    args: Parameters<ExternalToolsHandler['getRoleConfiguration']>[1],
  ) {
    const loaded = await this.deps.projects.load(ctx.projectKey);
    return {
      version: loaded.version,
      role: args.role,
      override: loaded.config.team.roleOverrides?.[args.role] ?? null,
      effective: roleBundle(loaded.config, args.role),
    };
  }

  async requestStructuralReview(
    ctx: ExternalToolContext,
    args: Parameters<ExternalToolsHandler['requestStructuralReview']>[1],
  ) {
    const access = this.access(ctx);
    const sender = access.superActor?.handle ?? access.handle;
    // The start is the project's usual one, made as the Operator through the key: no session, so no start check of its own.
    return this.deps.structuralReviews.requestExternal(
      ctx.projectKey,
      args.signalId,
      args.note,
      async (member, text) => {
        const { message, recipients } = await this.deps.messaging.sendReporting(
          ctx.projectKey,
          sender,
          { to: [member], text, taskKey: null },
          { actor: ctx.actor, kind: 'action', awaitWake: true, workerCheck: true },
        );
        return { messageId: message.id, recipient: recipients[0]! };
      },
    );
  }

  async askHuman(ctx: ExternalToolContext, args: Parameters<ExternalToolsHandler['askHuman']>[1]) {
    const origin = externalToolOrigin(await this.deps.projects.config(ctx.projectKey));
    const asked = await this.deps.humanQuestions.ask(
      ctx.projectKey,
      { kind: 'external', origin },
      {
        ...args,
        ...(args.to ? { to: unique(args.to) } : {}),
        ...(args.attachmentIds ? { attachmentIds: unique(args.attachmentIds) } : {}),
      },
    );
    return {
      inboxItemId: asked.inboxItemId,
      ...(asked.approvalLabel ? { approvalLabel: asked.approvalLabel } : {}),
      ...(asked.attachments ? { attachments: asked.attachments } : {}),
      state: 'open' as const,
    };
  }

  async getSuperQuestion(ctx: ExternalToolContext, args: { itemId: string }): Promise<ExternalQuestionRead> {
    const owner = integratorOwnerId(await this.deps.projects.config(ctx.projectKey), 'read');
    if (!owner) throw forbidden('insufficient_access', 'the call has no key owner');
    return this.deps.humanQuestions.readExternal(ctx.projectKey, owner, args.itemId);
  }

  async withdrawQuestion(ctx: ExternalToolContext, args: { itemId: string; reason: string }) {
    const origin = externalToolOrigin(await this.deps.projects.config(ctx.projectKey));
    return this.deps.humanQuestions.withdrawExternal(ctx.projectKey, origin, args.itemId, args.reason);
  }

  /**
   * One chunk of a card's file, read from the stored stream: only the window asked for is held, never the file.
   * The key is checked again after the read, so a key revoked meanwhile gets nothing.
   */
  async readAttachment(
    ctx: ExternalToolContext,
    args: Parameters<ExternalToolsHandler['readAttachment']>[1],
  ): Promise<ExternalAttachmentRead> {
    const taskKey = this.taskKeyOf(ctx.projectKey, args.taskKey);
    const offset = args.offsetBytes ?? 0;
    const maxBytes = args.maxBytes ?? EXTERNAL_ATTACHMENT_DEFAULT_CHUNK_BYTES;
    const { attachment, stream } = await this.deps.attachments.open(
      ctx.projectKey,
      taskKey,
      args.attachmentId,
      ctx.actor,
    );
    try {
      const total = attachment.size;
      if (total > EXTERNAL_ATTACHMENT_MAX_FILE_BYTES)
        throw invalid(
          'invalid_request',
          `the file is larger than ${EXTERNAL_ATTACHMENT_MAX_FILE_BYTES} bytes`,
        );
      if (offset > total)
        throw invalid(
          'invalid_request',
          `offset_bytes ${offset} is past the end of the file (${total} bytes)`,
        );
      const expected = Math.min(maxBytes, total - offset);
      const data = await readWindow(stream, offset, expected);
      if (data.length !== expected)
        throw new Error(`attachment ${attachment.id} is shorter than its recorded size`);
      this.holder(ctx.principal);
      const end = offset + data.length;
      return {
        attachment,
        content: {
          encoding: 'base64',
          data: data.toString('base64'),
          offset_bytes: offset,
          byte_length: data.length,
          total_bytes: total,
          next_offset: end < total ? end : null,
        },
      };
    } finally {
      stream.destroy();
    }
  }
}

/** The bytes `offset` to `offset + length` of a stream, skipping what comes before without keeping it. */
async function readWindow(stream: Readable, offset: number, length: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let skipped = 0;
  let taken = 0;
  if (length === 0) return Buffer.alloc(0);
  for await (const piece of stream) {
    let chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
    if (skipped < offset) {
      const skip = Math.min(offset - skipped, chunk.length);
      skipped += skip;
      chunk = chunk.subarray(skip);
    }
    if (chunk.length === 0) continue;
    const take = Math.min(length - taken, chunk.length);
    parts.push(chunk.subarray(0, take));
    taken += take;
    if (taken >= length) break;
  }
  return Buffer.concat(parts);
}
