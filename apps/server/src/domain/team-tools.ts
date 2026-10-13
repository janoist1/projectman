import path from 'node:path';
import {
  AttachmentId,
  canReadAttachments,
  canProcessFeedback,
  DEFAULT_AGENT_PROVIDER,
  effectiveRepo,
  ERROR_CODES,
  LOCAL_ENGINE_ID,
  ownerHandles,
  isOpenTask,
  isOperator,
  isTheme,
  MAX_ATTACHMENT_BYTES,
  memberOf,
  MessageAttachmentId,
  messageRoute,
  needsRepoChoice,
  OPERATOR_SIGNAL_STEP_GAP_MINUTES,
  operatorSignalStepRefusal,
  operatorWatchOf,
  QUESTION_SCREENING_MINUTES,
  questionChoices,
  questionApprovalLabel,
  questionPayloadOf,
  sessionWorkItemOf,
  TaskStatus as TaskStatusSchema,
  TaskKey,
} from '@projectman/shared';
import type {
  Actor,
  Attachment,
  ErrorCode,
  FeedbackMarkDetail,
  InboxOption,
  MemberView,
  OperatorAction,
  OperatorStepStatus,
  ProjectConfig,
  QuestionAttachment,
  QuestionOptionInput,
  QuestionTodo,
  ScreeningOutcome,
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
import { PROVIDER_MCP_IMAGE_RESULTS, TeamToolError, WorkspaceFileRefusal } from '../contracts';
import type {
  AttachmentOperations,
  AttachmentPage,
  EngineAttachments,
  EngineHost,
  EngineSessionFolders,
  FeedbackToolList,
  FeedbackToolMark,
  FeedbackToolResult,
  GithubService,
  ListTasksInput,
  LocatedAttachmentForTool,
  MessageAttachmentReading,
  MemberMemoryStore,
  ProposedRelease,
  ReleaseCheckResult,
  ScreenshotRun,
  SentMessageRecipient,
  MemberStartResult,
  WorkspaceFile,
  TakeScreenshotsInput,
  TaskSummary,
  TaskToolDetail,
  TeamToolsHandler,
  ToolContext,
} from '../contracts';
import { isWithin } from './command-paths';
import type { DomainContext } from './context';
import { isoNow } from './context';
import type { BoundaryService } from './boundary';
import { QUESTION_LIMIT } from './card-questions';
import type { CardQuestions } from './card-questions';
import { DomainError } from './errors';
import { engineIdOf } from './engines';
import type { FeedbackService } from './feedback';
import type { ApprovalRequirement, UnmetCondition } from '@projectman/shared';
import type { FixLimitDecision, FixLimitWatch } from './fix-limit';
import type { HandoffService } from './handoffs';
import type { GithubSync } from './github-sync';
import { ANSWER_OPTION, sponsorOrOwners } from './inbox';
import type { InboxService } from './inbox';
import type { MemberService } from './members';
import type { Messaging } from './messaging';
import { recipientHasCardRole } from './messaging';
import type { OpenQuestionLabel } from './open-question-label';
import {
  OPERATOR_GUEST_TOOLS,
  OPERATOR_NEVER_TOOLS,
  OPERATOR_READ_TOOLS,
  OPERATOR_SCREENING_TOOLS,
  OPERATOR_TOOL_ACTIONS,
} from './operator-requests';
import type { OperatorRequests, OperatorSteps } from './operator-requests';
import { canSeeTask, clientCanSeeTimelineEvent, visibleTaskDetail, visibleTimelineEvent } from './visibility';
import { sessionFileName } from './message-attachments';
import type { MessageAttachmentService } from './message-attachments';
import type { Viewer } from './visibility';
import type { OperatorActions } from './operator-actions';
import type { OperatorSignals } from './operator-signals';
import type { QuestionScreening } from './question-screening';
import type { TaskStarts } from './admission';
import type { OperatorOperation, ProjectDoc } from '@projectman/shared';
import type { ProjectDocRead, ProjectDocWrite } from '../contracts';
import { docLines } from './doc-edits';
import type { DecisionCandidates } from './decision-candidates';
import type { DocWrites } from './doc-writes';
import type { ProjectFocusService } from './project-focus';
import type { ProjectService } from './projects';
import type { ProjectState } from './project-state';
import type { ScreenshotRuns } from './screenshot-runs';
import type { SessionCloser } from './session-closer';
import type { SessionOrchestrator } from './sessions';
import type { TaskService, TaskWaits } from './tasks';
import { attachmentToolRules } from './session-policy';
import type { TimelineService } from './timeline';
import { RELAY_WINDOW_MS } from './pm-reply-relay';
import { aiActor, humanActor, unique } from './util';

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
function toFileToolError(err: unknown, requested: string, done: 'attached' | 'sent' = 'attached'): unknown {
  if (err instanceof WorkspaceFileRefusal)
    return new TeamToolError(
      err.reason === 'outside' ? 'forbidden' : 'invalid',
      // The refusal may not name the file; with several files the caller must know which one.
      `${err.message.includes(requested) ? '' : `${requested}: `}${err.message} Nothing was ${done}.`,
    );
  if (err instanceof DomainError && err.code === 'attachment_too_large')
    return new TeamToolError(
      'invalid',
      `${requested} grew past ${MAX_ATTACHMENT_BYTES} bytes while it was read; nothing was ${done}.`,
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

/** The most lines read_project_doc returns in one call. */
const MAX_DOC_LINES = 2000;

/** A refusal of the document tools in words the agent reads: the error code first (`code: message`). */
function docToolError(err: unknown): unknown {
  if (err instanceof TeamToolError) return err;
  if (err instanceof DomainError)
    return new TeamToolError(
      err.status === 403 ? 'forbidden' : 'invalid',
      (ERROR_CODES as readonly string[]).includes(err.code) ? `${err.code}: ${err.message}` : err.message,
    );
  return err;
}

/** The refusals of the feedback tools in words the agent reads: the mark's error code first (`code: message`). */
function feedbackToolError(err: unknown): unknown {
  if (err instanceof TeamToolError || !(err instanceof DomainError)) return toToolError(err);
  if (err.code === 'feedback_mark_not_found')
    return new TeamToolError('not_found', `${err.code}: ${err.message}`);
  if (err.code.startsWith('feedback_'))
    return new TeamToolError(err.status === 403 ? 'forbidden' : 'invalid', `${err.code}: ${err.message}`);
  return toToolError(err);
}

/** The access of a team member as a processor sees it next to their mark: a person's access, or `ai`. */
function feedbackAccessOf(config: ProjectConfig, handle: string): string | null {
  const member = memberOf(config, handle);
  if (!member) return null;
  return member.kind === 'human' ? member.access : 'ai';
}

/** The state of a mark after a step, as the feedback tools answer. */
function feedbackResult(mark: Pick<FeedbackMarkDetail, 'id' | 'status' | 'outcome'>): FeedbackToolResult {
  return { markId: mark.id, status: mark.status, outcome: mark.outcome };
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
  /** The person the Operator talks with when they are not an owner: it reads what they see and answers them (PM-475). */
  guest: GuestView | null;
  /** The system signal the call acts on (PM-545); with no owner request, `request` is the signal round. */
  signalId?: string;
  /** The call holds its signal's step slot (`signalStepsRunning`) until `recorded` logs the step. */
  holdsSignalStep?: boolean;
}

/** The Operator's own step on a system signal, as the guard sees it (PM-545). */
interface SignalStep {
  signalId: string;
  tool: 'start_task' | 'start_member';
  member: string | null;
  taskKey: string | null;
}

interface GuestView {
  handle: string;
  viewer: Viewer;
}

const OWNER_ONLY = 'operator_owner_only';

/** What the feedback tools use of the feedback service. */
type FeedbackTools = Pick<
  FeedbackService,
  | 'listForProcessor'
  | 'detailForProcessor'
  | 'screenshotPath'
  | 'comment'
  | 'createTask'
  | 'link'
  | 'forward'
  | 'close'
>;

/**
 * The team tools behind the MCP server (mcp__team__*): they check the arguments, call the
 * domain services and put their refusals in words the agent reads. Every action is attributed
 * to the calling AI member.
 */
export class TeamToolsService implements TeamToolsHandler {
  private readonly projectState: ProjectState;
  private readonly docWrites: Pick<DocWrites, 'read' | 'request'>;
  private readonly decisionCandidates: Pick<DecisionCandidates, 'list' | 'mark'>;

  async getProjectState(ctx: ToolContext, args: { taskKey?: string; messageId?: string }) {
    return this.guard(async () => {
      const config = await this.caller(ctx, 'get_project_state');
      const member = memberOf(config, ctx.member);
      if (!member || !isOperator(member))
        throw new TeamToolError('forbidden', 'operator_only: only the Operator may read project state.');
      if (args.messageId !== undefined) {
        if (args.taskKey !== undefined)
          throw new TeamToolError('invalid', 'Give either task_key or message_id, not both.');
        return this.projectState.message(ctx.projectKey, args.messageId);
      }
      return args.taskKey
        ? this.projectState.task(ctx.projectKey, this.validTaskKey(ctx, args.taskKey))
        : this.projectState.overview(ctx.projectKey);
    });
  }
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
  private readonly operatorRequests: Pick<OperatorRequests, 'openFor' | 'roundFor' | 'openRound'>;
  private readonly operatorSteps: Pick<OperatorSteps, 'record' | 'ofSignal'>;
  /** Signals with an own step of the Operator running now (PM-545); one at a time, whatever the budget left. */
  private readonly signalStepsRunning = new Set<string>();
  private readonly operatorActions: OperatorActions;
  private readonly operatorSignals: OperatorSignals;
  private readonly questionScreening: Pick<QuestionScreening, 'enqueue' | 'enabled' | 'cannotScreen'>;
  private readonly taskStarts: TaskStarts;
  private readonly boundary: BoundaryService;
  private readonly ctx: DomainContext;
  private readonly sessions: Pick<SessionOrchestrator, 'setDoing' | 'cardWorkers' | 'cardWorkersFor'>;
  private readonly cardQuestions: Pick<CardQuestions, 'list'>;
  private readonly projects: ProjectService;
  private readonly projectFocus: Pick<ProjectFocusService, 'places'>;
  private readonly merges: import('./merges').Merges;
  private readonly releases: Pick<import('./releases').ReleaseService, 'preview' | 'propose' | 'check'>;
  private readonly tasks: TaskService;
  private readonly taskWaits: Pick<TaskWaits, 'of' | 'ofCard'>;
  private readonly members: MemberService;
  private readonly messaging: Messaging;
  private readonly inbox: InboxService;
  private readonly openQuestionLabel: OpenQuestionLabel;
  private readonly fixLimit: Pick<FixLimitWatch, 'decide'>;
  private readonly handoffs: Pick<HandoffService, 'recordNote'>;
  private readonly closer: Pick<SessionCloser, 'workReturned'>;
  private readonly timeline: TimelineService;
  private readonly memory: MemberMemoryStore;
  private readonly github: GithubService;
  private readonly githubSync: GithubSync;
  private readonly attachments: AttachmentOperations;
  private readonly messageAttachments: Pick<
    MessageAttachmentService,
    'reading' | 'source' | 'assertCanUpload' | 'upload' | 'delete'
  >;
  private readonly attachmentDirectory: (projectKey: string, taskKey: string) => Promise<string>;
  private readonly feedback: FeedbackTools;
  private readonly materializeAttachment: EngineAttachments['materialize'] | undefined;
  private readonly sessionEngine:
    | ((
        sessionId: string,
      ) => Pick<EngineHost, 'sessionFolders' | 'isRealDirectory' | 'openWorkspaceFile'> | undefined)
    | undefined;
  private readonly screenshots: Pick<ScreenshotRuns, 'take' | 'get'> | undefined;

  constructor(deps: {
    projectState: ProjectState;
    boundary: BoundaryService;
    ctx: DomainContext;
    /** The session service: set_current_work records the sentence on the caller's session. */
    sessions: Pick<SessionOrchestrator, 'setDoing' | 'cardWorkers' | 'cardWorkersFor'>;
    /** The questions asked on a card, which get_task lists (PM-249). */
    cardQuestions: Pick<CardQuestions, 'list'>;
    projects: ProjectService;
    merges: import('./merges').Merges;
    /** The instance's releases (PM-491): propose_release. */
    releases: Pick<import('./releases').ReleaseService, 'preview' | 'propose' | 'check'>;
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
    /** The session closer (PM-570): a verdict that gives the card's work back marks the caller's session. */
    closer: Pick<SessionCloser, 'workReturned'>;
    timeline: TimelineService;
    memory: MemberMemoryStore;
    github: GithubService;
    githubSync: GithubSync;
    attachments: AttachmentOperations;
    /** The files of team messages (PM-516): `read_message_attachment`. */
    messageAttachments: Pick<
      MessageAttachmentService,
      'reading' | 'source' | 'assertCanUpload' | 'upload' | 'delete'
    >;
    /** The attachment directory of a task (`AttachmentStorage.taskDirectory`). */
    attachmentDirectory: (projectKey: string, taskKey: string) => Promise<string>;
    /** The feedback marks (PM-512): the processors' tools decide them. */
    feedback: FeedbackTools;
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
    operatorRequests: Pick<OperatorRequests, 'openFor' | 'roundFor' | 'openRound'>;
    /** The Operator's step log (PM-463). */
    operatorSteps: Pick<OperatorSteps, 'record' | 'ofSignal'>;
    operatorActions: OperatorActions;
    operatorSignals: OperatorSignals;
    /** The Operator's screening of AI members' questions (PM-558): `ask_human` hands a new question to it. */
    questionScreening: Pick<QuestionScreening, 'enqueue' | 'enabled' | 'cannotScreen'>;
    taskStarts: TaskStarts;
    /** The Operator's project documents (PM-495): `read_project_doc` and `write_project_docs`. */
    docWrites: Pick<DocWrites, 'read' | 'request'>;
    /** The owners' answers that may be decisions (PM-496). */
    decisionCandidates: Pick<DecisionCandidates, 'list' | 'mark'>;
  }) {
    this.projectState = deps.projectState;
    this.docWrites = deps.docWrites;
    this.decisionCandidates = deps.decisionCandidates;
    this.operatorRequests = deps.operatorRequests;
    this.operatorSteps = deps.operatorSteps;
    this.operatorActions = deps.operatorActions;
    this.operatorSignals = deps.operatorSignals;
    this.questionScreening = deps.questionScreening;
    this.taskStarts = deps.taskStarts;
    this.screenshots = deps.screenshots;
    this.sessionEngine = deps.sessionEngine;
    this.boundary = deps.boundary;
    this.ctx = deps.ctx;
    this.sessions = deps.sessions;
    this.cardQuestions = deps.cardQuestions;
    this.projects = deps.projects;
    this.merges = deps.merges;
    this.releases = deps.releases;
    this.tasks = deps.tasks;
    this.taskWaits = deps.taskWaits;
    this.projectFocus = deps.projectFocus;
    this.members = deps.members;
    this.messaging = deps.messaging;
    this.inbox = deps.inbox;
    this.openQuestionLabel = deps.openQuestionLabel;
    this.fixLimit = deps.fixLimit;
    this.handoffs = deps.handoffs;
    this.closer = deps.closer;
    this.timeline = deps.timeline;
    this.memory = deps.memory;
    this.github = deps.github;
    this.githubSync = deps.githubSync;
    this.attachments = deps.attachments;
    this.messageAttachments = deps.messageAttachments;
    this.attachmentDirectory = deps.attachmentDirectory;
    this.feedback = deps.feedback;
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
      signalIds?: string[];
      actionableSignalIds?: string[];
      /** Paths of files of the caller's session folder or working directory (PM-520). */
      attachments?: string[];
    },
  ): Promise<{
    messageId: string;
    deliveredTo: string[];
    recipients: SentMessageRecipient[];
    routed?: { handle: string; workItem: WorkItemRef }[];
    operator: boolean;
  }> {
    return this.guard(async () => {
      const legacy = args.signalId !== undefined || args.signalActionable !== undefined;
      const batch = args.signalIds !== undefined || args.actionableSignalIds !== undefined;
      const ids = batch ? (args.signalIds ?? []) : args.signalId !== undefined ? [args.signalId] : [];
      const actionable = args.actionableSignalIds ?? [];
      if (
        (legacy && batch) ||
        ((legacy || batch) && ids.length === 0) ||
        ids.length > 20 ||
        new Set(ids).size !== ids.length ||
        new Set(actionable).size !== actionable.length ||
        actionable.some((id) => !ids.includes(id))
      )
        throw new TeamToolError('invalid', 'invalid_request: invalid signal presentation arguments.');
      const signal = legacy || batch;
      const who = await this.callerWithRequest(
        ctx,
        'send_message',
        signal ? { ids, to: args.to } : undefined,
      );
      const { config, guest } = who;
      const operator = isOperator(memberOf(config, ctx.member));
      // In a guest's conversation the Operator answers that person and nobody else; that is no step (PM-475).
      if (guest) {
        const other = args.to.find((handle) => handle !== guest.handle);
        if (other !== undefined || args.to.length === 0) {
          this.recordRefusedWrite(who, 'send_message', other);
          throw new TeamToolError(
            'forbidden',
            `${OWNER_ONLY}: in this conversation you answer ${guest.handle} only; a message to anyone else is for the project owner to ask.`,
          );
        }
        if (args.taskKey !== undefined) this.visibleTaskKey(ctx, guest, args.taskKey);
      }
      // To the owner the Operator only reports; to anyone else it acts for the request: a step (PM-463).
      // A message has one step, so with several such recipients it names the first as its `member`.
      const elsewhere = guest ? undefined : args.to.find((handle) => !isOwner(config, handle));
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
          const taskKey =
            this.taskKeyFor(ctx, args.taskKey) ??
            (who.request || guest ? null : this.repliedCardOf(ctx, config));
          // The files are stored first and bound in the same send: a file that cannot be read stops the
          // message, and the ones stored for it are removed (PM-520).
          const attachmentIds =
            args.attachments && args.attachments.length > 0
              ? await this.uploadMessageFiles(ctx, args.attachments)
              : [];
          // Humans have it in their messages now; AI recipients get it typed into their session
          // for the work item as soon as that session is idle (queued, never awaited here).
          const { message, recipients } = await this.messaging
            .sendReporting(
              ctx.projectKey,
              ctx.member,
              {
                to: args.to,
                text: args.text,
                taskKey,
                ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
              },
              {
                actor: aiActor(ctx.member),
                sessionId: ctx.sessionId,
                kind: args.kind,
                // The report sits under the round of the own steps on signals when no request is open (PM-545).
                operatorRequest:
                  who.request?.id ??
                  (operator ? this.operatorRequests.roundFor(ctx.sessionId)?.id : undefined),
                operatorSignals: signal
                  ? ids.map((id) => ({
                      id,
                      actionable: batch ? actionable.includes(id) : (args.signalActionable ?? false),
                    }))
                  : undefined,
                // The Operator is told what became of waking each recipient (PM-543); others' sends stay quick.
                ...(operator ? { awaitWake: true } : {}),
              },
            )
            .catch(async (err: unknown) => {
              await this.discardMessageFiles(ctx, attachmentIds);
              throw toMessageToolError(err);
            });
          const routed = (message.receipts ?? []).flatMap((r) =>
            r.route ? [{ handle: r.handle, workItem: r.route }] : [],
          );
          return {
            messageId: message.id,
            deliveredTo: message.to,
            recipients,
            operator,
            ...(routed.length > 0 ? { routed } : {}),
          };
        },
      );
    });
  }

  async listMembers(ctx: ToolContext): Promise<MemberView[]> {
    return this.guard(async () => {
      const { config, guest } = await this.callerWithRequest(ctx, 'list_members');
      return guest ? this.members.rosterForViewer(config, guest.viewer) : this.members.rosterFor(config);
    });
  }

  /**
   * A task key of the caller's project that the guest may see: a card they may not see does not exist
   * for them (PM-475). Without a guest (any other caller) it is `validTaskKey`.
   */
  private visibleTaskKey(ctx: ToolContext, guest: GuestView | null, taskKey: string): string {
    const key = this.validTaskKey(ctx, taskKey);
    if (guest && !canSeeTask(guest.viewer, this.tasks.get(ctx.projectKey, key)))
      throw new TeamToolError('not_found', `Task ${key} does not exist in this project.`);
    return key;
  }

  async listTasks(ctx: ToolContext, args: ListTasksInput): Promise<TaskSummary[]> {
    return this.guard(async () => {
      const { config, guest } = await this.callerWithRequest(ctx, 'list_tasks');
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
            (!guest || canSeeTask(guest.viewer, task)) &&
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
          // What the team plans and why a card stands still is not shown to a client (PM-475).
          ...(places.has(key) && guest?.viewer.access !== 'client' ? { focus: places.get(key) } : {}),
          ...(wait && guest?.viewer.access !== 'client' ? { waitsFor: taskWaitShort(wait) } : {}),
        };
      });
    });
  }

  async getTask(ctx: ToolContext, args: { taskKey: string; eventId?: string }): Promise<TaskToolDetail> {
    return this.guard(async () => {
      const { config, guest } = await this.callerWithRequest(ctx, 'get_task');
      const taskKey = this.visibleTaskKey(ctx, guest, args.taskKey);
      const whole = await this.taskToolDetail(ctx, config, taskKey, args.eventId, guest);
      return guest ? this.taskDetailForGuest(ctx.projectKey, whole, guest.viewer) : whole;
    });
  }

  /**
   * The task detail as the guest of the Operator sees it (PM-475), by the rules of the REST detail: a
   * client's card links lead only to cards they see, and they get the milestones of the timeline only;
   * what the team does about the card (who works on it, its questions, why it waits) is not theirs.
   */
  private taskDetailForGuest(projectKey: string, whole: TaskToolDetail, viewer: Viewer): TaskToolDetail {
    const canSeeKey = (key: string) => {
      const other = this.tasks.find(projectKey, key);
      return !!other && canSeeTask(viewer, other);
    };
    const participants = (id: string) => this.ctx.repos.messages.get(id);
    const { event, ...rest } = whole;
    const shown = visibleTaskDetail(viewer, rest, canSeeKey, participants);
    if (event) {
      const seen = visibleTimelineEvent(viewer, event, participants);
      if (viewer.access === 'client' && !clientCanSeeTimelineEvent(seen))
        throw new TeamToolError('not_found', `${shown.task.key} has no timeline event ${event.id}.`);
      return { ...shown, event: seen };
    }
    if (viewer.access !== 'client') return { ...rest, ...shown };
    const {
      wait: _wait,
      focus: _focus,
      cardWorkers: _workers,
      workingSessionIds: _working,
      cardQuestions: _questions,
      undeliveredMessageIds: _undelivered,
      pendingSentMessages: _pending,
      theme,
      ...open
    } = rest;
    return {
      ...open,
      ...shown,
      ...(open.relations ? { relations: open.relations.filter((relation) => canSeeKey(relation.key)) } : {}),
      ...(theme && canSeeKey(theme.key) ? { theme } : {}),
      ...(open.themeCards
        ? {
            themeCards: open.themeCards
              .filter((card) => canSeeKey(card.key))
              .map((card) => ({ ...card, subtasks: card.subtasks.filter((sub) => canSeeKey(sub.key)) })),
          }
        : {}),
    };
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
  }

  async listAttachments(
    ctx: ToolContext,
    args: { taskKey: string; offset?: number; limit?: number },
  ): Promise<AttachmentPage> {
    return this.guard(async () => {
      const { guest } = await this.callerWithRequest(ctx, 'list_attachments');
      const taskKey = this.visibleTaskKey(ctx, guest, args.taskKey);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      if (!Number.isInteger(offset) || offset < 0)
        throw new TeamToolError('invalid', 'offset must be a whole number, 0 or more.');
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ATTACHMENT_PAGE)
        throw new TeamToolError('invalid', `limit must be an integer between 1 and ${MAX_ATTACHMENT_PAGE}.`);
      const all = await this.attachments.list(
        ctx.projectKey,
        taskKey,
        guest ? humanActor(guest.handle) : aiActor(ctx.member),
      );
      return { attachments: all.slice(offset, offset + limit), total: all.length, offset };
    });
  }

  async readAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<LocatedAttachmentForTool> {
    return this.guard(async () => {
      const { guest } = await this.callerWithRequest(ctx, 'read_attachment');
      const taskKey = this.visibleTaskKey(ctx, guest, args.taskKey);
      const id = this.validAttachmentId(args.attachmentId);
      const located = await this.attachments
        .locate(ctx.projectKey, taskKey, id, guest ? humanActor(guest.handle) : aiActor(ctx.member))
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

  async readMessageAttachment(
    ctx: ToolContext,
    args: { attachmentId: string },
  ): Promise<MessageAttachmentReading> {
    return this.guard(async () => {
      const { guest } = await this.callerWithRequest(ctx, 'read_message_attachment');
      const id = args.attachmentId;
      if (!MessageAttachmentId.safeParse(id).success)
        throw new TeamToolError(
          'invalid',
          `Invalid message attachment id "${id}"; they look like "msa_…" (in the Attachments block of a message).`,
        );
      // The file is judged through the eyes of whoever the session talks for: the AI member, or the
      // guest of an Operator conversation, so a file of a message they cannot see is not found.
      const viewer = guest ? guest.viewer : { access: 'ai' as const, handle: ctx.member };
      // A session with file tools of its own gets what the content cannot show as a file in its
      // session folder (PM-518). A guest conversation reads no file at all: it has no folder.
      const target = guest ? null : this.sessionFileTarget(ctx);
      const notFound = (err: unknown): never => {
        if (err instanceof DomainError && err.code === 'not_found')
          throw new TeamToolError(
            'not_found',
            `There is no message attachment ${id} that you can see (or it was deleted).`,
          );
        throw err;
      };
      const reading = await this.messageAttachments
        .reading(ctx.projectKey, id, viewer, { images: !target || target.mcpImageResults })
        .catch(notFound);
      if (!target || reading.content.kind !== 'none') return reading;
      try {
        const source = await this.messageAttachments.source(ctx.projectKey, id, viewer);
        const file = await target.folders.materializeFile(target.sessionId, {
          name: sessionFileName(id, reading.attachment.fileName),
          source,
        });
        return { ...reading, file: { path: file.path } };
      } catch (err) {
        // The file is an addition: an engine that cannot take it (offline, older, no folder for
        // the session) leaves the reading as it is, with the entry only.
        this.ctx.logger.warn(
          { err, attachment: id, session: target.sessionId },
          'message attachment could not be put into the session folder',
        );
        return reading;
      }
    });
  }

  /**
   * Where the calling session's files go (PM-518): its engine's session folders when the session has
   * a folder of its own there, and whether its CLI shows an image in a tool result. Null: the session
   * has no folder (a provider without session folders, an unknown session), so it
   * gets the content only.
   */
  private sessionFileTarget(
    ctx: ToolContext,
  ): { sessionId: string; folders: EngineSessionFolders; mcpImageResults: boolean } | null {
    const session = this.ctx.repos.sessions.get(ctx.sessionId);
    if (!session || session.projectKey !== ctx.projectKey || session.member !== ctx.member) return null;
    const folders = this.sessionEngine?.(session.id)?.sessionFolders;
    if (!folders?.of(session.id)) return null;
    return {
      sessionId: session.id,
      folders,
      mcpImageResults: PROVIDER_MCP_IMAGE_RESULTS[session.provider ?? DEFAULT_AGENT_PROVIDER],
    };
  }

  // ---- feedback marks (PM-512, processors only) ----

  async getFeedbackList(
    ctx: ToolContext,
    args: { status: 'todo' | 'open' | 'all'; limit: number },
  ): Promise<FeedbackToolList> {
    return this.feedbackStep(ctx, async (actor, config) => {
      const { marks, total } = await this.feedback.listForProcessor(ctx.projectKey, actor, args);
      const authorAccess: Record<string, string> = {};
      for (const { author } of marks) {
        const access = feedbackAccessOf(config, author.handle);
        if (access) authorAccess[author.handle] = access;
      }
      return { status: args.status, total, marks, authorAccess };
    });
  }

  async getFeedbackMark(ctx: ToolContext, args: { markId: string }): Promise<FeedbackToolMark> {
    return this.feedbackStep(ctx, async (actor, config) => {
      const mark = await this.feedback.detailForProcessor(ctx.projectKey, args.markId, actor);
      const authorAccess = feedbackAccessOf(config, mark.author.handle);
      if (!mark.screenshot) return { mark, authorAccess, screenshot: { kind: 'none' } as const };
      // The stored file is on the server's machine: only a session that runs there can open it.
      const session = this.ctx.repos.sessions.get(ctx.sessionId);
      if (!session || engineIdOf(session) !== LOCAL_ENGINE_ID)
        return { mark, authorAccess, screenshot: { kind: 'remote' } as const };
      const path = await this.feedback.screenshotPath(ctx.projectKey, args.markId, actor);
      return {
        mark,
        authorAccess,
        screenshot: path ? ({ kind: 'local', path } as const) : ({ kind: 'none' } as const),
      };
    });
  }

  async replyFeedback(ctx: ToolContext, args: { markId: string; body: string }): Promise<FeedbackToolResult> {
    return this.feedbackStep(ctx, async (actor) =>
      feedbackResult(await this.feedback.comment(ctx.projectKey, args.markId, actor, args.body)),
    );
  }

  async createTaskFromFeedback(
    ctx: ToolContext,
    args: { markId: string; title: string; description: string; visibility?: Visibility; reply?: string },
  ): Promise<FeedbackToolResult> {
    return this.feedbackStep(ctx, async (actor) => {
      const created = await this.feedback.createTask(ctx.projectKey, args.markId, actor, {
        title: args.title,
        description: args.description,
        ...(args.visibility ? { visibility: args.visibility } : {}),
        ...(args.reply ? { reply: args.reply } : {}),
      });
      return { ...feedbackResult(created.mark), task: created.task };
    });
  }

  async linkFeedback(
    ctx: ToolContext,
    args: { markId: string; taskKey: string; reply?: string },
  ): Promise<FeedbackToolResult> {
    return this.feedbackStep(ctx, async (actor) =>
      feedbackResult(
        await this.feedback.link(ctx.projectKey, args.markId, actor, {
          taskKey: this.validTaskKey(ctx, args.taskKey),
          ...(args.reply ? { reply: args.reply } : {}),
        }),
      ),
    );
  }

  async forwardFeedback(
    ctx: ToolContext,
    args: { markId: string; reason: string; reply: string },
  ): Promise<FeedbackToolResult> {
    return this.feedbackStep(ctx, async (actor) =>
      feedbackResult(
        await this.feedback.forward(ctx.projectKey, args.markId, actor, {
          reason: args.reason,
          reply: args.reply,
        }),
      ),
    );
  }

  async closeFeedback(
    ctx: ToolContext,
    args: { markId: string; reply?: string },
  ): Promise<FeedbackToolResult> {
    return this.feedbackStep(ctx, async (actor) =>
      feedbackResult(await this.feedback.close(ctx.projectKey, args.markId, actor, args.reply)),
    );
  }

  /**
   * A feedback tool: only an AI member that processes feedback calls it (the Operator and the other roles
   * get `feedback_processor_only`), and the refusals of the mark's rules come with their code in the message.
   */
  private async feedbackStep<T>(
    ctx: ToolContext,
    run: (actor: Actor, config: ProjectConfig) => Promise<T>,
  ): Promise<T> {
    try {
      const config = await this.projects.config(ctx.projectKey);
      const member = memberOf(config, ctx.member);
      if (member?.kind !== 'ai')
        throw new TeamToolError(
          'forbidden',
          `${ctx.member} is not an active AI member of this team, so the team tools are not available.`,
        );
      if (!canProcessFeedback(config, member))
        throw new TeamToolError(
          'forbidden',
          'feedback_processor_only: only a member with the feedback processing duty may use the feedback tools.',
        );
      return await run(aiActor(ctx.member), config);
    } catch (err) {
      throw feedbackToolError(err);
    }
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
    const file = await this.openSessionFile(ctx, args.path, 'attached');
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

  /**
   * Opens a file of the caller's session for reading: a path inside its session folder or relative to
   * its working directory (`attach_file`, and the files of `send_message`). The directories are the ones
   * the server started the session with; the caller never names them. The session folder is the one the
   * server made for this process (it remembers it; the path is never derived from the id) and counts
   * only while it exists.
   */
  private async openSessionFile(
    ctx: ToolContext,
    requested: string,
    done: 'attached' | 'sent',
  ): Promise<WorkspaceFile> {
    const session = this.callerSession(ctx);
    const engine = this.sessionEngine?.(session.id);
    if (!engine) throw new TeamToolError('invalid', 'The engine your session runs on is not connected.');
    const recorded = engine.sessionFolders?.of(session.id);
    const folder = recorded && (await engine.isRealDirectory(recorded)) ? recorded : null;
    const inFolder =
      folder !== null && path.isAbsolute(requested) && isWithin(folder, path.resolve(requested));
    const place = inFolder
      ? { name: 'your session folder' }
      : {
          name: 'your working directory',
          ...(folder ? { other: { name: 'your session folder', path: folder } } : {}),
        };
    return engine
      .openWorkspaceFile(inFolder ? folder : session.cwd, requested, {
        maxBytes: MAX_ATTACHMENT_BYTES,
        place,
        // The sandbox lets the session empty and replace its own folder, so it must be its own real path.
        exactRoot: inFolder,
        sessionId: session.id,
      })
      .catch((err: unknown) => {
        throw toFileToolError(err, requested, done);
      });
  }

  /**
   * Stores the files of a `send_message` as the caller's unsent message attachments (PM-520). All or
   * nothing: when one cannot be stored, the ones stored so far are deleted and the error names the file.
   */
  private async uploadMessageFiles(ctx: ToolContext, paths: readonly string[]): Promise<string[]> {
    const actor = aiActor(ctx.member);
    await this.messageAttachments.assertCanUpload(ctx.projectKey, actor);
    const ids: string[] = [];
    try {
      for (const requested of paths) {
        const file = await this.openSessionFile(ctx, requested, 'sent');
        try {
          const stored = await this.messageAttachments.upload({
            projectKey: ctx.projectKey,
            actor,
            fileName: file.name,
            content: file.stream(),
            beforeCommit: () => file.verifyUnchanged(),
          });
          ids.push(stored.id);
        } catch (err) {
          throw toFileToolError(err, requested, 'sent');
        } finally {
          await file.close();
        }
      }
      return ids;
    } catch (err) {
      await this.discardMessageFiles(ctx, ids);
      throw err;
    }
  }

  /** Removes unsent message files after a refused send; a failure is left to the 24 h sweep. */
  private async discardMessageFiles(ctx: ToolContext, ids: readonly string[]): Promise<void> {
    const actor = aiActor(ctx.member);
    for (const id of ids)
      await this.messageAttachments.delete(ctx.projectKey, id, actor).catch(() => undefined);
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

  async mergeTask(
    ctx: ToolContext,
    args: { taskKey: string; fixConflict?: boolean; resolution?: string },
  ): Promise<{ task: Task }> {
    return this.guard(async () => {
      await this.caller(ctx, 'merge_task');
      return {
        task: await this.merges.start(
          ctx.projectKey,
          this.validTaskKey(ctx, args.taskKey),
          aiActor(ctx.member),
          args,
        ),
      };
    });
  }

  async prioritizeMerge(
    ctx: ToolContext,
    args: { taskKey: string; reason: string },
  ): Promise<{ task: Task; moved: boolean }> {
    return this.guard(async () => {
      const caller = await this.callerWithRequest(ctx, 'prioritize_merge');
      const taskKey = this.validTaskKey(ctx, args.taskKey);
      const operator = isOperator(memberOf(caller.config, ctx.member));
      return this.recorded(caller, operator ? { action: 'task_update', taskKey } : null, () =>
        this.merges.prioritize(ctx.projectKey, taskKey, aiActor(ctx.member), args.reason),
      );
    });
  }

  async proposeRelease(
    ctx: ToolContext,
    args: { title: string; summary: string; commit?: string; preview?: boolean },
  ): Promise<ProposedRelease> {
    return this.guard(async () => {
      await this.caller(ctx, 'propose_release');
      try {
        if (args.preview) {
          const candidate = await this.releases.preview(ctx.projectKey, ctx.member, args.commit);
          return { commit: candidate.commit, baseCommit: candidate.baseCommit, tasks: candidate.tasks };
        }
        const { release, candidate } = await this.releases.propose(ctx.projectKey, ctx.member, {
          title: args.title,
          summary: args.summary,
          commit: args.commit,
        });
        return {
          releaseId: release.id,
          taskKey: release.taskKey,
          commit: release.commit,
          baseCommit: release.baseCommit,
          tasks: candidate.tasks,
        };
      } catch (err) {
        // The agent reads the code: it says what to do (wait for the open release, nothing to release).
        if (err instanceof DomainError && err.code.startsWith('release_'))
          throw new TeamToolError(
            err.status === 403 ? 'forbidden' : 'invalid',
            `${err.code}: ${err.message}`,
          );
        throw err;
      }
    });
  }

  async checkRelease(ctx: ToolContext, args: { commit?: string }): Promise<ReleaseCheckResult> {
    return this.guard(async () => {
      const config = await this.caller(ctx, 'check_release');
      const member = memberOf(config, ctx.member);
      if (!member || !isOperator(member))
        throw new TeamToolError('forbidden', 'operator_only: only the Operator may check a release.');
      return this.releases.check(ctx.projectKey, args.commit);
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
      attachmentIds?: string[];
      /** The question asked again after the Operator screened it away (PM-558), and why a person must see it. */
      reaskOf?: string;
      reaskReason?: string;
    },
  ): Promise<{
    inboxItemId: string;
    approvalLabel?: string;
    attachments?: QuestionAttachment[];
    screening?: true;
  }> {
    return this.guard(async () => {
      const config = await this.caller(ctx, 'ask_human');
      const question = args.question.trim();
      if (!question) throw new TeamToolError('invalid', 'The question is empty.');
      const taskKey = this.taskKeyFor(ctx, args.taskKey);
      // The Operator asks only the owners (PM-463): an answer of anyone else would not be a request to it.
      const operator = isOperator(memberOf(config, ctx.member));
      const unscreened = this.reask(ctx, args.reaskOf, args.reaskReason);
      // Every other AI member's question goes through the Operator first (PM-558); a re-ask does not.
      const screened =
        this.questionScreening.enabled &&
        !operator &&
        !unscreened &&
        memberOf(config, ctx.member)?.kind === 'ai';
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
      const task = taskKey ? this.tasks.find(ctx.projectKey, taskKey) : null;
      const approvalLabel = task
        ? questionApprovalLabel(config, task, {
            text: [question, ...choices.flatMap((choice) => [choice.label, choice.consequence]), details]
              .filter(Boolean)
              .join('\n'),
            assignees,
          })
        : null;
      // The files are checked before the label is claimed: a refusal leaves no waiting label behind.
      const attachments = this.questionAttachments(
        config,
        ctx.projectKey,
        task,
        assignees,
        args.attachmentIds,
      );
      const autoLabel = await this.openQuestionLabel.claim(ctx.projectKey, taskKey, ctx.member, question);
      const item = this.inbox.create({
        projectKey: ctx.projectKey,
        kind: 'question',
        assignees,
        source: ctx.member,
        sessionId: ctx.sessionId,
        taskKey,
        title: question,
        ...(screened ? { state: 'screening' as const } : {}),
        payload: {
          question,
          ...(screened
            ? {
                screening: {
                  until: new Date(
                    this.ctx.now().getTime() + QUESTION_SCREENING_MINUTES * 60_000,
                  ).toISOString(),
                },
              }
            : {}),
          ...(unscreened ? { unscreened } : {}),
          options: choices.map((choice) => choice.label),
          ...(approvalLabel ? { approvalLabel } : {}),
          ...(recommendedIndex >= 0 ? { recommended: options[recommendedIndex]!.id } : {}),
          ...(reason ? { recommendationReason: reason } : {}),
          ...(details ? { details } : {}),
          ...(autoLabel ? { autoLabel } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        options,
      });
      this.timeline.append({
        projectKey: ctx.projectKey,
        taskKey,
        sessionId: ctx.sessionId,
        actor: aiActor(ctx.member),
        type: 'question_asked',
        data: {
          inboxItemId: item.id,
          question,
          ...(screened ? { screening: true as const } : {}),
          ...(unscreened ? { unscreened } : {}),
        },
      });
      // An Operator that cannot take it gives the question to the people before this call returns; one that
      // can is woken without waiting for its session.
      const hopeless = screened && this.questionScreening.cannotScreen(ctx.projectKey, config);
      if (screened) {
        const handed = this.questionScreening.enqueue(ctx.projectKey).catch((err: unknown) => {
          this.ctx.logger.warn({ err, inboxItemId: item.id }, 'could not hand a question to the screening');
        });
        if (hopeless) await handed;
        else void handed;
      }
      return {
        inboxItemId: item.id,
        ...(approvalLabel ? { approvalLabel } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(screened && !hopeless ? { screening: true as const } : {}),
      };
    });
  }

  /**
   * A question asked again after the Operator answered, forwarded or closed it (PM-558): the new question
   * goes to the people unscreened, once per earlier question. Returns what the new item records, or null for
   * an ordinary question. Throws `reask_not_allowed` before anything is written.
   */
  private reask(
    ctx: ToolContext,
    reaskOf: string | undefined,
    reaskReason: string | undefined,
  ): { reason: string; previousItemId: string } | null {
    const reason = reaskReason?.trim();
    if (reaskOf === undefined && reason === undefined) return null;
    if (!reaskOf || !reason)
      throw new TeamToolError('invalid', 'reask_not_allowed: reask_of and reask_reason go together.');
    const previous = this.ctx.repos.inbox.get(reaskOf);
    if (!previous || previous.projectKey !== ctx.projectKey || previous.kind !== 'question')
      throw new TeamToolError('invalid', 'reask_not_allowed: there is no such question of yours.');
    if (previous.source !== ctx.member)
      throw new TeamToolError('invalid', 'reask_not_allowed: only the member who asked may ask again.');
    const outcome = questionPayloadOf(previous)?.screening?.outcome;
    if (outcome !== 'answered' && outcome !== 'forwarded' && outcome !== 'moot')
      throw new TeamToolError(
        'invalid',
        'reask_not_allowed: the Operator did not answer, forward or close that question.',
      );
    const asked = this.inbox
      .list(ctx.projectKey, { kind: 'question', limit: 100_000 })
      .some((item) => questionPayloadOf(item)?.unscreened?.previousItemId === reaskOf);
    if (asked)
      throw new TeamToolError('invalid', 'reask_not_allowed: that question was already asked again.');
    return { reason, previousItemId: reaskOf };
  }

  /**
   * The Operator settles a question it screens (PM-558): it answers it, passes it to a member, closes it as
   * moot, or sends it on to the people as a decision or a todo. Only the Operator, and not from a guest
   * conversation. Throws before anything changes when the fields do not fit the outcome.
   */
  async screenQuestion(
    ctx: ToolContext,
    args: {
      itemId: string;
      outcome: ScreeningOutcome;
      note: string;
      answer?: string;
      forwardTo?: string;
      todo?: QuestionTodo;
    },
  ): Promise<{ inboxItemId: string; outcome: ScreeningOutcome }> {
    return this.guard(async () => {
      const config = await this.projects.config(ctx.projectKey);
      if (!isOperator(memberOf(config, ctx.member)))
        throw new TeamToolError('forbidden', 'operator_only: only the Operator may screen questions.');
      await this.callerWithRequest(ctx, 'screen_question');
      const { outcome } = args;
      const note = args.note.trim();
      const answer = args.answer?.trim();
      const forwardTo = args.forwardTo?.trim();
      const fieldError = (problem: string) =>
        new TeamToolError('invalid', `invalid_outcome_fields: ${problem}`);
      if (!note) throw fieldError('note is required with every outcome.');
      if ((outcome === 'answered') !== (answer !== undefined && answer !== ''))
        throw fieldError(
          outcome === 'answered' ? 'answered needs an answer.' : 'only answered takes an answer.',
        );
      if ((outcome === 'forwarded') !== (forwardTo !== undefined))
        throw fieldError(
          outcome === 'forwarded' ? 'forwarded needs forward_to.' : 'only forwarded takes forward_to.',
        );
      if ((outcome === 'todo') !== (args.todo !== undefined))
        throw fieldError(
          outcome === 'todo' ? 'todo needs the todo fields.' : 'only todo takes the todo fields.',
        );
      const item = this.ctx.repos.inbox.get(args.itemId);
      if (!item || item.projectKey !== ctx.projectKey || item.kind !== 'question')
        throw new TeamToolError('not_found', `No question ${args.itemId} in this project.`);
      const asker = memberOf(config, item.source);
      // A moot question may also be one that already went to the people, if an AI member asked it.
      const mootOpen =
        outcome === 'moot' && item.state === 'open' && asker?.kind === 'ai' && !isOperator(asker);
      if (item.state !== 'screening' && !mootOpen)
        throw new TeamToolError(
          'invalid',
          `question_not_screening: ${item.id} is not waiting for the Operator (it is ${item.state}).`,
        );
      if (forwardTo !== undefined) {
        const recipient = memberOf(config, forwardTo);
        if (recipient?.kind !== 'ai' || isOperator(recipient) || forwardTo === item.source)
          throw fieldError(
            `forward_to must be an AI member of the project other than the asker and the Operator; ${forwardTo} is not.`,
          );
      }
      const by = ctx.member;
      const settled =
        outcome === 'decision' || outcome === 'todo'
          ? await this.inbox.releaseScreened(item.id, {
              outcome,
              by,
              note,
              ...(args.todo ? { todo: args.todo } : {}),
            })
          : await this.inbox.settleScreened(
              item.id,
              {
                outcome,
                by,
                note,
                ...(answer ? { answer } : {}),
                ...(forwardTo ? { forwardedTo: forwardTo } : {}),
              },
              outcome === 'answered'
                ? (resolved, close) => this.messaging.answer(resolved, [], close)
                : outcome === 'forwarded'
                  ? (resolved, close) =>
                      this.messaging.forwardQuestion(resolved, { to: forwardTo!, note }, close)
                  : undefined,
            );
      if (!settled)
        throw new TeamToolError(
          'invalid',
          `question_not_screening: ${item.id} is not waiting for the Operator any more.`,
        );
      return { inboxItemId: item.id, outcome };
    });
  }

  /**
   * The files a question names (PM-498), as snapshots in the order given and without repeats. Only
   * ready files of the question's card or its parent qualify, and every asked person must be able
   * to open each of them. Throws before anything is written.
   */
  private questionAttachments(
    config: ProjectConfig,
    projectKey: string,
    task: Task | null,
    assignees: string[],
    ids: string[] | undefined,
  ): QuestionAttachment[] {
    const wanted = unique(ids ?? []);
    if (wanted.length === 0) return [];
    if (!task)
      throw new TeamToolError(
        'invalid',
        'attachments_need_card: files can be named only on a question about a card; give task_key or ask without attachments.',
      );
    const parent = task.parentKey ? this.tasks.find(projectKey, task.parentKey) : null;
    const allowed = [task, ...(parent ? [parent] : [])];
    const scope = parent ? `${task.key} or its parent ${parent.key}` : task.key;
    const found: QuestionAttachment[] = [];
    for (const id of wanted) {
      const row = this.ctx.repos.attachments.get(id);
      if (!row || row.projectKey !== projectKey || row.state !== 'ready')
        throw new TeamToolError(
          'not_found',
          `attachment_unknown: ${id} is not a file of ${scope}; list_attachments gives the ids.`,
        );
      if (!allowed.some((card) => card.key === row.taskKey))
        throw new TeamToolError(
          'invalid',
          `attachment_other_card: ${id} is on ${row.taskKey}; a question can name only the files of ${scope}.`,
        );
      found.push({
        id: row.id,
        taskKey: row.taskKey,
        fileName: row.fileName,
        size: row.size,
        mediaType: row.mediaType,
        preview: row.preview,
      });
    }
    // Everyone asked must be able to open every file; only a client asked about an internal card can fail.
    for (const handle of assignees) {
      const person = memberOf(config, handle);
      const viewer = { access: person?.kind === 'human' ? person.access : ('client' as const), handle };
      for (const card of allowed) {
        if (!found.some((file) => file.taskKey === card.key)) continue;
        if (!canReadAttachments(viewer, card))
          throw new TeamToolError(
            'invalid',
            `attachment_not_visible: ${handle} cannot open the files of ${card.key}; ask without them or ask someone who sees the card.`,
          );
      }
    }
    return found;
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

  async withdrawQuestion(
    ctx: ToolContext,
    args: { itemId: string; reason: string },
  ): Promise<{ itemId: string }> {
    return this.guard(async () => {
      await this.caller(ctx, 'withdraw_question');
      const reason = args.reason.trim();
      if (!reason) throw new TeamToolError('invalid', 'The reason is empty.');
      const item = this.ctx.repos.inbox.get(args.itemId);
      if (!item || item.projectKey !== ctx.projectKey || item.kind !== 'question')
        throw new TeamToolError('not_found', `Question ${args.itemId} does not exist in this project.`);
      if (item.source !== ctx.member)
        throw new TeamToolError(
          'forbidden',
          `not_your_question: question ${item.id} was asked by ${item.source}; only the asker withdraws it.`,
        );
      const closed = await this.inbox.closeQuestion(item.id, {
        rule: 'withdrawn',
        by: ctx.member,
        note: reason,
      });
      if (!closed)
        throw new TeamToolError('invalid', `question_closed: question ${item.id} is not waiting any more.`);
      return { itemId: closed.id };
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

  async readProjectDoc(
    ctx: ToolContext,
    args: { doc: ProjectDoc; fromLine?: number; lineCount?: number },
  ): Promise<ProjectDocRead> {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may read the project documents.',
      );
    await this.callerWithRequest(ctx, 'read_project_doc');
    try {
      const read = await this.docWrites.read(ctx.projectKey, ctx.member, args.doc);
      const lines = docLines(read.text ?? '');
      const from = args.fromLine ?? 1;
      return {
        doc: args.doc,
        repo: read.repo.name,
        path: read.path,
        commit: read.commit,
        exists: read.text !== null,
        total_lines: lines.length,
        from_line: from,
        text: lines.slice(from - 1, from - 1 + (args.lineCount ?? MAX_DOC_LINES)).join('\n'),
      };
    } catch (err) {
      throw docToolError(err);
    }
  }

  async writeProjectDocs(
    ctx: ToolContext,
    args: {
      baseCommit: string;
      message: string;
      edits: { doc: ProjectDoc; old_text: string; new_text: string }[];
    },
  ): Promise<ProjectDocWrite> {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may write the project documents.',
      );
    const caller = await this.callerWithRequest(ctx, 'write_project_docs');
    const request = this.inOwnerConversation(ctx, caller, 'write_project_docs');
    let outcome: Awaited<ReturnType<DocWrites['request']>>;
    try {
      outcome = await this.docWrites.request({
        projectKey: ctx.projectKey,
        author: ctx.member,
        requestedBy: request.fromHandle,
        requestId: request.id,
        baseCommit: args.baseCommit,
        message: args.message,
        edits: args.edits,
      });
    } catch (err) {
      // A write that was never queued has no step of its own: the refusal is the step.
      this.operatorSteps.record({
        requestId: request.id,
        action: 'docs_write',
        taskKey: null,
        member: null,
        status: 'refused',
        refusal: refusalOf(err),
      });
      throw docToolError(err);
    }
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
        throw new TeamToolError(
          'invalid',
          'docs_stale: a file changed since the commit you read. Read it again with read_project_doc and show the owner the new text.',
        );
      case 'failed':
        throw new TeamToolError('invalid', `docs_write_failed: ${outcome.failure}: ${outcome.message}`);
    }
  }

  /**
   * The documents are the owners' business: the request the call runs for, when it is in the owner's own
   * conversation (no `with`, no card); otherwise the call is refused and logged as a refused step.
   */
  private inOwnerConversation(
    ctx: ToolContext,
    caller: CallerWithRequest,
    tool: string,
  ): NonNullable<CallerWithRequest['request']> {
    const request = caller.request!;
    const workItem = this.ctx.repos.sessions.get(ctx.sessionId)?.workItem;
    if (
      workItem?.type !== 'general' ||
      workItem.with !== undefined ||
      !isOwner(caller.config, request.fromHandle)
    ) {
      this.recordRefusedWrite(caller, tool);
      throw new TeamToolError(
        'forbidden',
        `${OWNER_ONLY}: ${tool} is for the owner's own conversation with you.`,
      );
    }
    return request;
  }

  async listDecisionCandidates(ctx: ToolContext, args: { limit?: number }) {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may list the decision candidates.',
      );
    await this.callerWithRequest(ctx, 'list_decision_candidates');
    try {
      return this.decisionCandidates.list(ctx.projectKey, config, args.limit);
    } catch (err) {
      throw docToolError(err);
    }
  }

  async markDecisionCandidates(
    ctx: ToolContext,
    args: { items: { item_id: string; verdict: 'recorded' | 'declined' | 'skipped'; decision?: string }[] },
  ) {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may mark the decision candidates.',
      );
    const caller = await this.callerWithRequest(ctx, 'mark_decision_candidates');
    const request = this.inOwnerConversation(ctx, caller, 'mark_decision_candidates');
    return this.recorded<{ marked: number }>(caller, { action: 'decision_offer' }, async () => ({
      marked: this.decisionCandidates.mark(ctx.projectKey, config, request.id, args.items),
    })).catch((err: unknown) => {
      throw toToolError(err);
    });
  }

  async startTask(
    ctx: ToolContext,
    args: { taskKey: string; assignee?: string; despitePrerequisites?: boolean; signalId?: string },
  ) {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may start tasks through this tool.',
      );
    const { signalId, ...startArgs } = args;
    // On a signal the call starts the card's own assignee and nothing else (PM-545).
    if (signalId !== undefined && (args.assignee !== undefined || args.despitePrerequisites !== undefined))
      throw new TeamToolError(
        'invalid',
        'invalid_request: with signal_id start_task takes no assignee and no despite_prerequisites.',
      );
    const caller = await this.callerWithRequest(
      ctx,
      'start_task',
      undefined,
      signalId !== undefined
        ? { signalId, tool: 'start_task', member: null, taskKey: args.taskKey }
        : undefined,
    );
    return this.recorded<Awaited<ReturnType<TeamToolsHandler['startTask']>>>(
      caller,
      { action: 'task_start', taskKey: args.taskKey, madeMember: (result) => result.hired },
      async () => {
        const operator = memberOf(config, ctx.member)!;
        const taskKey = this.validTaskKey(ctx, args.taskKey);
        const card = signalId !== undefined ? this.tasks.get(ctx.projectKey, taskKey) : null;
        if (card && !card.assignee)
          throw new TeamToolError('invalid', 'invalid_request: the card has no assignee to start.');
        const result = await this.taskStarts.start(ctx.projectKey, taskKey, {
          ...startArgs,
          actor: aiActor(ctx.member),
          author: { name: operator.displayName, email: `${ctx.member}@projectman.local` },
          ...(card
            ? {
                // The assignee as the signal named it; a card that moved on meanwhile is left alone.
                assignee: card.assignee!,
                stillWanted: (now: Task) => now.assignee === card.assignee && now.stageId === card.stageId,
              }
            : { startSetters: true, sponsor: caller.request!.fromHandle }),
        });
        return {
          task_key: result.task.key,
          session_id: result.session?.id ?? null,
          hired: result.hired?.handle ?? null,
          assignee: result.task.assignee,
          ...(result.awaiting ? { awaiting: result.awaiting } : {}),
          ...(result.seniorWait ? { senior_wait: result.seniorWait } : {}),
        };
      },
    ).catch((err: unknown) => {
      if (err instanceof DomainError) {
        const converted = toToolError(err) as TeamToolError;
        throw new TeamToolError(converted.code, `${err.code}: ${converted.message}`);
      }
      throw toToolError(err);
    });
  }

  async startMember(
    ctx: ToolContext,
    args: { member: string; text: string; taskKey?: string; signalId?: string },
  ): Promise<MemberStartResult> {
    const config = await this.projects.config(ctx.projectKey);
    if (!isOperator(memberOf(config, ctx.member)))
      throw new TeamToolError(
        'forbidden',
        'operator_only: only the Operator may start members through this tool.',
      );
    const who = await this.callerWithRequest(
      ctx,
      'start_member',
      undefined,
      args.signalId !== undefined
        ? {
            signalId: args.signalId,
            tool: 'start_member',
            member: args.member,
            taskKey: args.taskKey ?? null,
          }
        : undefined,
    );
    return this.recorded<MemberStartResult>(
      who,
      { action: 'task_start', taskKey: args.taskKey ?? null, member: args.member },
      async () => {
        // The message is the card's: the member needs a role on it (PM-545).
        const card = args.taskKey
          ? this.tasks.get(ctx.projectKey, this.validTaskKey(ctx, args.taskKey))
          : null;
        const member = memberOf(config, args.member);
        if (!member) throw new TeamToolError('not_found', `Unknown team member: ${args.member}.`);
        if (member.kind === 'human')
          throw new TeamToolError(
            'invalid',
            `not_ai_member: ${args.member} is a person; ask them with ask_human.`,
          );
        if (isOperator(member)) throw new TeamToolError('invalid', 'cannot_start_self');
        if (card && !recipientHasCardRole(this.ctx, config, card, member.handle))
          throw new TeamToolError(
            'invalid',
            `not_card_role: ${member.handle} has no role on ${card.key}; start a member who holds it, or use start_task.`,
          );
        const { message, recipients } = await this.messaging
          .sendReporting(
            ctx.projectKey,
            ctx.member,
            { to: [member.handle], text: args.text, taskKey: card?.key ?? null },
            {
              actor: aiActor(ctx.member),
              sessionId: ctx.sessionId,
              kind: 'action',
              operatorRequest: who.request!.id,
              awaitWake: true,
            },
          )
          .catch((err: unknown) => {
            throw toMessageToolError(err);
          });
        return { messageId: message.id, recipient: recipients[0]! };
      },
    );
  }

  /**
   * `caller`, plus the owner request the guard let the Operator's call through on (null for any other
   * caller and for a reading tool with none open). The step log must use this very request: opening it
   * again could find it expired between the guard and the write.
   */
  private async callerWithRequest(
    ctx: ToolContext,
    tool: string,
    signal?: { ids: string[]; to: string[] },
    signalStep?: SignalStep,
  ): Promise<CallerWithRequest> {
    const config = await this.projects.config(ctx.projectKey);
    const member = memberOf(config, ctx.member);
    if (member?.kind !== 'ai')
      throw new TeamToolError(
        'forbidden',
        `${ctx.member} is not an active AI member of this team, so the team tools are not available.`,
      );
    const operator = isOperator(member);
    const request = operator ? this.operatorRequests.openFor(ctx.sessionId) : null;
    const guest = operator ? this.guestOf(ctx, config, request) : null;
    if (signal) {
      // Signals are the owners' business: never from a guest conversation, never to anyone else.
      if (
        tool !== 'send_message' ||
        !operator ||
        guest ||
        signal.ids.length === 0 ||
        signal.to.some((handle) => !isOwner(config, handle))
      )
        throw new TeamToolError(
          'invalid',
          'invalid_request: only the Operator may present signals to owners.',
        );
      for (const id of signal.ids) this.operatorSignals.presentation(ctx.projectKey, id);
    }
    if (!operator) return { config, request: null, guest: null };
    if (guest) {
      // A conversation with someone who is not an owner only reads and answers (PM-475).
      if (!OPERATOR_GUEST_TOOLS.has(tool)) {
        this.recordRefusedWrite({ config, request, guest }, tool);
        throw new TeamToolError(
          'forbidden',
          `${OWNER_ONLY}: ${tool} is not for a conversation with ${guest.handle}.`,
        );
      }
      return { config, request, guest };
    }
    if (OPERATOR_NEVER_TOOLS.has(tool))
      throw new TeamToolError(
        'forbidden',
        `operator_never: ${tool} is not for the Operator. Decisions of other members, hand-overs and publishing outside are not its to do; tell the owner what you found.`,
      );
    if (signalStep && request) {
      // An open owner request authorizes the call; the signal is only logged with the step.
      if (this.ctx.repos.operatorSignals.get(signalStep.signalId)?.projectKey !== ctx.projectKey)
        throw new TeamToolError('invalid', 'invalid_request: unknown signal in this project.');
      return { config, request, guest: null, signalId: signalStep.signalId };
    }
    // Screening an AI member's question is the Operator's standing duty: no owner request, no step.
    if (OPERATOR_SCREENING_TOOLS.has(tool)) return { config, request, guest: null };
    if (!request && !OPERATOR_READ_TOOLS.has(tool) && !signal) {
      if (signalStep) return this.signalStepCaller(ctx, config, signalStep);
      throw new TeamToolError(
        'forbidden',
        `operator_no_request: ${tool} writes, and the Operator writes only for an open request of an owner. ` +
          "There is none (its round is over or it timed out); wait for the owner's next message.",
      );
    }
    return { config, request, guest: null };
  }

  /**
   * The Operator's own step on a system signal without an owner's request (PM-545): the project's level,
   * the signal's targets and the signal's budget of steps decide; a refusal is no step. The step then hangs
   * on the session's signal round.
   */
  private async signalStepCaller(
    ctx: ToolContext,
    config: ProjectConfig,
    step: SignalStep,
  ): Promise<CallerWithRequest> {
    const level = operatorWatchOf(config);
    const refuse: (code: string, text: string) => never = (code, text) => {
      throw new TeamToolError('forbidden', `${code}: ${text}`);
    };
    const noRequest = `${step.tool} writes, and the Operator writes only for an open request of an owner`;
    if (level === 'report')
      refuse('operator_no_request', `${noRequest}; this project lets it only report signals.`);
    const { signal, allowed } = await this.operatorSignals
      .stepTargets(ctx.projectKey, step.signalId)
      .catch((err: unknown) => {
        if (err instanceof DomainError) throw new TeamToolError('invalid', `${err.code}: ${err.message}`);
        throw err;
      });
    const refusal = operatorSignalStepRefusal({
      level,
      kind: signal.kind,
      tool: step.tool,
      target: { member: step.member, taskKey: step.taskKey },
      allowed,
      stepsAt: this.operatorSteps
        .ofSignal(signal.id)
        .filter((s) => s.status !== 'refused')
        .map((s) => s.at),
      now: isoNow(this.ctx),
    });
    if (refusal?.code === 'operator_no_request')
      refuse(
        'operator_no_request',
        `${noRequest}. At level ${level} a ${signal.kind} signal does not allow this call (${refusal.reason}).`,
      );
    if (refusal)
      refuse(
        'operator_signal_budget',
        refusal.reason === 'used'
          ? 'this signal has no step left; tell the owner what you did and what became of it.'
          : `the last step on this signal was less than ${OPERATOR_SIGNAL_STEP_GAP_MINUTES} minutes ago; retry after ${refusal.retryAt}.`,
      );
    // The budget counts logged steps, and a step is logged only after it ran: a call that arrives while
    // another step on this signal is running would pass the count too. No await between the count and here.
    if (this.signalStepsRunning.has(signal.id))
      refuse(
        'operator_signal_budget',
        'a step on this signal is still running; wait for its result before you take another.',
      );
    this.signalStepsRunning.add(signal.id);
    return {
      config,
      request: this.operatorRequests.openRound(ctx.projectKey, ctx.sessionId),
      guest: null,
      signalId: signal.id,
      holdsSignalStep: true,
    };
  }

  /**
   * The person the Operator's session talks with when they are not an owner (a `with` conversation, or a
   * request of someone who is no owner), as their view of the project; null in the owner's conversation.
   */
  private guestOf(
    ctx: ToolContext,
    config: ProjectConfig,
    request: ReturnType<OperatorRequests['openFor']>,
  ): GuestView | null {
    const workItem = this.ctx.repos.sessions.get(ctx.sessionId)?.workItem;
    const handle =
      (workItem?.type === 'general' ? workItem.with : undefined) ??
      (request && !isOwner(config, request.fromHandle) ? request.fromHandle : undefined);
    if (handle === undefined) return null;
    const person = memberOf(config, handle);
    // Someone no longer in the team sees nothing: the narrowest access there is.
    const access = person?.kind === 'human' ? person.access : 'client';
    return { handle, viewer: { access, handle } };
  }

  /** Logs a write the Operator was refused in a guest's conversation as a refused step of its request. */
  private recordRefusedWrite(who: CallerWithRequest, tool: string, member?: string): void {
    const action = OPERATOR_TOOL_ACTIONS[tool];
    if (!action || !who.request) return;
    this.operatorSteps.record({
      requestId: who.request.id,
      action,
      taskKey: null,
      member: member && memberOf(who.config, member) ? member : null,
      status: 'refused',
      refusal: { code: 'operator_owner_only', message: `${tool} is for the project owner's request` },
    });
  }

  /**
   * Runs the Operator's write and logs it as one step of its open request, done or refused (PM-463).
   * Any other caller (`request` null), and a call that is no step (`step` null), just runs.
   */
  private async recorded<T>(
    { config, request, signalId, holdsSignalStep }: CallerWithRequest,
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
    try {
      if (!step || !request) return await run();
      const target = {
        action: step.action,
        taskKey: step.taskKey && TaskKey.safeParse(step.taskKey).success ? step.taskKey : null,
        member: step.member && memberOf(config, step.member) ? step.member : null,
        ...(signalId ? { signalId } : {}),
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
      // An own step on a signal: the signal is shown to the Operator again if its case still stands later (PM-545).
      if (signalId && request.source === 'signal') this.operatorSignals.stepTaken(signalId);
      return result;
    } finally {
      // The step is logged now (or the call failed): the signal's slot is free, the budget counts it.
      if (holdsSignalStep && signalId) this.signalStepsRunning.delete(signalId);
    }
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

  /**
   * The card a message with no card of its own is the reply to (PM-504): a member working in a general
   * session (no card) is often answering or forwarding a card's message that was typed into that session.
   * That is the latest recent message delivered to the member in a general session (its route for the
   * member is general: the project manager's and the Operator's card messages always are), when it is
   * about a card. A message that went to the member's own card session says nothing about this one.
   */
  private repliedCardOf(ctx: ToolContext, config: ProjectConfig): string | null {
    if (ctx.taskKey) return null;
    const workItem = this.ctx.repos.sessions.get(ctx.sessionId)?.workItem;
    if (workItem?.type !== 'general') return null;
    const member = memberOf(config, ctx.member);
    const cutoff = this.ctx.now().getTime() - RELAY_WINDOW_MS;
    const latest = this.ctx.repos.messages
      .list(ctx.projectKey, { member: ctx.member, limit: 20 })
      .findLast((message) => {
        const at = message.receipts?.find((r) => r.handle === ctx.member)?.deliveredAt;
        return (
          message.to.includes(ctx.member) &&
          at &&
          Date.parse(at) >= cutoff &&
          sessionWorkItemOf(member, messageRoute(message, ctx.member)).type === 'general'
        );
      });
    return latest?.taskKey ?? null;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toToolError(err);
    }
  }
}
