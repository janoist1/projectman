import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type {
  AddRelationRef,
  Attachment,
  DeveloperLevelRequest,
  MemberHandle,
  MessageKind,
  RelationsChange,
  TaskRelation,
  MemberView,
  QuestionOptionInput,
  Task,
  TaskDetail,
  TaskKind,
  TaskPriority,
  TaskStatus,
  ThemeCard,
  ThemeProgress,
  TimelineEvent,
  Visibility,
  WorkDoing,
  WorkItemRef,
  BoundaryRequest,
  BoundaryGrant,
  SubmitBoundaryRequest,
  DecideBoundaryRequest,
} from '@projectman/shared';
import type { CardQuestion, CardWorker } from './context';
import type { PullRequestInfo, RemoteState } from './github';

/**
 * Team tools exposed to AI members through an MCP server ("team"), replacing the
 * desktop app's SendMessage. Tool names seen by Claude: mcp__team__<tool>.
 * The MCP transport lives in src/mcp; the behaviour is implemented by the domain.
 */

/** Why a sent team message waits before it reaches an AI recipient (PM-144). */
export type SentMessageHold = 'refinement_turn' | 'fix_limit' | 'full_test' | 'pause' | 'restart';

/** What happens to a sent team message for one recipient, decided when it is sent (PM-144). */
export interface SentMessageRecipient {
  handle: MemberHandle;
  /**
   * inbox: a person, who reads it in the app. typed_now: the AI recipient's session is idle and gets it now.
   * after_turn: its session is in a turn (starting, working, waiting_permission, waiting_input) and gets it when the turn ends.
   * wake: no session runs for it; one starts or resumes with it (admission may defer that). held: kept back, `hold` says why.
   */
  delivery: 'inbox' | 'typed_now' | 'after_turn' | 'wake' | 'held' | 'next_input';
  /** Only with delivery 'held'. */
  hold?: SentMessageHold;
  waitingPermission?: { inboxItemId: string; deciders: string[]; since: string };
}

export interface ToolContext {
  sessionId: string;
  projectKey: string;
  /** The AI member calling the tool. */
  member: MemberHandle;
  /** Task of the session's work item, if any. */
  taskKey: string | null;
}

export interface ListTasksInput {
  status?: 'open' | TaskStatus;
  stage?: string;
  assignee?: string;
  limit?: number;
}

export type TaskSummary = Pick<
  Task,
  'key' | 'title' | 'stageId' | 'status' | 'assignee' | 'labels' | 'updatedAt'
> & {
  /** `theme` for a theme (PM-192); absent for a task. */
  kind?: TaskKind;
  /** Present only when a person set a priority. */
  priority?: TaskPriority;
};

/**
 * What get_task shows of a task: the task with its timeline, and where its work happens. The
 * repository is not the task's own `repo` alone: a task of a one-repository project works in that
 * repository (`effectiveRepo` in the shared package). Both fields are optional for handlers that
 * know nothing about repositories.
 */
export interface TaskToolDetail extends TaskDetail {
  /** The repository the work happens in; null when there is none. */
  effectiveRepo?: string | null;
  /** The project has several repositories and the task names none: a person has to choose. */
  repoChoiceNeeded?: boolean;
  /** The first page of the task's readable attachments (oldest first); the rest with list_attachments. */
  attachments?: AttachmentPage;
  /**
   * Ids of the team messages for the caller that were not typed into its session yet: their
   * timeline lines say that the full text is on its way (PM-180).
   */
  undeliveredMessageIds?: string[];
  /**
   * The caller's own messages on this card that are not typed into every AI recipient's session yet
   * (PM-144), with the recipients still waiting, in the order the message names them.
   */
  pendingSentMessages?: { messageId: string; handles: MemberHandle[] }[];
  /** The timeline event asked for by id (get_task event_id): its whole text is shown instead of the task. */
  event?: TimelineEvent;
  /** The task's relations to other cards, both directions (PM-192); omitted by handlers that know none. */
  relations?: TaskRelation[];
  /** The theme the card belongs to, its own or its parent's (PM-192); omitted when it has none. */
  theme?: Pick<Task, 'key' | 'title' | 'stageId' | 'status'>;
  /** On a theme: the cards that belong to it, collecting cards with their subtasks, and how far it is (PM-192). */
  themeCards?: ThemeCard[];
  themeProgress?: ThemeProgress;
  /** Ids of the sessions that work on the card now (PM-249, `SessionOrchestrator.cardWorkers`). */
  workingSessionIds?: string[];
  cardWorkers?: CardWorker[];
  /** The card's questions (PM-249), as the brief lists them (`QUESTION_LIMIT`). */
  cardQuestions?: CardQuestion[];
}

/** A page of a task's readable attachments, oldest first. */
export interface AttachmentPage {
  attachments: Attachment[];
  /** How many readable attachments the task has in all. */
  total: number;
  /** Index of the first one on this page. */
  offset: number;
}

/** read_attachment: where the agent opens the file with its own tools. */
export interface LocatedAttachmentForTool {
  attachment: Attachment;
  /** Absolute path of the stored file. */
  path: string;
  /** The file is in the attachment directory of the session's own task, which it reads without asking. */
  readableWithoutAsking: boolean;
}

/** A refused destination the session may ask for with submit_boundary_request. */
export interface NetworkDenial {
  operationId: string;
  /** `host:port`. */
  destination: string;
  refusedAt: string;
  /** Asking (and the allowance it may open) is possible until then. */
  expiresAt: string;
}

/** The result of `publish_task_branch`. */
export interface PublishedTaskBranch {
  repo: string;
  branch: string;
  commit: string;
  /** The remote branch already had this commit, so nothing was uploaded. */
  alreadyPublished: boolean;
  pullRequest: PullRequestInfo;
  /** False when the branch's open pull request already existed. */
  pullRequestCreated: boolean;
  task: Task;
}

/** The result of `get_remote_state`. */
export interface PublishedTaskState extends RemoteState {
  taskKey: string;
  /** The member who published the task's pull request; null when none did. */
  publishedBy: string | null;
}

/** The input of `take_screenshots` (PM-351), as the domain gets it from the validated tool arguments. */
export interface TakeScreenshotsInput {
  /** The scenario module, relative to the session's working directory or absolute. */
  scenario: string;
  widths?: number[];
  fullPage?: boolean;
  scale?: 1 | 2;
  /** The scenario's own `--timeout`, in seconds. */
  timeoutSeconds?: number;
  seed?: 'demo' | 'none';
}

export type ScreenshotRunStatus = 'queued' | 'running' | 'done' | 'failed';
export type ScreenshotFailure = 'scenario' | 'usage' | 'timeout' | 'stopped' | 'sandbox';

/** A screenshot run the server made for a session with `npm run shots` (PM-351). */
export interface ScreenshotRun {
  runId: string;
  status: ScreenshotRunStatus;
  /** ISO time. */
  startedAt: string;
  finishedAt?: string;
  /** Images the run wrote or rewrote below `<session folder>/shots`, absolute paths, at most 100. */
  files: string[];
  exitCode?: number | null;
  /** Only with status `failed`. */
  failure?: ScreenshotFailure;
  /** The end of the output, ANSI removed, at most 4000 characters (`outputTail`, full-test/output.ts). */
  outputTail?: string;
}

export interface TeamToolsHandler {
  /**
   * take_screenshots (PM-351): starts `npm run shots` for the calling session in the server's sandbox, and
   * waits up to 40 seconds for its end. The answer is the run; a run that is not over yet is asked again
   * with `getScreenshotRun`.
   */
  takeScreenshots(ctx: ToolContext, input: TakeScreenshotsInput): Promise<ScreenshotRun>;
  /** get_screenshot_run (PM-351): a run of the calling session; waits up to 40 seconds if it is not over. */
  getScreenshotRun(ctx: ToolContext, runId: string): Promise<ScreenshotRun>;
  submitBoundaryRequest(ctx: ToolContext, args: SubmitBoundaryRequest): Promise<BoundaryRequest>;
  getBoundaryRequest(
    ctx: ToolContext,
    args: { requestId: string },
  ): Promise<{ request: BoundaryRequest; grant: BoundaryGrant | null }>;
  decideBoundaryRequest(
    ctx: ToolContext,
    args: DecideBoundaryRequest & { requestId: string },
  ): Promise<BoundaryRequest>;
  /**
   * decide_permission_request: the AI decider answers a member's tool question delegated to it
   * (PM-169), or hands it to a person (`escalate`). The reason is required.
   */
  decidePermissionRequest(
    ctx: ToolContext,
    args: { requestId: string; decision: 'allow' | 'deny' | 'escalate'; reason: string },
  ): Promise<{ requestId: string; decision: 'allow' | 'deny' | 'escalate'; outcome: string }>;
  /**
   * decide_fix_limit (PM-262): the AI member who decides (the lead, or the planner it asked) decides how a
   * card that reached its fix round limit goes on. The reason is required.
   */
  decideFixLimit(
    ctx: ToolContext,
    args: { taskKey: string; decision: 'continue' | 'replan' | 'to_owner'; reason: string },
  ): Promise<{ phase: 'released' | 'replan' | 'owner' }>;
  /** list_network_denials: destinations the egress proxy refused this session (PM-140), newest first. */
  listNetworkDenials(ctx: ToolContext): Promise<NetworkDenial[]>;
  /** list_tasks: visible board tasks, newest update first. */
  listTasks(ctx: ToolContext, args: ListTasksInput): Promise<TaskSummary[]>;
  /** send_message: deliver a message to team members (AI sessions or human inboxes). */
  sendMessage(
    ctx: ToolContext,
    args: { to: MemberHandle[]; text: string; taskKey?: string; kind: MessageKind },
  ): Promise<{
    messageId: string;
    deliveredTo: MemberHandle[];
    /** What happens to the message for each recipient, in the order of `to` (PM-144). */
    recipients: SentMessageRecipient[];
    /** Only the recipients that get the message somewhere else than on its own card (PM-182). */
    routed?: { handle: MemberHandle; workItem: WorkItemRef }[];
  }>;
  /** list_members: roster with handles, roles and status. */
  listMembers(ctx: ToolContext): Promise<MemberView[]>;
  /**
   * get_task: task with recent timeline, and where its work happens. With `eventId`, the detail
   * also carries that event of the task (not_found when the task has no such event).
   */
  getTask(ctx: ToolContext, args: { taskKey: string; eventId?: string }): Promise<TaskToolDetail>;
  /**
   * update_task: rewrite the title or description, set or clear the repository, add or remove
   * labels (under the labels' rules), add a note, move stage (gates enforced). Everything else is
   * recorded before the stage move, so labels added in the same call count for the target stage's
   * gate.
   */
  updateTask(
    ctx: ToolContext,
    args: {
      taskKey: string;
      stageId?: string;
      addLabels?: string[];
      removeLabels?: string[];
      note?: string;
      title?: string;
      description?: string;
      /** A repository of the project; null clears it. */
      repo?: string | null;
      /** Relations to other cards (PM-192): removals first, then additions, in the same all-or-nothing call. */
      relations?: RelationsChange;
      /** The theme the card belongs to (PM-192); null removes it. */
      themeKey?: string | null;
      /** The recommended developer (PM-347); only whoever `canSetDeveloperLevel` may set it. */
      developerLevel?: DeveloperLevelRequest;
    },
  ): Promise<{ task: Task }>;
  /**
   * create_task: a new task in the pipeline's first (queue) stage, unassigned and attributed
   * to the calling member; humans prioritise it.
   */
  createTask(
    ctx: ToolContext,
    args: {
      title: string;
      description?: string;
      labels?: string[];
      visibility?: Visibility;
      parentKey?: string;
      /** Relations the new card starts with (PM-192). */
      relations?: AddRelationRef[];
      /** `theme` creates a theme (PM-192). */
      kind?: TaskKind;
      /** The theme the new card belongs to. */
      themeKey?: string;
      /** The recommended developer (PM-347). */
      developerLevel?: DeveloperLevelRequest;
    },
  ): Promise<{ task: Task }>;
  /** link_pull_request: attach a GitHub PR to the task. */
  linkPullRequest(
    ctx: ToolContext,
    args: { taskKey: string; repo: string; number: number },
  ): Promise<{ task: Task }>;
  /**
   * publish_task_branch (PM-142, managed VM profile only): puts the caller's own task branch at the
   * named commit on GitHub through the VM's publishing identity, and opens its pull request once.
   * Everything but the commit, the title and the body comes from the server's records.
   */
  publishTaskBranch(
    ctx: ToolContext,
    args: { taskKey?: string; commit: string; title?: string; body?: string },
  ): Promise<PublishedTaskBranch>;
  /** get_remote_state (PM-142): the remote default branch and task branch heads, their distance and the pull requests. */
  getRemoteState(ctx: ToolContext, args: { taskKey: string }): Promise<PublishedTaskState>;
  /**
   * ask_human: create a question in a human's inbox; the answer arrives later as a team message.
   * The question is written for a non-specialist. Each option is a label, or a label with its
   * `consequence` (what happens if it is picked). `recommended` is the exact label of one option,
   * with its one-sentence `recommendationReason`; `details` is markdown technical background that
   * the inbox shows folded. All of these are optional.
   */
  askHuman(
    ctx: ToolContext,
    args: {
      question: string;
      options?: QuestionOptionInput[];
      taskKey?: string;
      to?: MemberHandle[];
      recommended?: string;
      recommendationReason?: string;
      details?: string;
    },
  ): Promise<{ inboxItemId: string }>;
  /**
   * set_current_work (PM-238): what the calling session's member does on its own card now. It has no
   * task argument: it always concerns the caller's session, which must be a task session in a round.
   * Only the latest is kept; it is cleared when the round ends. `recorded` is false when the session
   * was not in a round, so nothing was written.
   */
  setCurrentWork(ctx: ToolContext, args: WorkDoing): Promise<{ recorded: boolean }>;
  /** save_memory: append a durable learning to this member's memory. */
  saveMemory(ctx: ToolContext, args: { note: string }): Promise<{ ok: true }>;
  /** list_attachments: a page of the task's attachments, oldest first. */
  listAttachments(
    ctx: ToolContext,
    args: { taskKey: string; offset?: number; limit?: number },
  ): Promise<AttachmentPage>;
  /**
   * read_attachment: where a ready attachment is stored, after the same access check as the REST
   * routes. The content is neither read into the answer nor ever run.
   */
  readAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<LocatedAttachmentForTool>;
  /**
   * attach_file: attaches a regular file from the calling session's working directory (as the
   * server recorded it; never a directory the caller names) in the caller's name. The path is
   * relative to that directory or absolute inside it.
   */
  attachFile(ctx: ToolContext, args: { taskKey: string; path: string }): Promise<{ attachment: Attachment }>;
  /** delete_attachment: deletes an attachment under the REST rules (an AI member deletes its own). */
  deleteAttachment(
    ctx: ToolContext,
    args: { taskKey: string; attachmentId: string },
  ): Promise<{ attachmentId: string; fileName: string | null }>;
}

/** Errors thrown by the handler; the MCP layer turns them into tool errors. */
export class TeamToolError extends Error {
  readonly code: 'not_found' | 'forbidden' | 'invalid' | 'gate_blocked';
  constructor(code: 'not_found' | 'forbidden' | 'invalid' | 'gate_blocked', message: string) {
    super(message);
    this.code = code;
    this.name = 'TeamToolError';
  }
}

export interface McpModuleOptions {
  handler: TeamToolsHandler;
  /** Maps the token in /mcp/:token to the calling session; null = reject. */
  resolveContext(token: string): ToolContext | null;
  logger: FastifyBaseLogger;
}

export interface McpModule {
  /** Registers the MCP endpoint at /mcp/:token (localhost only). */
  registerRoutes(app: FastifyInstance): void;
}
