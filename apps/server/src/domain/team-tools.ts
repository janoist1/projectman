import {
  AttachmentId,
  effectiveRepo,
  isOpenTask,
  isTheme,
  MAX_ATTACHMENT_BYTES,
  memberOf,
  needsRepoChoice,
  questionChoices,
  TaskStatus as TaskStatusSchema,
  TaskKey,
} from '@projectman/shared';
import type {
  Attachment,
  InboxOption,
  MemberView,
  ProjectConfig,
  QuestionOptionInput,
  Task,
  TaskKind,
  Visibility,
  WorkItemRef,
  AddRelationRef,
  RelationsChange,
  SubmitBoundaryRequest,
  DecideBoundaryRequest,
} from '@projectman/shared';
import { TeamToolError } from '../contracts';
import type {
  AttachmentOperations,
  AttachmentPage,
  GithubService,
  ListTasksInput,
  LocatedAttachmentForTool,
  MemberMemoryStore,
  NetworkDenial,
  TaskSummary,
  TaskToolDetail,
  TeamToolsHandler,
  ToolContext,
} from '../contracts';
import { openWorkspaceFile, WorkspaceFileRefusal } from './attachments';
import type { DomainContext } from './context';
import type { BoundaryService } from './boundary';
import type { EgressService } from './egress';
import { DomainError } from './errors';
import type { ApprovalRequirement, UnmetCondition } from '@projectman/shared';
import type { GithubSync } from './github-sync';
import { ANSWER_OPTION, sponsorOrOwners } from './inbox';
import type { InboxService } from './inbox';
import type { MemberService } from './members';
import type { Messaging } from './messaging';
import type { OpenQuestionLabel } from './open-question-label';
import type { ProjectService } from './projects';
import type { PublishingGate } from './publishing';
import type { TaskService } from './tasks';
import { attachmentToolRules } from './session-policy';
import type { TimelineService } from './timeline';
import { aiActor, unique } from './util';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
/** Attachments get_task shows; the rest are paged with list_attachments. */
const ATTACHMENTS_IN_TASK = 20;
const MAX_ATTACHMENT_PAGE = 200;

/** Explains a blocked stage move to the agent in plain English. */
function describeGateBlock(err: DomainError): string {
  const details = (err.details ?? {}) as { unmet?: UnmetCondition[]; approvals?: ApprovalRequirement[] };
  const reasons = (details.unmet ?? []).map((u) =>
    u.condition.type === 'has_label'
      ? `the label "${u.condition.label}" is missing (required to enter stage "${u.stageId}")`
      : `the label "${u.condition.label}" is on the task and holds it back (stage "${u.stageId}")`,
  );
  if (reasons.length === 0 && details.approvals?.length) {
    reasons.push(
      ...details.approvals.map(
        (a) =>
          `stage "${a.stageId}" needs a human approval (label "${a.label}", from ${a.approvers.join(' or ')})`,
      ),
    );
  }
  return reasons.length > 0
    ? `The stage move is blocked: ${reasons.join('; ')}. Nothing from this call was recorded; ` +
        'send the labels and the note again, without stage_id or once the gate is met.'
    : err.message;
}

/** The send_message refusals of the messaging module, in the words the agent reads. */
function toMessageToolError(err: unknown): unknown {
  if (!(err instanceof DomainError)) return err;
  const details = (err.details ?? {}) as { field?: string; what?: string; ids?: string[] };
  if (err.code === 'invalid_request' && details.field === 'text')
    return new TeamToolError('invalid', 'The message text is empty.');
  if (err.code === 'invalid_request' && details.field === 'to')
    return new TeamToolError('invalid', 'No recipients: name at least one team member other than yourself.');
  if (err.code === 'not_found' && details.what === 'member' && details.ids)
    return new TeamToolError(
      'not_found',
      `Unknown team members: ${details.ids.join(', ')}. Use list_members to see the handles.`,
    );
  return err;
}

/** An attachment that is not (or no longer) there, in words that say where to look. */
function toAttachmentToolError(err: unknown, taskKey: string, id: string): unknown {
  if (
    err instanceof DomainError &&
    err.code === 'not_found' &&
    (err.details as { what?: string })?.what === 'attachment'
  )
    return new TeamToolError(
      'not_found',
      `${taskKey} has no attachment ${id} (or it is being deleted); list them with list_attachments.`,
    );
  return err;
}

/** attach_file refusals: the file's own (path, kind, size, change), and the size limit hit while reading. */
function toFileToolError(err: unknown, requested: string): unknown {
  if (err instanceof WorkspaceFileRefusal)
    return new TeamToolError(
      err.reason === 'outside' ? 'forbidden' : 'invalid',
      `${err.message} Nothing was attached.`,
    );
  if (err instanceof DomainError && err.code === 'attachment_too_large')
    return new TeamToolError(
      'invalid',
      `${requested} grew past ${MAX_ATTACHMENT_BYTES} bytes while it was read; nothing was attached.`,
    );
  return err;
}

function toToolError(err: unknown): unknown {
  if (err instanceof TeamToolError || !(err instanceof DomainError)) return err;
  if (err.code === 'not_found') return new TeamToolError('not_found', err.message);
  if (err.status === 403) return new TeamToolError('forbidden', err.message);
  if (err.code === 'gate_blocked' || err.code === 'approval_requested') {
    return new TeamToolError('gate_blocked', describeGateBlock(err));
  }
  return new TeamToolError('invalid', err.message);
}

/**
 * The team tools behind the MCP server (mcp__team__*): they check the arguments, call the
 * domain services and put their refusals in words the agent reads. Every action is attributed
 * to the calling AI member.
 */
export class TeamToolsService implements TeamToolsHandler {
  async submitBoundaryRequest(ctx: ToolContext, args: SubmitBoundaryRequest) {
    try {
      await this.caller(ctx);
      return await this.boundary.submit(
        { projectKey: ctx.projectKey, member: ctx.member, sessionId: ctx.sessionId, taskKey: ctx.taskKey },
        args,
      );
    } catch (err) {
      throw toToolError(err);
    }
  }
  async getBoundaryRequest(ctx: ToolContext, args: { requestId: string }) {
    try {
      await this.caller(ctx);
      return await this.boundary.read(ctx.projectKey, args.requestId, ctx.member);
    } catch (err) {
      throw toToolError(err);
    }
  }
  async decideBoundaryRequest(ctx: ToolContext, args: DecideBoundaryRequest & { requestId: string }) {
    try {
      await this.caller(ctx);
      return await this.boundary.decide(
        ctx.projectKey,
        args.requestId,
        ctx.member,
        { decision: args.decision, reason: args.reason },
        { delegatedOnly: true },
      );
    } catch (err) {
      throw toToolError(err);
    }
  }
  async decidePermissionRequest(
    ctx: ToolContext,
    args: { requestId: string; decision: 'allow' | 'deny' | 'escalate'; reason: string },
  ) {
    try {
      await this.caller(ctx);
      const item = await this.inbox.resolveDelegated(ctx.projectKey, args.requestId, ctx.member, {
        decision: args.decision,
        reason: args.reason,
      });
      return {
        requestId: item.id,
        decision: args.decision,
        outcome: args.decision === 'escalate' ? 'handed to a person' : 'decided; the request is answered',
      };
    } catch (err) {
      throw toToolError(err);
    }
  }
  async listNetworkDenials(ctx: ToolContext): Promise<NetworkDenial[]> {
    try {
      await this.caller(ctx);
      return (this.egress?.recentDenials(ctx) ?? []).map((operation) => ({
        operationId: operation.id,
        destination: `${operation.host}:${operation.port}`,
        refusedAt: operation.createdAt,
        expiresAt: operation.expiresAt,
      }));
    } catch (err) {
      throw toToolError(err);
    }
  }
  async publishTaskBranch(
    ctx: ToolContext,
    args: { taskKey?: string; commit: string; title?: string; body?: string },
  ) {
    return this.publishing.publish(ctx, args);
  }
  async getRemoteState(ctx: ToolContext, args: { taskKey: string }) {
    return this.publishing.remoteState(ctx, { taskKey: this.validTaskKey(ctx, args.taskKey) });
  }
  private readonly boundary: BoundaryService;
  private readonly egress: EgressService | null;
  private readonly publishing: PublishingGate;
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly members: MemberService;
  private readonly messaging: Messaging;
  private readonly inbox: InboxService;
  private readonly openQuestionLabel: OpenQuestionLabel;
  private readonly timeline: TimelineService;
  private readonly memory: MemberMemoryStore;
  private readonly github: GithubService;
  private readonly githubSync: GithubSync;
  private readonly attachments: AttachmentOperations;
  private readonly attachmentDirectory: (projectKey: string, taskKey: string) => Promise<string>;

  constructor(deps: {
    boundary: BoundaryService;
    /** The network gate (its refused destinations); absent in older test setups. */
    egress?: EgressService;
    publishing: PublishingGate;
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    members: MemberService;
    messaging: Messaging;
    inbox: InboxService;
    openQuestionLabel: OpenQuestionLabel;
    timeline: TimelineService;
    memory: MemberMemoryStore;
    github: GithubService;
    githubSync: GithubSync;
    attachments: AttachmentOperations;
    /** The attachment directory of a task (`AttachmentStorage.taskDirectory`). */
    attachmentDirectory: (projectKey: string, taskKey: string) => Promise<string>;
  }) {
    this.boundary = deps.boundary;
    this.egress = deps.egress ?? null;
    this.publishing = deps.publishing;
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.members = deps.members;
    this.messaging = deps.messaging;
    this.inbox = deps.inbox;
    this.openQuestionLabel = deps.openQuestionLabel;
    this.timeline = deps.timeline;
    this.memory = deps.memory;
    this.github = deps.github;
    this.githubSync = deps.githubSync;
    this.attachments = deps.attachments;
    this.attachmentDirectory = deps.attachmentDirectory;
  }

  async sendMessage(
    ctx: ToolContext,
    args: { to: string[]; text: string; taskKey?: string },
  ): Promise<{
    messageId: string;
    deliveredTo: string[];
    routed?: { handle: string; workItem: WorkItemRef }[];
  }> {
    return this.guard(async () => {
      await this.caller(ctx);
      const taskKey = this.taskKeyFor(ctx, args.taskKey);
      // Humans have it in their messages now; AI recipients get it typed into their session
      // for the work item as soon as that session is idle (queued, never awaited here).
      const message = await this.messaging
        .send(
          ctx.projectKey,
          ctx.member,
          { to: args.to, text: args.text, taskKey },
          { actor: aiActor(ctx.member), sessionId: ctx.sessionId },
        )
        .catch((err: unknown) => {
          throw toMessageToolError(err);
        });
      const routed = (message.receipts ?? []).flatMap((r) =>
        r.route ? [{ handle: r.handle, workItem: r.route }] : [],
      );
      return { messageId: message.id, deliveredTo: message.to, ...(routed.length > 0 ? { routed } : {}) };
    });
  }

  async listMembers(ctx: ToolContext): Promise<MemberView[]> {
    return this.guard(async () => this.members.rosterFor(await this.caller(ctx)));
  }

  async listTasks(ctx: ToolContext, args: ListTasksInput): Promise<TaskSummary[]> {
    return this.guard(async () => {
      await this.caller(ctx);
      const status = args.status ?? 'open';
      const limit = args.limit ?? 50;
      if (status !== 'open' && !TaskStatusSchema.safeParse(status).success) {
        throw new TeamToolError('invalid', 'Invalid task status.');
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new TeamToolError('invalid', 'limit must be an integer between 1 and 200.');
      }
      const assignee = args.assignee === 'me' ? ctx.member : args.assignee;
      return this.tasks
        .list(ctx.projectKey)
        .filter(
          (task) =>
            (status === 'open' ? isOpenTask(task) : task.status === status) &&
            // A theme is in no stage (it carries the first one's id because the field is required).
            (args.stage === undefined || (!isTheme(task) && task.stageId === args.stage)) &&
            (assignee === undefined || task.assignee === assignee),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key))
        .slice(0, limit)
        .map(({ key, title, stageId, status, assignee, labels, updatedAt, kind }) => ({
          key,
          title,
          stageId,
          status,
          assignee,
          labels,
          updatedAt,
          ...(kind === 'theme' ? { kind } : {}),
        }));
    });
  }

  async getTask(ctx: ToolContext, args: { taskKey: string; eventId?: string }): Promise<TaskToolDetail> {
    return this.guard(async () => {
      const config = await this.caller(ctx);
      const taskKey = this.validTaskKey(ctx, args.taskKey);
      const detail = this.tasks.detail(ctx.projectKey, taskKey, 50);
      if (args.eventId !== undefined) {
        const event = this.timeline.get(ctx.projectKey, args.eventId);
        if (!event || event.taskKey !== taskKey)
          throw new TeamToolError('not_found', `${taskKey} has no timeline event ${args.eventId}.`);
        return { ...detail, event };
      }
      const attachments = await this.attachments.list(ctx.projectKey, taskKey, aiActor(ctx.member));
      // A card shows its theme (its own, or its parent's); a theme shows its cards and how far it is (PM-192).
      const themeCard = detail.task.themeKey ? this.tasks.find(ctx.projectKey, detail.task.themeKey) : null;
      const theme = isTheme(detail.task) ? this.tasks.themeOf(ctx.projectKey, taskKey) : null;
      return {
        ...detail,
        effectiveRepo: effectiveRepo(config, detail.task),
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
        attachments: {
          attachments: attachments.slice(0, ATTACHMENTS_IN_TASK),
          total: attachments.length,
          offset: 0,
        },
        // The timeline shows excerpts: a message that is on its way says so (PM-180).
        undeliveredMessageIds: this.ctx.repos.messages.pending(ctx.projectKey, ctx.member).map((m) => m.id),
      };
    });
  }

  async listAttachments(
    ctx: ToolContext,
    args: { taskKey: string; offset?: number; limit?: number },
  ): Promise<AttachmentPage> {
    return this.guard(async () => {
      await this.caller(ctx);
      const taskKey = this.validTaskKey(ctx, args.taskKey);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      if (!Number.isInteger(offset) || offset < 0)
        throw new TeamToolError('invalid', 'offset must be a whole number, 0 or more.');
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ATTACHMENT_PAGE)
        throw new TeamToolError('invalid', `limit must be an integer between 1 and ${MAX_ATTACHMENT_PAGE}.`);
      const all = await this.attachments.list(ctx.projectKey, taskKey, aiActor(ctx.member));
      return { attachments: all.slice(offset, offset + limit), total: all.length, offset };
    });
  }

  async readAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<LocatedAttachmentForTool> {
    return this.guard(async () => {
      await this.caller(ctx);
      const taskKey = this.validTaskKey(ctx, args.taskKey);
      const id = this.validAttachmentId(args.attachmentId);
      const located = await this.attachments
        .locate(ctx.projectKey, taskKey, id, aiActor(ctx.member))
        .catch((err: unknown) => {
          throw toAttachmentToolError(err, taskKey, id);
        });
      // The session reads without asking only its own task's attachment directory and its direct
      // parent's (PM-228; see `attachmentToolRules`).
      const sessionTask = ctx.taskKey ? this.tasks.find(ctx.projectKey, ctx.taskKey) : null;
      const own =
        (ctx.taskKey === taskKey || (sessionTask?.parentKey ?? null) === taskKey) &&
        attachmentToolRules(await this.attachmentDirectory(ctx.projectKey, taskKey).catch(() => null)).allow
          .length > 0;
      return { ...located, readableWithoutAsking: own };
    });
  }

  async attachFile(
    ctx: ToolContext,
    args: { taskKey: string; path: string },
  ): Promise<{ attachment: Attachment }> {
    return this.guard(async () => {
      await this.caller(ctx);
      const taskKey = this.validTaskKey(ctx, args.taskKey);
      const actor = aiActor(ctx.member);
      await this.attachments.assertCanUpload(ctx.projectKey, taskKey, actor);
      // The directory is the one the server started the session in; the caller never names it.
      const cwd = this.sessionDirectory(ctx);
      const file = await openWorkspaceFile(cwd, args.path, { maxBytes: MAX_ATTACHMENT_BYTES }).catch(
        (err: unknown) => {
          throw toFileToolError(err, args.path);
        },
      );
      try {
        const attachment = await this.attachments.upload({
          projectKey: ctx.projectKey,
          taskKey,
          actor,
          fileName: file.name,
          content: file.stream(),
          beforeCommit: () => file.verifyUnchanged(),
        });
        return { attachment };
      } catch (err) {
        throw toFileToolError(err, args.path);
      } finally {
        await file.close();
      }
    });
  }

  async deleteAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<{ attachmentId: string; fileName: string | null }> {
    return this.guard(async () => {
      await this.caller(ctx);
      const taskKey = this.validTaskKey(ctx, args.taskKey);
      const id = this.validAttachmentId(args.attachmentId);
      const actor = aiActor(ctx.member);
      const fileName =
        (await this.attachments.list(ctx.projectKey, taskKey, actor)).find((a) => a.id === id)?.fileName ??
        null;
      // The same rule as the REST route: the uploader, or a human owner or admin.
      await this.attachments.delete(ctx.projectKey, taskKey, id, actor).catch((err: unknown) => {
        if (err instanceof DomainError && err.status === 403)
          throw new TeamToolError(
            'forbidden',
            `You can delete only the attachments you attached yourself; ${id} is someone else's. Ask an ` +
              'owner or admin if it has to go.',
          );
        throw toAttachmentToolError(err, taskKey, id);
      });
      return { attachmentId: id, fileName };
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
    },
  ): Promise<{ task: Task }> {
    return this.guard(async () => {
      const config = await this.caller(ctx);
      const taskKey = this.validTaskKey(ctx, args.taskKey);
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
            addLabels: args.addLabels,
            removeLabels: args.removeLabels,
            note: args.note,
            stageId: args.stageId,
          },
          aiActor(ctx.member),
          { sessionId: ctx.sessionId },
        );
        return { task };
      } catch (err) {
        if (err instanceof DomainError && err.code === 'approval_requested') {
          const { approvers } = err.details as { approvers: string[] };
          throw new TeamToolError(
            'gate_blocked',
            `Moving ${taskKey} to ${args.stageId} needs a human approval. It was requested from ` +
              `${approvers.join(', ')}; the task moves automatically once they approve. The rest of this ` +
              'call was recorded.',
          );
        }
        throw err;
      }
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
    },
  ): Promise<{ task: Task }> {
    return this.guard(async () => {
      await this.caller(ctx);
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
        },
        aiActor(ctx.member),
        { sessionId: ctx.sessionId },
      );
      return { task };
    });
  }

  async linkPullRequest(
    ctx: ToolContext,
    args: { taskKey: string; repo: string; number: number },
  ): Promise<{ task: Task }> {
    return this.guard(async () => {
      await this.caller(ctx);
      const taskKey = this.validTaskKey(ctx, args.taskKey);
      if (!REPO_RE.test(args.repo))
        throw new TeamToolError('invalid', 'repo must look like "owner/name" (the GitHub repository).');
      if (!Number.isInteger(args.number) || args.number <= 0)
        throw new TeamToolError('invalid', 'number must be the positive number of the pull request.');
      let title: string | undefined;
      let state: string | undefined;
      try {
        const pr = await this.github.getPullRequest(args.repo, args.number);
        this.tasks.recordPullRequest(pr);
        title = pr.title;
        state = pr.state;
      } catch (err) {
        this.ctx.logger.warn(
          { err, repo: args.repo, number: args.number },
          'could not fetch the pull request',
        );
      }
      const task = this.tasks.addLink(
        ctx.projectKey,
        taskKey,
        { kind: 'pull_request', ref: String(args.number), repo: args.repo, title, state },
        aiActor(ctx.member),
        ctx.sessionId,
      );
      if (state !== 'merged' && state !== 'closed') this.githubSync.watch(args.repo, args.number);
      return { task };
    });
  }

  async askHuman(
    ctx: ToolContext,
    args: {
      question: string;
      options?: QuestionOptionInput[];
      taskKey?: string;
      to?: string[];
      recommended?: string;
      recommendationReason?: string;
      details?: string;
    },
  ): Promise<{ inboxItemId: string }> {
    return this.guard(async () => {
      const config = await this.caller(ctx);
      const question = args.question.trim();
      if (!question) throw new TeamToolError('invalid', 'The question is empty.');
      const taskKey = this.taskKeyFor(ctx, args.taskKey);
      let assignees: string[];
      if (args.to && args.to.length > 0) {
        const notHuman = args.to.filter((h) => memberOf(config, h)?.kind !== 'human');
        if (notHuman.length > 0)
          throw new TeamToolError(
            'invalid',
            `ask_human can only ask human members; these are not: ${notHuman.join(', ')}.`,
          );
        assignees = unique(args.to);
      } else {
        assignees = sponsorOrOwners(config, ctx.member);
      }
      const choices = questionChoices(args.options);
      const recommended = args.recommended?.trim();
      const reason = args.recommendationReason?.trim();
      const details = args.details?.trim();
      // The team tool checks this at its boundary; a direct caller gets the same answer.
      const recommendedIndex = recommended ? choices.findIndex((choice) => choice.label === recommended) : -1;
      if (recommended && recommendedIndex < 0) {
        throw new TeamToolError(
          'invalid',
          `The recommended option "${recommended}" is not one of the options.`,
        );
      }
      if (reason && !recommended) {
        throw new TeamToolError('invalid', 'A recommendation reason needs a recommended option.');
      }
      // The recommended option is the primary button; without a recommendation the first one is.
      const primary = Math.max(recommendedIndex, 0);
      const options: InboxOption[] = [
        ...choices.map((choice, i): InboxOption => ({
          id: `option_${i + 1}`,
          label: choice.label,
          style: i === primary ? 'primary' : 'secondary',
          ...(choice.consequence ? { consequence: choice.consequence } : {}),
        })),
        ANSWER_OPTION,
      ];
      // A question about a card holds it back while it is open: the label goes on first, so the
      // question records that the system put it there.
      const autoLabel = await this.openQuestionLabel.claim(ctx.projectKey, taskKey, ctx.member, question);
      const item = this.inbox.create({
        projectKey: ctx.projectKey,
        kind: 'question',
        assignees,
        source: ctx.member,
        sessionId: ctx.sessionId,
        taskKey,
        title: question,
        payload: {
          question,
          options: choices.map((choice) => choice.label),
          ...(recommendedIndex >= 0 ? { recommended: options[recommendedIndex]!.id } : {}),
          ...(reason ? { recommendationReason: reason } : {}),
          ...(details ? { details } : {}),
          ...(autoLabel ? { autoLabel } : {}),
        },
        options,
      });
      this.timeline.append({
        projectKey: ctx.projectKey,
        taskKey,
        sessionId: ctx.sessionId,
        actor: aiActor(ctx.member),
        type: 'question_asked',
        data: { inboxItemId: item.id, question },
      });
      return { inboxItemId: item.id };
    });
  }

  async saveMemory(ctx: ToolContext, args: { note: string }): Promise<{ ok: true }> {
    return this.guard(async () => {
      await this.caller(ctx);
      const note = args.note.trim();
      if (!note) throw new TeamToolError('invalid', 'The memory note is empty.');
      await this.memory.append(ctx.projectKey, ctx.member, note);
      return { ok: true as const };
    });
  }

  /** The caller must still be an AI member of the project. */
  private async caller(ctx: ToolContext): Promise<ProjectConfig> {
    const config = await this.projects.config(ctx.projectKey);
    const member = memberOf(config, ctx.member);
    if (member?.kind !== 'ai')
      throw new TeamToolError(
        'forbidden',
        `${ctx.member} is not an active AI member of this team, so the team tools are not available.`,
      );
    return config;
  }

  /** A task key of the caller's project. */
  private validTaskKey(ctx: ToolContext, taskKey: string): string {
    if (!TaskKey.safeParse(taskKey).success)
      throw new TeamToolError(
        'invalid',
        `Invalid task key "${taskKey}"; task keys look like "${ctx.projectKey}-12".`,
      );
    if (!this.tasks.find(ctx.projectKey, taskKey))
      throw new TeamToolError('not_found', `Task ${taskKey} does not exist in this project.`);
    return taskKey;
  }

  private validAttachmentId(id: string): string {
    if (!AttachmentId.safeParse(id).success)
      throw new TeamToolError(
        'invalid',
        `Invalid attachment id "${id}"; attachment ids look like "att_…" (see get_task or list_attachments).`,
      );
    return id;
  }

  /**
   * The working directory of the calling session, as the server recorded it when it started the
   * session. The token names the session; it must still be this member's session in this project.
   */
  private sessionDirectory(ctx: ToolContext): string {
    const session = this.ctx.repos.sessions.get(ctx.sessionId);
    if (!session || session.projectKey !== ctx.projectKey || session.member !== ctx.member)
      throw new TeamToolError(
        'forbidden',
        'Your session is not known to the server, so no file can be attached.',
      );
    return session.cwd;
  }

  /** The explicit task key, else the session's task, else null. */
  private taskKeyFor(ctx: ToolContext, taskKey: string | undefined): string | null {
    const key = taskKey ?? ctx.taskKey;
    return key ? this.validTaskKey(ctx, key) : null;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toToolError(err);
    }
  }
}
