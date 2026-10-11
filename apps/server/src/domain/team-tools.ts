import path from 'node:path';
import {
  AttachmentId,
  effectiveRepo,
  ERROR_CODES,
  ownerHandles,
  isOpenTask,
  isOperator,
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
  ErrorCode,
  InboxOption,
  MemberView,
  OperatorAction,
  OperatorStepStatus,
  ProjectConfig,
  QuestionOptionInput,
  Session,
  Task,
  TaskKind,
  TaskPriority,
  Visibility,
  WorkDoing,
  WorkItemRef,
  AddRelationRef,
  DeveloperLevelRequest,
  RelationsChange,
  SubmitBoundaryRequest,
  DecideBoundaryRequest,
} from '@projectman/shared';
import { taskWaitShort } from '../agent-text';
import { TeamToolError, WorkspaceFileRefusal } from '../contracts';
import type {
  AttachmentOperations,
  AttachmentPage,
  EngineAttachments,
  EngineHost,
  GithubService,
  ListTasksInput,
  LocatedAttachmentForTool,
  MemberMemoryStore,
  NetworkDenial,
  ScreenshotRun,
  SentMessageRecipient,
  TakeScreenshotsInput,
  TaskSummary,
  TaskToolDetail,
  TeamToolsHandler,
  ToolContext,
} from '../contracts';
import { isWithin } from './command-paths';
import type { DomainContext } from './context';
import type { BoundaryService } from './boundary';
import { QUESTION_LIMIT } from './card-questions';
import type { CardQuestions } from './card-questions';
import type { EgressService } from './egress';
import { DomainError } from './errors';
import type { ApprovalRequirement, UnmetCondition } from '@projectman/shared';
import type { FixLimitDecision, FixLimitWatch } from './fix-limit';
import type { HandoffService } from './handoffs';
import type { GithubSync } from './github-sync';
import { ANSWER_OPTION, sponsorOrOwners } from './inbox';
import type { InboxService } from './inbox';
import type { MemberService } from './members';
import type { Messaging } from './messaging';
import type { OpenQuestionLabel } from './open-question-label';
import { OPERATOR_NEVER_TOOLS, OPERATOR_READ_TOOLS } from './operator-requests';
import type { OperatorRequests, OperatorSteps } from './operator-requests';
import type { OperatorActions } from './operator-actions';
import type { OperatorSignals } from './operator-signals';
import type { TaskStarts } from './admission';
import type { OperatorOperation } from '@projectman/shared';
import type { ProjectFocusService } from './project-focus';
import type { ProjectService } from './projects';
import type { ScreenshotRuns } from './screenshot-runs';
import type { SessionOrchestrator } from './sessions';
import type { PublishingGate } from './publishing';
import type { TaskService, TaskWaits } from './tasks';
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
  const reasons = (details.unmet ?? []).map((u) => {
    if (u.condition.type !== 'has_label')
      return `the label "${u.condition.label}" is on the task and holds it back (stage "${u.stageId}")`;
    const setters = u.setters?.length ? `; only ${u.setters.join(' or ')} may set it` : '';
    return `the label "${u.condition.label}" is missing (required to enter stage "${u.stageId}"${setters})`;
  });
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

/** A refused call as the step log keeps it: the named error code, or the nearest one of the tool error. */
function refusalOf(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof DomainError) return { code: err.code, message: err.message };
  if (err instanceof TeamToolError) {
    const named = /^([a-z_]+):/.exec(err.message)?.[1];
    if (named && (ERROR_CODES as readonly string[]).includes(named))
      return { code: named as ErrorCode, message: err.message };
    const byTool = {
      not_found: 'not_found',
      forbidden: 'unauthorized',
      invalid: 'invalid_request',
      gate_blocked: 'gate_blocked',
    } as const;
    return { code: byTool[err.code], message: err.message };
  }
  return { code: 'internal_error', message: err instanceof Error ? err.message : String(err) };
}

/** The owners of the project: the people the Operator may report and ask. */
function isOwner(config: ProjectConfig, handle: string): boolean {
  return ownerHandles(config).includes(handle);
}

function toToolError(err: unknown): unknown {
  if (err instanceof TeamToolError || !(err instanceof DomainError)) return err;
  if (err.code === 'operator_signal_closed')
    return new TeamToolError('invalid', `${err.code}: ${err.message}`);
  if (err.code === 'not_found') return new TeamToolError('not_found', err.message);
  if (err.status === 403) return new TeamToolError('forbidden', err.message);
  if (err.code === 'gate_blocked' || err.code === 'approval_requested') {
    return new TeamToolError('gate_blocked', describeGateBlock(err));
  }
  return new TeamToolError('invalid', err.message);
}

/** A tool's caller and, for the Operator, the owner request the call runs for (null for any other caller). */
interface CallerWithRequest {
  config: ProjectConfig;
  request: ReturnType<OperatorRequests['openFor']>;
}

/**
 * The team tools behind the MCP server (mcp__team__*): they check the arguments, call the
 * domain services and put their refusals in words the agent reads. Every action is attributed
 * to the calling AI member.
 */
export class TeamToolsService implements TeamToolsHandler {
  async submitBoundaryRequest(ctx: ToolContext, args: SubmitBoundaryRequest) {
    try {
      await this.caller(ctx, 'submit_boundary_request');
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
      await this.caller(ctx, 'get_boundary_request');
      return await this.boundary.read(ctx.projectKey, args.requestId, ctx.member);
    } catch (err) {
      throw toToolError(err);
    }
  }
  async decideBoundaryRequest(ctx: ToolContext, args: DecideBoundaryRequest & { requestId: string }) {
    try {
      await this.caller(ctx, 'decide_boundary_request');
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
      await this.caller(ctx, 'decide_permission_request');
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
      if (err instanceof DomainError && err.code === 'inbox_item_closed') {
        const state = (err.details as { state?: string }).state;
        throw new TeamToolError(
          'invalid',
          state === 'expired'
            ? 'inbox_item_closed: expired — nothing reached the session'
            : 'inbox_item_closed: already decided',
        );
      }
      throw toToolError(err);
    }
  }
  async decideFixLimit(
    ctx: ToolContext,
    args: { taskKey: string; decision: FixLimitDecision; reason: string },
  ) {
    try {
      await this.caller(ctx, 'decide_fix_limit');
      return await this.fixLimit.decide(ctx.member, ctx.projectKey, args.taskKey, args.decision, args.reason);
    } catch (err) {
      throw toToolError(err);
    }
  }
  async handOff(ctx: ToolContext, args: { taskKey: string; note: string }): Promise<{ recorded: true }> {
    try {
      await this.caller(ctx, 'hand_off');
      await this.handoffs.recordNote(ctx, this.validTaskKey(ctx, args.taskKey), args.note);
      return { recorded: true };
    } catch (err) {
      throw toToolError(err);
    }
  }
  async listNetworkDenials(ctx: ToolContext): Promise<NetworkDenial[]> {
    try {
      await this.caller(ctx, 'list_network_denials');
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
    try {
      await this.caller(ctx, 'publish_task_branch');
    } catch (err) {
      throw toToolError(err);
    }
    return this.publishing.publish(ctx, args);
  }
  async getRemoteState(ctx: ToolContext, args: { taskKey: string }) {
    return this.publishing.remoteState(ctx, { taskKey: this.validTaskKey(ctx, args.taskKey) });
  }
  private readonly operatorRequests: Pick<OperatorRequests, 'openFor'>;
  private readonly operatorSteps: Pick<OperatorSteps, 'record'>;
  private readonly operatorActions: OperatorActions;
  private readonly operatorSignals: OperatorSignals;
  private readonly taskStarts: TaskStarts;
  private readonly boundary: BoundaryService;
  private readonly egress: EgressService | null;
  private readonly publishing: PublishingGate;
  private readonly ctx: DomainContext;
  private readonly sessions: Pick<SessionOrchestrator, 'setDoing' | 'cardWorkers' | 'cardWorkersFor'>;
  private readonly cardQuestions: Pick<CardQuestions, 'list'>;
  private readonly projects: ProjectService;
  private readonly projectFocus: Pick<ProjectFocusService, 'places'>;
  private readonly merges: import('./merges').Merges;
  private readonly tasks: TaskService;
  private readonly taskWaits: Pick<TaskWaits, 'of' | 'ofCard'>;
  private readonly members: MemberService;
  private readonly messaging: Messaging;
  private readonly inbox: InboxService;
  private readonly openQuestionLabel: OpenQuestionLabel;
  private readonly fixLimit: Pick<FixLimitWatch, 'decide'>;
  private readonly handoffs: Pick<HandoffService, 'recordNote'>;
  private readonly timeline: TimelineService;
  private readonly memory: MemberMemoryStore;
  private readonly github: GithubService;
  private readonly githubSync: GithubSync;
  private readonly attachments: AttachmentOperations;
  private readonly attachmentDirectory: (projectKey: string, taskKey: string) => Promise<string>;
  private readonly materializeAttachment: EngineAttachments['materialize'] | undefined;
  private readonly sessionEngine:
    | ((
        sessionId: string,
      ) => Pick<EngineHost, 'sessionFolders' | 'isRealDirectory' | 'openWorkspaceFile'> | undefined)
    | undefined;
  private readonly screenshots: Pick<ScreenshotRuns, 'take' | 'get'> | undefined;

  constructor(deps: {
    boundary: BoundaryService;
    /** The network gate (its refused destinations); absent in older test setups. */
    egress?: EgressService;
    publishing: PublishingGate;
    ctx: DomainContext;
    /** The session service: set_current_work records the sentence on the caller's session. */
    sessions: Pick<SessionOrchestrator, 'setDoing' | 'cardWorkers' | 'cardWorkersFor'>;
    /** The questions asked on a card, which get_task lists (PM-249). */
    cardQuestions: Pick<CardQuestions, 'list'>;
    projects: ProjectService;
    merges: import('./merges').Merges;
    tasks: TaskService;
    /** Why cards stand still (PM-460): get_task and list_tasks say it. */
    taskWaits: Pick<TaskWaits, 'of' | 'ofCard'>;
    /** The project's focus (PM-437): list_tasks and get_task show a card's place in it. */
    projectFocus: Pick<ProjectFocusService, 'places'>;
    members: MemberService;
    messaging: Messaging;
    inbox: InboxService;
    openQuestionLabel: OpenQuestionLabel;
    /** The fix round limit (PM-262): `decide_fix_limit` goes to it. */
    fixLimit: Pick<FixLimitWatch, 'decide'>;
    /** The assignee handoff (PM-342): `hand_off` records its note. */
    handoffs: Pick<HandoffService, 'recordNote'>;
    timeline: TimelineService;
    memory: MemberMemoryStore;
    github: GithubService;
    githubSync: GithubSync;
    attachments: AttachmentOperations;
    /** The attachment directory of a task (`AttachmentStorage.taskDirectory`). */
    attachmentDirectory: (projectKey: string, taskKey: string) => Promise<string>;
    /**
     * Gives an attachment to the engine the session runs on (PM-315, cloud mode) and names its path
     * there; absent, the path is the stored file's own (the session runs on this machine).
     */
    materializeAttachment?: EngineAttachments['materialize'];
    /**
     * The engine a session runs on (PM-312): `attach_file` opens the file on its disk, from the working
     * directory or from the caller's own session folder (PM-268).
     */
    sessionEngine?: (
      sessionId: string,
    ) => Pick<EngineHost, 'sessionFolders' | 'isRealDirectory' | 'openWorkspaceFile'> | undefined;
    /** The server's screenshot runs (PM-351); absent, `take_screenshots` is refused. */
    screenshots?: Pick<ScreenshotRuns, 'take' | 'get'>;
    /** The owner's requests to the Operator (PM-463): its writes need an open one. */
    operatorRequests: Pick<OperatorRequests, 'openFor'>;
    /** The Operator's step log (PM-463). */
    operatorSteps: Pick<OperatorSteps, 'record'>;
    operatorActions: OperatorActions;
    operatorSignals: OperatorSignals;
    taskStarts: TaskStarts;
  }) {
    this.operatorRequests = deps.operatorRequests;
    this.operatorSteps = deps.operatorSteps;
    this.operatorActions = deps.operatorActions;
    this.operatorSignals = deps.operatorSignals;
    this.taskStarts = deps.taskStarts;
    this.screenshots = deps.screenshots;
    this.sessionEngine = deps.sessionEngine;
    this.boundary = deps.boundary;
    this.egress = deps.egress ?? null;
    this.publishing = deps.publishing;
    this.ctx = deps.ctx;
    this.sessions = deps.sessions;
    this.cardQuestions = deps.cardQuestions;
    this.projects = deps.projects;
    this.merges = deps.merges;
    this.tasks = deps.tasks;
    this.taskWaits = deps.taskWaits;
    this.projectFocus = deps.projectFocus;
    this.members = deps.members;
    this.messaging = deps.messaging;
    this.inbox = deps.inbox;
    this.openQuestionLabel = deps.openQuestionLabel;
    this.fixLimit = deps.fixLimit;
    this.handoffs = deps.handoffs;
    this.timeline = deps.timeline;
    this.memory = deps.memory;
    this.github = deps.github;
    this.githubSync = deps.githubSync;
    this.attachments = deps.attachments;
    this.attachmentDirectory = deps.attachmentDirectory;
    this.materializeAttachment = deps.materializeAttachment;
  }

  async sendMessage(
    ctx: ToolContext,
    args: {
      to: string[];
      text: string;
      taskKey?: string;
      kind: 'action' | 'info';
      signalId?: string;
      signalActionable?: boolean;
    },
  ): Promise<{
    messageId: string;
    deliveredTo: string[];
    recipients: SentMessageRecipient[];
    routed?: { handle: string; workItem: WorkItemRef }[];
  }> {
    return this.guard(async () => {
      const signal = args.signalId !== undefined || args.signalActionable !== undefined;
      const who = await this.callerWithRequest(
        ctx,
        'send_message',
        signal ? { id: args.signalId, to: args.to } : undefined,
      );
      const { config } = who;
      // To the owner the Operator only reports; to anyone else it acts for the request: a step (PM-463).
      // A message has one step, so with several such recipients it names the first as its `member`.
      const elsewhere = args.to.find((handle) => !isOwner(config, handle));
      return this.recorded(
        who,
        elsewhere !== undefined
          ? { action: 'message', taskKey: args.taskKey ?? ctx.taskKey ?? null, member: elsewhere }
          : null,
        async () => {
          // A person's decision or action is asked with ask_human, which lands in their "Rád vár" list; a message
          // to a person carries information only (PM-445). The whole call is refused, so no half message goes out.
          if (
            args.kind === 'action' &&
            args.to.some((handle) => memberOf(config, handle)?.kind === 'human')
          ) {
            throw new TeamToolError(
              'invalid',
              'use_ask_human: a human\'s decision or action is asked with ask_human; send_message to a human carries information only (kind "info"). Nothing was sent: ask the human with ask_human, and message AI members separately.',
            );
          }
          const taskKey = this.taskKeyFor(ctx, args.taskKey);
          // Humans have it in their messages now; AI recipients get it typed into their session
          // for the work item as soon as that session is idle (queued, never awaited here).
          const { message, recipients } = await this.messaging
            .sendReporting(
              ctx.projectKey,
              ctx.member,
              { to: args.to, text: args.text, taskKey },
              {
                actor: aiActor(ctx.member),
                sessionId: ctx.sessionId,
                kind: args.kind,
                operatorRequest: who.request?.id,
                operatorSignal: args.signalId,
                signalActionable: args.signalActionable ?? false,
              },
            )
            .catch((err: unknown) => {
              throw toMessageToolError(err);
            });
          const routed = (message.receipts ?? []).flatMap((r) =>
            r.route ? [{ handle: r.handle, workItem: r.route }] : [],
          );
          return {
            messageId: message.id,
            deliveredTo: message.to,
            recipients,
            ...(routed.length > 0 ? { routed } : {}),
          };
        },
      );
    });
  }

  async listMembers(ctx: ToolContext): Promise<MemberView[]> {
    return this.guard(async () => this.members.rosterFor(await this.caller(ctx, 'list_members')));
  }

  async listTasks(ctx: ToolContext, args: ListTasksInput): Promise<TaskSummary[]> {
    return this.guard(async () => {
      const config = await this.caller(ctx, 'list_tasks');
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
    return this.guard(async () => {
      const config = await this.caller(ctx, 'get_task');
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
      const cardWorkers = this.sessions.cardWorkersFor(config, detail.task, ctx.member);
      const focus = this.projectFocus.places(ctx.projectKey).get(taskKey);
      const wait = this.taskWaits.ofCard(config, detail.task);
      return {
        ...detail,
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
    });
  }

  async listAttachments(
    ctx: ToolContext,
    args: { taskKey: string; offset?: number; limit?: number },
  ): Promise<AttachmentPage> {
    return this.guard(async () => {
      await this.caller(ctx, 'list_attachments');
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
      await this.caller(ctx, 'read_attachment');
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
      // A session on another machine reads the file there: the engine gets it first (PM-315).
      const path = this.materializeAttachment
        ? await this.materializeAttachment({
            sessionId: ctx.sessionId,
            projectKey: ctx.projectKey,
            taskKey,
            attachment: located.attachment,
            storedPath: located.path,
          }).catch((err: unknown) => {
            if (err instanceof DomainError && err.code === 'engine_offline')
              throw new TeamToolError('invalid', 'The engine your session runs on is not connected.');
            throw err;
          })
        : located.path;
      return { ...located, path, readableWithoutAsking: own };
    });
  }

  async attachFile(
    ctx: ToolContext,
    args: { taskKey: string; path: string },
  ): Promise<{ attachment: Attachment }> {
    return this.guard(async () => {
      const who = await this.callerWithRequest(ctx, 'attach_file');
      return this.recorded(who, { action: 'task_update', taskKey: args.taskKey }, () =>
        this.attachFileOf(ctx, args),
      );
    });
  }

  private async attachFileOf(
    ctx: ToolContext,
    args: { taskKey: string; path: string },
  ): Promise<{ attachment: Attachment }> {
    const taskKey = this.validTaskKey(ctx, args.taskKey);
    const actor = aiActor(ctx.member);
    await this.attachments.assertCanUpload(ctx.projectKey, taskKey, actor);
    // The directories are the ones the server started the session with; the caller never names
    // them. The session folder is the one the server made for this process (it remembers it; the
    // path is never derived from the id) and counts only while it exists.
    const session = this.callerSession(ctx);
    const engine = this.sessionEngine?.(session.id);
    if (!engine) throw new TeamToolError('invalid', 'The engine your session runs on is not connected.');
    const recorded = engine.sessionFolders?.of(session.id);
    const folder = recorded && (await engine.isRealDirectory(recorded)) ? recorded : null;
    const inFolder =
      folder !== null && path.isAbsolute(args.path) && isWithin(folder, path.resolve(args.path));
    const place = inFolder
      ? { name: 'your session folder' }
      : {
          name: 'your working directory',
          ...(folder ? { other: { name: 'your session folder', path: folder } } : {}),
        };
    const file = await engine
      .openWorkspaceFile(inFolder ? folder : session.cwd, args.path, {
        maxBytes: MAX_ATTACHMENT_BYTES,
        place,
        // The sandbox lets the session empty and replace its own folder, so it must be its own real path.
        exactRoot: inFolder,
        sessionId: session.id,
      })
      .catch((err: unknown) => {
        throw toFileToolError(err, args.path);
      });
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
  }

  async takeScreenshots(ctx: ToolContext, input: TakeScreenshotsInput): Promise<ScreenshotRun> {
    return this.guard(async () => {
      await this.caller(ctx, 'take_screenshots');
      return this.screenshotRuns().take(ctx, input);
    });
  }

  async getScreenshotRun(ctx: ToolContext, runId: string): Promise<ScreenshotRun> {
    return this.guard(async () => {
      await this.caller(ctx, 'get_screenshot_run');
      return this.screenshotRuns().get(ctx, runId);
    });
  }

  private screenshotRuns(): Pick<ScreenshotRuns, 'take' | 'get'> {
    if (!this.screenshots)
      throw new TeamToolError('forbidden', 'This server makes no screenshots for members (no sandbox here).');
    return this.screenshots;
  }

  async deleteAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<{ attachmentId: string; fileName: string | null }> {
    return this.guard(async () => {
      const who = await this.callerWithRequest(ctx, 'delete_attachment');
      return this.recorded(who, { action: 'task_update', taskKey: args.taskKey }, async () => {
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
    });
  }

  async mergeTask(ctx: ToolContext, args: { taskKey: string }): Promise<{ task: Task }> {
    return this.guard(async () => {
      await this.caller(ctx, 'merge_task');
      return {
        task: await this.merges.start(
          ctx.projectKey,
          this.validTaskKey(ctx, args.taskKey),
          aiActor(ctx.member),
        ),
      };
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
    return this.guard(async () => {
      const who = await this.callerWithRequest(ctx, 'update_task');
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
      return this.recorded(
        who,
        { action, taskKey: args.taskKey },
        () => this.updateTaskOf(ctx, config, args, () => (awaiting = true)),
        () => awaiting,
      );
    });
  }

  private async updateTaskOf(
    ctx: ToolContext,
    config: ProjectConfig,
    args: Parameters<TeamToolsService['updateTask']>[1],
    onApproval: () => void,
  ): Promise<{ task: Task }> {
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
      return { task };
    } catch (err) {
      if (err instanceof DomainError && err.code === 'approval_requested') {
        const { approvers } = err.details as { approvers: string[] };
        onApproval();
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
    return this.guard(async () => {
      const who = await this.callerWithRequest(ctx, 'create_task');
      const { config } = who;
      return this.recorded(who, { action: 'task_create', madeTask: (made) => made.task.key }, async () => {
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
      });
    });
  }

  async linkPullRequest(
    ctx: ToolContext,
    args: { taskKey: string; repo: string; number: number },
  ): Promise<{ task: Task }> {
    return this.guard(async () => {
      const who = await this.callerWithRequest(ctx, 'link_pull_request');
      return this.recorded(who, { action: 'task_update', taskKey: args.taskKey }, async () => {
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
      const config = await this.caller(ctx, 'ask_human');
      const question = args.question.trim();
      if (!question) throw new TeamToolError('invalid', 'The question is empty.');
      const taskKey = this.taskKeyFor(ctx, args.taskKey);
      // The Operator asks only the owners (PM-463): an answer of anyone else would not be a request to it.
      const operator = isOperator(memberOf(config, ctx.member));
      let assignees: string[];
      if (args.to && args.to.length > 0) {
        const notHuman = args.to.filter((h) => memberOf(config, h)?.kind !== 'human');
        if (notHuman.length > 0)
          throw new TeamToolError(
            'invalid',
            `ask_human can only ask human members; these are not: ${notHuman.join(', ')}.`,
          );
        const notOwner = operator ? args.to.filter((h) => !isOwner(config, h)) : [];
        if (notOwner.length > 0)
          throw new TeamToolError(
            'invalid',
            `operator_owner_only: the Operator asks only the owners; these are not: ${notOwner.join(', ')}.`,
          );
        assignees = unique(args.to);
      } else {
        assignees = operator ? ownerHandles(config) : sponsorOrOwners(config, ctx.member);
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
      await this.caller(ctx, 'save_memory');
      const note = args.note.trim();
      if (!note) throw new TeamToolError('invalid', 'The memory note is empty.');
      await this.memory.append(ctx.projectKey, ctx.member, note);
      return { ok: true as const };
    });
  }

  async setCurrentWork(ctx: ToolContext, args: WorkDoing): Promise<{ recorded: boolean }> {
    return this.guard(async () => {
      await this.caller(ctx, 'set_current_work');
      const session = this.ctx.repos.sessions.get(ctx.sessionId);
      if (
        !session ||
        session.projectKey !== ctx.projectKey ||
        session.member !== ctx.member ||
        session.workItem.type !== 'task'
      )
        throw new TeamToolError(
          'invalid',
          'set_current_work is only for a session working on a task: this one is a meeting, a general chat or a scheduled run.',
        );
      return { recorded: this.sessions.setDoing(ctx.sessionId, args) };
    });
  }

  /**
   * The caller must still be an AI member of the project. The Operator (PM-463) also needs an open
   * owner request for every tool but the reading ones, and never calls the tools of other members'
   * decisions; `tool` is the MCP name of the tool being called.
   */
  private async caller(ctx: ToolContext, tool: string): Promise<ProjectConfig> {
    return (await this.callerWithRequest(ctx, tool)).config;
  }

  async operate(ctx: ToolContext, args: { title: string; operation: OperatorOperation }) {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError('forbidden', 'operator_only: only the Operator may operate.');
    const caller = await this.callerWithRequest(ctx, 'operate');
    return this.operatorActions
      .run(ctx.projectKey, caller.request!.id, args.title, args.operation)
      .catch((err: unknown) => {
        if (err instanceof DomainError)
          throw new TeamToolError(
            err.status === 403 ? 'forbidden' : 'invalid',
            `${err.code}: ${err.message}`,
          );
        throw err;
      });
  }

  async startTask(
    ctx: ToolContext,
    args: { taskKey: string; assignee?: string; despitePrerequisites?: boolean },
  ) {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may start tasks through this tool.',
      );
    const caller = await this.callerWithRequest(ctx, 'start_task');
    return this.recorded<{ task_key: string; session_id: string | null; hired: string | null }>(
      caller,
      { action: 'task_start', taskKey: args.taskKey, madeMember: (result) => result.hired },
      async () => {
        const operator = memberOf(config, ctx.member)!;
        const result = await this.taskStarts.start(ctx.projectKey, this.validTaskKey(ctx, args.taskKey), {
          ...args,
          startSetters: true,
          actor: aiActor(ctx.member),
          author: { name: operator.displayName, email: `${ctx.member}@projectman.local` },
          sponsor: caller.request!.fromHandle,
        });
        return {
          task_key: result.task.key,
          session_id: result.session?.id ?? null,
          hired: result.hired?.handle ?? null,
        };
      },
    ).catch((err: unknown) => {
      throw toToolError(err);
    });
  }

  /**
   * `caller`, plus the owner request the guard let the Operator's call through on (null for any other
   * caller and for a reading tool with none open). The step log must use this very request: opening it
   * again could find it expired between the guard and the write.
   */
  private async callerWithRequest(
    ctx: ToolContext,
    tool: string,
    signal?: { id?: string; to: string[] },
  ): Promise<CallerWithRequest> {
    const config = await this.projects.config(ctx.projectKey);
    const member = memberOf(config, ctx.member);
    if (member?.kind !== 'ai')
      throw new TeamToolError(
        'forbidden',
        `${ctx.member} is not an active AI member of this team, so the team tools are not available.`,
      );
    if (signal) {
      if (
        tool !== 'send_message' ||
        !isOperator(member) ||
        !signal.id ||
        signal.to.some((handle) => !isOwner(config, handle))
      )
        throw new TeamToolError(
          'invalid',
          'invalid_request: only the Operator may present signals to owners.',
        );
      this.operatorSignals.presentation(ctx.projectKey, signal.id);
    }
    if (!isOperator(member)) return { config, request: null };
    if (OPERATOR_NEVER_TOOLS.has(tool))
      throw new TeamToolError(
        'forbidden',
        `operator_never: ${tool} is not for the Operator. Decisions of other members, hand-overs and publishing outside are not its to do; tell the owner what you found.`,
      );
    const request = this.operatorRequests.openFor(ctx.sessionId);
    if (!request && !OPERATOR_READ_TOOLS.has(tool) && !signal)
      throw new TeamToolError(
        'forbidden',
        `operator_no_request: ${tool} writes, and the Operator writes only for an open request of an owner. ` +
          "There is none (its round is over or it timed out); wait for the owner's next message.",
      );
    return { config, request };
  }

  /**
   * Runs the Operator's write and logs it as one step of its open request, done or refused (PM-463).
   * Any other caller (`request` null), and a call that is no step (`step` null), just runs.
   */
  private async recorded<T>(
    { config, request }: CallerWithRequest,
    step: {
      action: OperatorAction;
      taskKey?: string | null;
      member?: string | null;
      /** The task the call made, when the step names it only afterwards. */
      madeTask?: (result: T) => string;
      madeMember?: (result: T) => string | null;
    } | null,
    run: () => Promise<T>,
    /** A refusal that is no refusal: the change waits for a human's approval. */
    awaitsApproval?: (err: unknown) => boolean,
  ): Promise<T> {
    if (!step || !request) return run();
    const target = {
      action: step.action,
      taskKey: step.taskKey && TaskKey.safeParse(step.taskKey).success ? step.taskKey : null,
      member: step.member && memberOf(config, step.member) ? step.member : null,
    };
    let result: T;
    try {
      result = await run();
    } catch (err) {
      this.operatorSteps.record(
        awaitsApproval?.(err)
          ? { requestId: request.id, ...target, status: 'awaiting_approval' }
          : { requestId: request.id, ...target, status: 'refused', refusal: refusalOf(err) },
      );
      throw err;
    }
    this.operatorSteps.record({
      requestId: request.id,
      ...target,
      ...(step.madeTask ? { taskKey: step.madeTask(result) } : {}),
      ...(step.madeMember ? { member: step.madeMember(result) } : {}),
      status: 'done',
    });
    return result;
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
   * The calling session, whose working directory (`cwd`) is as the server recorded it when it
   * started the session. The token names the session; it must still be this member's session in
   * this project.
   */
  private callerSession(ctx: ToolContext): Session {
    const session = this.ctx.repos.sessions.get(ctx.sessionId);
    if (!session || session.projectKey !== ctx.projectKey || session.member !== ctx.member)
      throw new TeamToolError(
        'forbidden',
        'Your session is not known to the server, so no file can be attached.',
      );
    return session;
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
