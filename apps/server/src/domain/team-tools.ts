import type {
  MemberToolsHandler,
  TaskToolsHandler,
  AttachmentToolsHandler,
  ScreenshotToolsHandler,
  MergeToolsHandler,
  FeedbackToolsHandler,
  BoundaryToolsHandler,
} from '../contracts';
import {
  type ToolCaller,
  toToolError,
  toFileToolError,
  refusalOf,
  isOwner,
  OWNER_ONLY,
  type CallerWithRequest,
  type SignalStep,
  type GuestView,
} from '../mcp/caller';
import {
  canReadAttachments,
  ERROR_CODES,
  ownerHandles,
  isOperator,
  memberOf,
  messageRoute,
  QUESTION_SCREENING_MINUTES,
  questionChoices,
  questionApprovalLabel,
  questionPayloadOf,
  sessionWorkItemOf,
} from '@projectman/shared';
import type {
  Actor,
  Attachment,
  InboxOption,
  MemberView,
  OperatorAction,
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
import { TeamToolError } from '../contracts';
import type {
  AttachmentPage,
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
import type { DomainContext } from './context';
import { DomainError } from './errors';
import type { FixLimitDecision, FixLimitWatch } from './fix-limit';
import type { HandoffService } from './handoffs';
import type { GithubSync } from './github-sync';
import { ANSWER_OPTION, sponsorOrOwners } from './inbox';
import type { InboxService } from './inbox';
import type { Messaging } from './messaging';
import { recipientHasCardRole } from './messaging';
import type { OpenQuestionLabel } from './open-question-label';
import type { OperatorRequests, OperatorSteps } from './operator-requests';
import type { MessageAttachmentService } from './message-attachments';
import type { OperatorActions } from './operator-actions';
import type { QuestionScreening } from './question-screening';
import type { TaskStarts } from './admission';
import type { OperatorOperation, ProjectDoc } from '@projectman/shared';
import type { ProjectDocRead, ProjectDocWrite } from '../contracts';
import { docLines } from './doc-edits';
import type { DecisionCandidates } from './decision-candidates';
import type { DocWrites } from './doc-writes';
import type { ProjectService } from './projects';
import type { ProjectState } from './project-state';
import type { SessionOrchestrator } from './sessions';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { RELAY_WINDOW_MS } from './pm-reply-relay';
import { aiActor, unique } from './util';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

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

/**
 * The team tools behind the MCP server (mcp__team__*): they check the arguments, call the
 * domain services and put their refusals in words the agent reads. Every action is attributed
 * to the calling AI member.
 * Module handlers are collected through forwarding methods; new tools belong in their module's
 * mcp/<module>/handler.ts, never in this collector. Unmoved tools leave with their module's pass.
 */
export class TeamToolsService implements TeamToolsHandler {
  private readonly calls: ToolCaller;
  private readonly tools: {
    members: MemberToolsHandler;
    tasks: TaskToolsHandler;
    attachments: AttachmentToolsHandler;
    merges: MergeToolsHandler;
    feedback: FeedbackToolsHandler;
    screenshots: ScreenshotToolsHandler;
    boundary: BoundaryToolsHandler;
  };
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
    return this.tools.boundary.submitBoundaryRequest(ctx, args);
  }
  async getBoundaryRequest(ctx: ToolContext, args: { requestId: string }) {
    return this.tools.boundary.getBoundaryRequest(ctx, args);
  }
  async decideBoundaryRequest(ctx: ToolContext, args: DecideBoundaryRequest & { requestId: string }) {
    return this.tools.boundary.decideBoundaryRequest(ctx, args);
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
  private readonly operatorActions: OperatorActions;
  private readonly questionScreening: Pick<QuestionScreening, 'enqueue' | 'enabled' | 'cannotScreen'>;
  private readonly taskStarts: TaskStarts;
  private readonly ctx: DomainContext;
  private readonly sessions: Pick<SessionOrchestrator, 'setDoing'>;
  private readonly projects: ProjectService;
  private readonly releases: Pick<import('./releases').ReleaseService, 'preview' | 'propose' | 'check'>;
  private readonly tasks: TaskService;
  private readonly messaging: Messaging;
  private readonly inbox: InboxService;
  private readonly openQuestionLabel: OpenQuestionLabel;
  private readonly fixLimit: Pick<FixLimitWatch, 'decide'>;
  private readonly handoffs: Pick<HandoffService, 'recordNote'>;
  private readonly timeline: TimelineService;
  private readonly memory: MemberMemoryStore;
  private readonly github: GithubService;
  private readonly githubSync: GithubSync;
  private readonly messageAttachments: Pick<
    MessageAttachmentService,
    'assertCanUpload' | 'upload' | 'delete'
  >;

  constructor(deps: {
    calls: ToolCaller;
    tools: {
      members: MemberToolsHandler;
      tasks: TaskToolsHandler;
      attachments: AttachmentToolsHandler;
      merges: MergeToolsHandler;
      feedback: FeedbackToolsHandler;
      screenshots: ScreenshotToolsHandler;
      boundary: BoundaryToolsHandler;
    };
    projectState: ProjectState;
    ctx: DomainContext;
    /** The session service: set_current_work records the sentence on the caller's session. */
    sessions: Pick<SessionOrchestrator, 'setDoing'>;
    projects: ProjectService;
    /** The instance's releases (PM-491): propose_release. */
    releases: Pick<import('./releases').ReleaseService, 'preview' | 'propose' | 'check'>;
    tasks: TaskService;
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
    /** The files sent with team messages (PM-516, PM-520). */
    messageAttachments: Pick<MessageAttachmentService, 'assertCanUpload' | 'upload' | 'delete'>;
    /** The owner's requests to the Operator (PM-463): its writes need an open one. */
    operatorRequests: Pick<OperatorRequests, 'openFor' | 'roundFor' | 'openRound'>;
    /** The Operator's step log (PM-463). */
    operatorSteps: Pick<OperatorSteps, 'record' | 'ofSignal'>;
    operatorActions: OperatorActions;
    /** The Operator's screening of AI members' questions (PM-558): `ask_human` hands a new question to it. */
    questionScreening: Pick<QuestionScreening, 'enqueue' | 'enabled' | 'cannotScreen'>;
    taskStarts: TaskStarts;
    /** The Operator's project documents (PM-495): `read_project_doc` and `write_project_docs`. */
    docWrites: Pick<DocWrites, 'read' | 'request'>;
    /** The owners' answers that may be decisions (PM-496). */
    decisionCandidates: Pick<DecisionCandidates, 'list' | 'mark'>;
  }) {
    this.calls = deps.calls;
    this.tools = deps.tools;
    this.projectState = deps.projectState;
    this.docWrites = deps.docWrites;
    this.decisionCandidates = deps.decisionCandidates;
    this.operatorRequests = deps.operatorRequests;
    this.operatorSteps = deps.operatorSteps;
    this.operatorActions = deps.operatorActions;
    this.questionScreening = deps.questionScreening;
    this.taskStarts = deps.taskStarts;
    this.ctx = deps.ctx;
    this.sessions = deps.sessions;
    this.projects = deps.projects;
    this.releases = deps.releases;
    this.tasks = deps.tasks;
    this.messaging = deps.messaging;
    this.inbox = deps.inbox;
    this.openQuestionLabel = deps.openQuestionLabel;
    this.fixLimit = deps.fixLimit;
    this.handoffs = deps.handoffs;
    this.timeline = deps.timeline;
    this.memory = deps.memory;
    this.github = deps.github;
    this.githubSync = deps.githubSync;
    this.messageAttachments = deps.messageAttachments;
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
    return this.tools.members.listMembers(ctx);
  }

  /**
   * A task key of the caller's project that the guest may see: a card they may not see does not exist
   * for them (PM-475). Without a guest (any other caller) it is `validTaskKey`.
   */
  private visibleTaskKey(ctx: ToolContext, guest: GuestView | null, taskKey: string): string {
    return this.calls.visibleTaskKey(ctx, guest, taskKey);
  }

  async listTasks(ctx: ToolContext, args: ListTasksInput): Promise<TaskSummary[]> {
    return this.tools.tasks.listTasks(ctx, args);
  }

  async getTask(ctx: ToolContext, args: { taskKey: string; eventId?: string }): Promise<TaskToolDetail> {
    return this.tools.tasks.getTask(ctx, args);
  }

  async listAttachments(
    ctx: ToolContext,
    args: { taskKey: string; offset?: number; limit?: number },
  ): Promise<AttachmentPage> {
    return this.tools.attachments.listAttachments(ctx, args);
  }

  async readAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<LocatedAttachmentForTool> {
    return this.tools.attachments.readAttachment(ctx, args);
  }

  async readMessageAttachment(
    ctx: ToolContext,
    args: { attachmentId: string },
  ): Promise<MessageAttachmentReading> {
    return this.tools.attachments.readMessageAttachment(ctx, args);
  }

  // ---- feedback marks (PM-512, processors only) ----

  async getFeedbackList(ctx: ToolContext, args: { status: 'todo' | 'open' | 'all'; limit: number }) {
    return this.tools.feedback.getFeedbackList(ctx, args);
  }

  async getFeedbackMark(ctx: ToolContext, args: { markId: string }) {
    return this.tools.feedback.getFeedbackMark(ctx, args);
  }

  async replyFeedback(ctx: ToolContext, args: { markId: string; body: string }) {
    return this.tools.feedback.replyFeedback(ctx, args);
  }

  async createTaskFromFeedback(
    ctx: ToolContext,
    args: { markId: string; title: string; description: string; visibility?: Visibility; reply?: string },
  ) {
    return this.tools.feedback.createTaskFromFeedback(ctx, args);
  }

  async linkFeedback(ctx: ToolContext, args: { markId: string; taskKey: string; reply?: string }) {
    return this.tools.feedback.linkFeedback(ctx, args);
  }

  async forwardFeedback(ctx: ToolContext, args: { markId: string; reason: string; reply: string }) {
    return this.tools.feedback.forwardFeedback(ctx, args);
  }

  async closeFeedback(ctx: ToolContext, args: { markId: string; reply?: string }) {
    return this.tools.feedback.closeFeedback(ctx, args);
  }

  async attachFile(
    ctx: ToolContext,
    args: { taskKey: string; path: string },
  ): Promise<{ attachment: Attachment }> {
    return this.tools.attachments.attachFile(ctx, args);
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
    return this.calls.openSessionFile(ctx, requested, done);
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
    return this.tools.screenshots.takeScreenshots(ctx, input);
  }

  async getScreenshotRun(ctx: ToolContext, runId: string): Promise<ScreenshotRun> {
    return this.tools.screenshots.getScreenshotRun(ctx, runId);
  }

  async deleteAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<{ attachmentId: string; fileName: string | null }> {
    return this.tools.attachments.deleteAttachment(ctx, args);
  }

  async mergeTask(
    ctx: ToolContext,
    args: { taskKey: string; fixConflict?: boolean; resolution?: string },
  ): Promise<{ task: Task }> {
    return this.tools.merges.mergeTask(ctx, args);
  }

  async prioritizeMerge(
    ctx: ToolContext,
    args: { taskKey: string; reason: string },
  ): Promise<{ task: Task; moved: boolean }> {
    return this.tools.merges.prioritizeMerge(ctx, args);
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
    return this.tools.tasks.updateTask(ctx, args);
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
    return this.tools.tasks.createTask(ctx, args);
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
    return this.calls.caller(ctx, tool);
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
    return this.calls.callerWithRequest(ctx, tool, signal, signalStep);
  }

  /** Logs a write the Operator was refused in a guest's conversation as a refused step of its request. */
  private recordRefusedWrite(who: CallerWithRequest, tool: string, member?: string): void {
    return this.calls.recordRefusedWrite(who, tool, member);
  }

  /**
   * Runs the Operator's write and logs it as one step of its open request, done or refused (PM-463).
   * Any other caller (`request` null), and a call that is no step (`step` null), just runs.
   */
  private async recorded<T>(
    who: CallerWithRequest,
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
    return this.calls.recorded(who, step, run, awaitsApproval);
  }

  /** A task key of the caller's project. */
  private validTaskKey(ctx: ToolContext, taskKey: string): string {
    return this.calls.validTaskKey(ctx, taskKey);
  }

  /**
   * The calling session, whose working directory (`cwd`) is as the server recorded it when it
   * started the session. The token names the session; it must still be this member's session in
   * this project.
   */
  private callerSession(ctx: ToolContext): Session {
    return this.calls.callerSession(ctx);
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
    return this.calls.guard(fn);
  }
}
