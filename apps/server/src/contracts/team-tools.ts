import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type {
  AddRelationRef,
  BuiltInRoleId,
  ChecklistCondition,
  DutyId,
  ProjectChecklist,
  RoleConfigurationRead,
  Attachment,
  DeveloperLevelRequest,
  FeedbackMarkDetail,
  FeedbackMarkView,
  FeedbackOutcome,
  FeedbackStatus,
  FocusPlace,
  HistorySearchInput,
  HistorySearchResult,
  HistorySearchStats,
  HistorySourceRead,
  HistoryStatsInput,
  MemberHandle,
  MemberQueueItem,
  MergeCheckRun,
  MergeCheckRunKind,
  OperatorDiagnostics,
  MessageAttachmentRef,
  MessageKind,
  RelationsChange,
  TaskRelation,
  MemberView,
  QuestionAttachment,
  QuestionResponsePurpose,
  QuestionRecipient,
  QuestionRecipientRefusal,
  QuestionOptionInput,
  ScreeningTodo,
  ScreeningOutcome,
  Task,
  TaskDetail,
  TaskKind,
  TaskPriority,
  TaskStatus,
  ThemeCard,
  ThemeProgress,
  TimelineEvent,
  Visibility,
  WakeBlock,
  WorkDoing,
  WorkItemRef,
  BoundaryRequest,
  BoundaryGrant,
  StaleReason,
  TaskStartWaiting,
  SubmitBoundaryRequest,
  DecideBoundaryRequest,
  OperatorOperation,
  OperatorKnowledgeDocument,
  ProposeOperatorKnowledgeRequest,
  OperatorPlan,
  OperatorPreferenceData,
  OperatorPreferenceDocument,
  ConfigChangeRow,
  ProjectDoc,
  SuperCommand,
  SuperHandoff,
  ExternalAttachmentRead,
  ExternalDocWriteState,
  ExternalQuestionRead,
  StructuralReviewResult,
} from '@projectman/shared';
import type {
  Actor,
  AdministrationTarget,
  InboxItem,
  ListSuperHandoffsQuery,
  SuperDiagnosticsRequest,
  SuperDiagnosticsResponse,
  SuperOperateRequest,
  SuperOperation,
  SuperOperationDetail,
} from '@projectman/shared';
import type {
  AdministrationLogsOptions,
  AdministrationMachineSnapshot,
  AdministrationStatus,
  DiagnosticLogEntry,
} from './administration';
import type { IntegratorPrincipal } from './integrator-principal';
import type { CardQuestion, CardWorker, GuideTopic } from './context';
import type { MessageStateReport, ProjectStateReport, TaskStateReport } from './project-state';

/** What read_project_doc answers: the lines asked for of a project document at one commit. */
export interface ProjectDocRead {
  doc: ProjectDoc;
  repo: string;
  path: string;
  /** The commit the text was read at: the `base_commit` of a write. */
  commit: string;
  exists: boolean;
  total_lines: number;
  from_line: number;
  text: string;
}

/** An owner's answer on a card that may be a decision (PM-496). */
export interface DecisionCandidate {
  item_id: string;
  task_key: string | null;
  task_title: string | null;
  asked_by: string | null;
  asked_at: string;
  /** Title and body of the question, at most 2000 characters. */
  question: string;
  /** `option` is the text of the option that was chosen. */
  answer: { option: string | null; note: string | null };
  answered_by: string;
  answered_at: string;
  via_integrator: boolean;
}

/** The owner's verdict on one candidate; `decision` (the entry number) goes with `recorded` only. */
export interface DecisionMark {
  item_id: string;
  verdict: 'recorded' | 'declined' | 'skipped';
  decision?: string;
}

/** What list_decision_candidates answers (PM-496). */
export interface DecisionCandidatesList {
  candidates: DecisionCandidate[];
  more: boolean;
}

/** What write_project_docs answers. */
export type ProjectDocWrite =
  | { write_id: string; state: 'published'; commit: string; paths: string[]; warning?: string }
  | { write_id: string; state: 'queued'; waiting_for: string }
  | { write_id: string; state: 'running' };

/**
 * Team tools exposed to AI members through an MCP server ("team"), replacing the
 * desktop app's SendMessage. Tool names seen by Claude: mcp__team__<tool>.
 * The MCP transport lives in src/mcp; the behaviour is implemented by the domain.
 */

/** Why a sent team message waits before it reaches an AI recipient (PM-144). */
export type SentMessageHold =
  | 'refinement_turn'
  | 'fix_limit'
  | 'full_test'
  /** The engine the recipient's sessions run on is not connected (PM-315): it gets the message when it is back. */
  | 'engine'
  | 'pause'
  | 'restart'
  /** The card is being handed over from the recipient (PM-342): the receiver gets the message. */
  | 'handoff';

/** What became of waking the recipient (PM-543; only with delivery 'wake'). */
export type WakeStart =
  /** The session started or continued, and the message is in it. */
  | { state: 'started'; sessionId: string }
  /** It was not decided while the send waited; the start goes on in the background. */
  | { state: 'starting' }
  /** Admission put the start off (a leave, a pause, no capacity…); it is retried. */
  | { state: 'waiting'; reason: TaskStartWaiting['reason'] }
  /** The start stopped with an error (the DomainError code, else `start_failed`; `not_started`: it ran but no live session exists). */
  | { state: 'failed'; code: string };

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
  /** Only with delivery 'next_input' (PM-426): why the message starts no session for the recipient. */
  noWake?: WakeBlock;
  /** Only with delivery 'next_input' (PM-543): the message is kind info, so it starts nothing. */
  info?: true;
  /** Only with delivery 'next_input' (PM-543): the message was stale when sent (e.g. 'card_closed'), so it wakes nobody. */
  stale?: StaleReason;
  /** Only with delivery 'wake', and only when the send waited for the start (`awaitWake`). */
  start?: WakeStart;
}

export interface MemberAudience {
  operator: boolean;
  projectManager: boolean;
  merger: boolean;
  duties: ReadonlySet<DutyId>;
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
  /** The card's place in the project's focus (PM-437); absent when it is not in it. */
  focus?: FocusPlace;
  /** Who or what the card waits for, in a few words (PM-460); absent on a closed card and a theme. */
  waitsFor?: string;
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
  /** The task's place in the project's focus (PM-437); absent when it is not in it. */
  focus?: FocusPlace;
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
  /** Other members' running sessions on the card, as the brief names them (PM-249, PM-371). */
  cardWorkers?: CardWorker[];
  /** The card's questions (PM-249), as the brief lists them (`QUESTION_LIMIT`). */
  cardQuestions?: CardQuestion[];
  /** The card's latest merge checks, newest first (PM-876); absent when it has none. */
  mergeChecks?: MergeCheckRun[];
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

/** get_feedback without a mark: the marks a processor decides (PM-512). */
export interface FeedbackToolList {
  status: 'todo' | 'open' | 'all';
  /** How many marks match; `marks` holds at most the limit asked for. */
  total: number;
  marks: FeedbackMarkView[];
  /** The access of each marker in `marks` (`ai` for an AI member), by handle; a handle no longer on the team is absent. */
  authorAccess: Record<string, string>;
}

/**
 * get_feedback with a mark: the mark as a processor sees it, and where its screenshot can be opened.
 * A session on the server's own machine gets the stored file's path; a session on another engine
 * cannot reach it (the card's attachment carries the image once a card is opened).
 */
export interface FeedbackToolMark {
  mark: FeedbackMarkDetail;
  /** The access of the marker (`ai` for an AI member), or null when they are no longer on the team. */
  authorAccess: string | null;
  screenshot: { kind: 'none' } | { kind: 'local'; path: string } | { kind: 'remote' };
}

/** What the feedback tools that change a mark answer: the mark's state after the step. */
export interface FeedbackToolResult {
  markId: string;
  status: FeedbackStatus;
  outcome: FeedbackOutcome | null;
  /** The card a create step opened. */
  task?: { key: string; title: string };
}

/** The longest side, in pixels, of an image `read_message_attachment` hands over (larger ones are shrunk). */
export const MESSAGE_IMAGE_MAX_SIDE = 1568;

/**
 * The most bytes of that image (WebP). It travels in one MCP result, and over the engine link in one
 * `mcp.relay` frame (4 MiB at most, base64 included), hence the shrinking.
 */
export const MESSAGE_IMAGE_MAX_BYTES = 1_500_000;

/**
 * read_message_attachment (PM-516): a file of a team message the caller can see, opened for the
 * model. An image comes as a WebP of at most 1568 px a side, a small text file as text, anything
 * else (or an image too large to send) only as the entry.
 */
export interface MessageAttachmentReading {
  attachment: MessageAttachmentRef;
  message: { id: string; from: string; createdAt: string };
  content:
    | { kind: 'image'; data: Buffer; mimeType: 'image/webp' }
    | { kind: 'text'; text: string }
    | { kind: 'none'; reason: 'type' | 'too_large' };
  /**
   * The file in the caller's own session folder (PM-518), on the machine the session runs on:
   * given for what the content cannot show (`none`, or an image the provider's CLI does not pass on).
   * Absent: the content is all there is.
   */
  file?: { path: string };
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

/**
 * What propose_release answers (PM-491): the commit and the cards of the release. In preview
 * mode nothing was recorded, so there is no release id and no card.
 */
export interface ProposedRelease {
  releaseId?: string;
  taskKey?: string;
  commit: string;
  baseCommit: string | null;
  tasks: { key: string; title: string }[];
}

/** What publish_release answers (PM-968): the tag and the GitHub release of a merged commit. */
export interface PublishedRelease {
  repo: string;
  commit: string;
  baseCommit: string | null;
  /** In a preview: the tag that would be used. */
  tag: string;
  /** The GitHub release page; null in a preview. */
  url: string | null;
  tasks: { key: string; title: string }[];
}

/** What publish_release takes (PM-968). */
export interface PublishReleaseArgs {
  summary: string;
  repo?: string;
  commit?: string;
  tag?: string;
  preview?: boolean;
}

/**
 * What check_release answers (PM-542): the rehearsal of propose_release. Either the candidate, or the refusal
 * propose_release would give now. Nothing is recorded.
 */
export interface ReleaseCheckResult {
  candidate: { commit: string; baseCommit: string | null; tasks: { key: string; title: string }[] } | null;
  refusal: { code: string; message: string } | null;
  /** The members with the deployment duty: they may propose the release. */
  proposers: string[];
}

/** What became of the Operator's start of a member on work without a card (PM-541). */
export interface MemberStartResult {
  messageId: string;
  /** The member's line as send_message gives it, with `start` (PM-543). */
  recipient: SentMessageRecipient;
}

/** The tools of core/members (PM-592). */
export interface MemberToolsHandler {
  /** list_members: roster with handles, roles and status. */
  listMembers(ctx: ToolContext): Promise<MemberView[]>;
  /** save_memory: append a durable learning to this member's memory. */
  saveMemory(ctx: ToolContext, args: { note: string }): Promise<{ ok: true }>;
}

/** The tools of core/tasks (PM-592). */
export interface TaskToolsHandler {
  /** list_tasks: visible board tasks, newest update first. */
  listTasks(ctx: ToolContext, args: ListTasksInput): Promise<TaskSummary[]>;
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
      /** The card priority (PM-433); null clears it. Only people and the project manager may set it. */
      priority?: TaskPriority | null;
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
}

/** The tools of core/attachments (PM-592). */
export interface AttachmentToolsHandler {
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
   * read_message_attachment: the content of a file attached to a team message, judged through the
   * calling member's eyes (in a guest conversation of the Operator, through the guest's): a file of
   * a message they cannot see is not found, whoever uploaded it.
   */
  readMessageAttachment(ctx: ToolContext, args: { attachmentId: string }): Promise<MessageAttachmentReading>;
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

/** The tools of services/boundary (PM-607). */
export interface BoundaryToolsHandler {
  /** submit_boundary_request: one registered external operation; the requester is the calling session. */
  submitBoundaryRequest(ctx: ToolContext, args: SubmitBoundaryRequest): Promise<BoundaryRequest>;
  /** get_boundary_request: a request the caller raised or may decide, with its grant. */
  getBoundaryRequest(
    ctx: ToolContext,
    args: { requestId: string },
  ): Promise<{ request: BoundaryRequest; grant: BoundaryGrant | null }>;
  /** decide_boundary_request: delegated requests only; owner exceptions stay with the owner. */
  decideBoundaryRequest(
    ctx: ToolContext,
    args: DecideBoundaryRequest & { requestId: string },
  ): Promise<BoundaryRequest>;
}

/** The tools of services/merges. */
export interface MergeToolsHandler {
  /** merge_task: the card's merger starts (or retries, or continues after a fix) the merge of the approved commit. */
  mergeTask(
    ctx: ToolContext,
    args: { taskKey: string; fixConflict?: boolean; resolution?: string },
  ): Promise<{ task: Task }>;
  /**
   * prioritize_merge (PM-576): the card's merger or the Operator puts the card's merge at the front of its
   * repository's queue, with the reason; `moved` is false when it was first already.
   */
  prioritizeMerge(
    ctx: ToolContext,
    args: { taskKey: string; reason: string },
  ): Promise<{ task: Task; moved: boolean }>;
  /**
   * list_merge_checks (PM-876): the project's recorded merge checks, newest first, with the time, workers and
   * step timings the engine measured. Only the runs whose cards the caller may see.
   */
  listMergeChecks(ctx: ToolContext, args: ListMergeChecksInput): Promise<MergeCheckList>;
}

/** The arguments of list_merge_checks; the defaults (any outcome, merges and trains, 30 runs) are the tool's. */
export interface ListMergeChecksInput {
  taskKey?: string;
  outcome?: 'passed' | 'not_passed' | 'any';
  /** `checks` is the merge and the train check; `diagnose` is the train's per-card diagnosis. */
  kind?: MergeCheckRunKind | 'checks' | 'any';
  /** ISO 8601 with a time zone: the runs requested from `since` (inclusive) up to `until` (exclusive). */
  since?: string;
  until?: string;
  limit?: number;
}

export interface MergeCheckList {
  runs: MergeCheckRun[];
  /** More runs match than `runs` holds: ask again with `until` set to the oldest `requestedAt`. */
  hasMore: boolean;
}

/** The tools of services/feedback (PM-608). */
export interface FeedbackToolsHandler {
  /**
   * get_feedback (PM-512, feedback processors only; else `forbidden` with `feedback_processor_only`):
   * the marks that wait for a decision.
   */
  getFeedbackList(
    ctx: ToolContext,
    args: { status: 'todo' | 'open' | 'all'; limit: number },
  ): Promise<FeedbackToolList>;
  /** get_feedback with `mark_id`: one mark in full. */
  getFeedbackMark(ctx: ToolContext, args: { markId: string }): Promise<FeedbackToolMark>;
  /** reply_feedback: an answer in the mark's thread, in the processor's name. */
  replyFeedback(ctx: ToolContext, args: { markId: string; body: string }): Promise<FeedbackToolResult>;
  /** create_task_from_feedback: a card from the mark (the screenshot becomes its attachment). */
  createTaskFromFeedback(
    ctx: ToolContext,
    args: { markId: string; title: string; description: string; visibility?: Visibility; reply?: string },
  ): Promise<FeedbackToolResult>;
  /** link_feedback: the mark belongs to an existing card. */
  linkFeedback(
    ctx: ToolContext,
    args: { markId: string; taskKey: string; reply?: string },
  ): Promise<FeedbackToolResult>;
  /** forward_feedback: the mark goes to the owners, who are alerted; the mark then waits for them. */
  forwardFeedback(
    ctx: ToolContext,
    args: { markId: string; reason: string; reply: string },
  ): Promise<FeedbackToolResult>;
  /** close_feedback: the mark is closed, with an optional last reply. */
  closeFeedback(ctx: ToolContext, args: { markId: string; reply?: string }): Promise<FeedbackToolResult>;
}

/** The tools of services/github (PM-604). */
export interface GithubToolsHandler {
  /** link_pull_request: attach a GitHub PR to the task. */
  linkPullRequest(
    ctx: ToolContext,
    args: { taskKey: string; repo: string; number: number },
  ): Promise<{ task: Task }>;
}

export interface ScreenshotToolsHandler {
  /**
   * take_screenshots (PM-351): starts `npm run shots` for the calling session in the server's sandbox, and
   * waits up to 40 seconds for its end. The answer is the run; a run that is not over yet is asked again
   * with `getScreenshotRun`.
   */
  takeScreenshots(ctx: ToolContext, input: TakeScreenshotsInput): Promise<ScreenshotRun>;
  /** get_screenshot_run (PM-351): a run of the calling session; waits up to 40 seconds if it is not over. */
  getScreenshotRun(ctx: ToolContext, runId: string): Promise<ScreenshotRun>;
}

/** The tools of services/releases (PM-606). */
export interface ReleaseToolsHandler {
  /**
   * propose_release (PM-491): the member with the deployment duty proposes releasing the default
   * branch's head (or `commit`); `preview` only lists what the release would contain.
   */
  proposeRelease(
    ctx: ToolContext,
    args: { title: string; summary: string; commit?: string; preview?: boolean },
  ): Promise<ProposedRelease>;
  /**
   * publish_release (PM-968): the member with the deployment duty tags a merged commit of a project repository
   * and makes its public GitHub release, with the merged cards since the previous release in the notes. No
   * approval; `preview` records nothing. Repeating a call finishes an interrupted publication.
   */
  publishRelease(ctx: ToolContext, args: PublishReleaseArgs): Promise<PublishedRelease>;
  /** check_release (PM-542): only the Operator; the same checks as propose_release, nothing recorded. */
  checkRelease(ctx: ToolContext, args: { commit?: string }): Promise<ReleaseCheckResult>;
}

/** The tools of services/email-channel (PM-941). */
export interface EmailToolsHandler {
  sendEmail(
    ctx: ToolContext,
    args: { to: string; subject: string; text: string; taskKey: string | null },
  ): Promise<{ emailId: string; status: 'pending_approval' | 'sent' }>;
  setEmailContact(
    ctx: ToolContext,
    args: {
      handle: string;
      wants: boolean;
      requestedBy: string;
      sourceMessageId?: string;
      sourceEmailId?: string;
      quote?: string;
    },
  ): Promise<{ handle: string; wants: boolean }>;
  listEmailContacts(
    ctx: ToolContext,
  ): Promise<Array<{ handle: string; displayName: string; wants: boolean; hasAddress: boolean }>>;
}

export interface TeamToolsHandler
  extends
    MemberToolsHandler,
    TaskToolsHandler,
    AttachmentToolsHandler,
    MergeToolsHandler,
    FeedbackToolsHandler,
    GithubToolsHandler,
    ScreenshotToolsHandler,
    BoundaryToolsHandler,
    ReleaseToolsHandler,
    EmailToolsHandler,
    OperatorToolsHandler,
    ProjectDocToolsHandler,
    SystemFeedbackToolsHandler,
    HistoryToolsHandler,
    InboxToolsHandler,
    MessageToolsHandler,
    AdmissionToolsHandler,
    WatcherToolsHandler,
    OperatorQueueToolsHandler,
    SessionToolsHandler {}

/** What read_history_source takes: one source of the project's history, read in lines (PM-787). */
export interface HistorySourceReadArgs {
  sourceId: string;
  fromLine?: number;
  lineCount?: number;
  commit?: string;
}

/** The tools of services/history (PM-787): search and read the project's history, and the private statistics. */
export interface HistoryToolsHandler {
  /**
   * search_history: the visible hits of the project history for the caller, through the shared visibility rule.
   * `projectKey` defaults to the session's project; another project of an AI member is `insufficient_access`.
   * Every valid search is measured once, privately.
   */
  searchHistory(
    ctx: ToolContext,
    args: HistorySearchInput & { projectKey?: string },
  ): Promise<HistorySearchResult>;
  /** read_history_source: one source a search named, in lines; hidden and missing give the same `not_found`. */
  readHistorySource(
    ctx: ToolContext,
    args: HistorySourceReadArgs & { projectKey?: string },
  ): Promise<HistorySourceRead>;
  /**
   * get_history_search_stats: the private statistics of the search log. Only the Operator, in the general
   * conversation of a human owner or admin, tied to their own open message or answer request; otherwise
   * `history_stats_forbidden`.
   */
  getHistorySearchStats(ctx: ToolContext, args: HistoryStatsInput): Promise<HistorySearchStats>;
}

export interface InboxToolsHandler {
  /**
   * decide_permission_request: the AI decider answers a member's tool question delegated to it
   * (PM-169), or hands it to a person (`escalate`). The reason is required.
   */
  decidePermissionRequest(
    ctx: ToolContext,
    args: { requestId: string; decision: 'allow' | 'deny' | 'escalate'; reason: string },
  ): Promise<{ requestId: string; decision: 'allow' | 'deny' | 'escalate'; outcome: string }>;
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
      /** Ids of files of the question's card or its parent (PM-498), at most `MAX_QUESTION_ATTACHMENTS`. */
      attachmentIds?: string[];
      /** The earlier question the Operator settled, and why a person must see this one (PM-558); only together. */
      reaskOf?: string;
      reaskReason?: string;
      /** `information`: a simple fact the super-mode integrator may relay (PM-762); missing means an owner decision. */
      responsePurpose?: QuestionResponsePurpose;
      recipient?: QuestionRecipient;
    },
  ): Promise<{
    inboxItemId: string;
    approvalLabel?: string;
    attachments?: QuestionAttachment[];
    /** An AI member's question waits for the Operator's screening before the people see it (PM-558). */
    screening?: true;
  }>;
  /**
   * withdraw_question (PM-559): the asking member closes its own pending question (open, or still with the
   * Operator for screening) because it became moot, with a short `reason`. Errors: `not_found` (no such
   * question in the project), `forbidden` `not_your_question` (the caller did not ask it), `invalid`
   * `question_closed` (it is not pending any more).
   */
  withdrawQuestion(ctx: ToolContext, args: { itemId: string; reason: string }): Promise<{ itemId: string }>;
}

export interface MessageToolsHandler {
  /** send_message: deliver a message to team members (AI sessions or human inboxes). */
  sendMessage(
    ctx: ToolContext,
    args: {
      to: MemberHandle[];
      text: string;
      taskKey?: string;
      kind: MessageKind;
      despiteWorkers?: boolean;
      signalId?: string;
      signalActionable?: boolean;
      signalIds?: string[];
      actionableSignalIds?: string[];
      /**
       * Files to send with the message (PM-520): paths in the caller's session folder or relative to its
       * working directory, read as `attach_file` reads them. All or nothing; a bad file names itself.
       */
      attachments?: string[];
    },
  ): Promise<{
    messageId: string;
    deliveredTo: MemberHandle[];
    /** What happens to the message for each recipient, in the order of `to` (PM-144). */
    recipients: SentMessageRecipient[];
    /** Only the recipients that get the message somewhere else than on its own card (PM-182). */
    routed?: { handle: MemberHandle; workItem: WorkItemRef }[];
    /** The sender is the Operator (PM-543): the text then never sends it to a person. */
    operator: boolean;
  }>;
}

export interface AdmissionToolsHandler {
  /**
   * hand_off (PM-342): the member a card is being handed over from writes the note for its successor; its
   * session closes when it is idle. Refused with `handoff_not_open` when nothing is being handed over from
   * the caller on that card (any more).
   */
  handOff(ctx: ToolContext, args: { taskKey: string; note: string }): Promise<{ recorded: true }>;
}

export interface WatcherToolsHandler {
  /**
   * decide_fix_limit (PM-262): the AI member who decides (the lead, or the planner it asked) decides how a
   * card that reached its fix round limit goes on. The reason is required; so is the assessment of
   * `to_owner` (PM-714: recurrence, currentState, recommendation {optionId, reason}), which the watcher
   * validates.
   */
  decideFixLimit(
    ctx: ToolContext,
    args: {
      taskKey: string;
      decision: 'continue' | 'replan' | 'to_owner';
      reason: string;
      assessment?: unknown;
    },
  ): Promise<{ phase: 'released' | 'replan' | 'owner' }>;
}

export interface OperatorQueueToolsHandler {
  /**
   * finish_queue_item (PM-885): the Operator ends the item of its work queue it is working on (the session's
   * own, `processing`): done, or handed to the owner with a reason and the action to take. 409
   * `queue_item_not_processing` when the item is not this session's open one.
   */
  finishQueueItem(
    ctx: ToolContext,
    args: {
      itemId: string;
      outcome: 'done' | 'handed_off';
      summary: string;
      operationIds: string[];
      fixLimitOption?: 'replan' | 'reassign' | 'another_round';
      handoff?: {
        reason: 'owner_reserved' | 'no_typed_operation' | 'no_grant';
        action: string;
        detail?: string;
        operationId?: string;
      };
    },
  ): Promise<{ item: MemberQueueItem }>;
}

export interface SessionToolsHandler {
  /**
   * set_current_work (PM-238): what the calling session's member does on its own card now. It has no
   * task argument: it always concerns the caller's session, which must be a task session in a round.
   * Only the latest is kept; it is cleared when the round ends. `recorded` is false when the session
   * was not in a round, so nothing was written.
   */
  setCurrentWork(ctx: ToolContext, args: WorkDoing): Promise<{ recorded: boolean }>;
  getGuide(ctx: ToolContext, args: { topic: GuideTopic }): Promise<string>;
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
  audienceOf(ctx: ToolContext): MemberAudience;
  /** Maps the token in /mcp/:token to the calling session; null = reject. */
  resolveContext(token: string): ToolContext | null;
  logger: FastifyBaseLogger;
  /** The bearer endpoint `POST /mcp` of the integrator (PM-760); absent: that route is not served. */
  external?: ExternalMcpBackend;
}

export interface McpModule {
  /** Registers the MCP endpoints: /mcp/:token (localhost only) and, with `external`, the bearer POST /mcp. */
  registerRoutes(app: FastifyInstance): void;
}

/** One row of `list_system_feedback`: the owner's decisions and reasons are not part of it. */
export interface SystemFeedbackToolRow {
  id: string;
  state: 'new' | 'forwarded' | 'dismissed';
  title: string;
  occurrences: number;
  last_seen_at: string;
}

/** The tools of services/feedback/system (PM-472, PM-479). Only the Operator calls them. */
export interface SystemFeedbackToolsHandler {
  /** list_system_feedback: the project's own items in any state, the latest 50. A look; needs no open request. */
  listSystemFeedback(ctx: ToolContext): Promise<{ items: SystemFeedbackToolRow[] }>;
  /**
   * record_system_feedback: a gap in projectman the Operator worked around. `sameAs` adds an occurrence to an
   * item of this project instead of opening a new one.
   */
  recordSystemFeedback(
    ctx: ToolContext,
    args: { title: string; what: string; workaround: string; fix: string; sameAs?: string },
  ): Promise<{ id: string; state: 'new' | 'forwarded' | 'dismissed'; created: boolean; occurrences: number }>;
}

/** The tools of services/project-docs (PM-495, PM-496). */
export interface ProjectDocToolsHandler {
  /**
   * read_project_doc (PM-495): the decision log or the roadmap on the head of the default branch, in lines.
   * Only the Operator; needs no open request.
   */
  readProjectDoc(
    ctx: ToolContext,
    args: { doc: ProjectDoc; fromLine?: number; lineCount?: number },
  ): Promise<ProjectDocRead>;
  /**
   * write_project_docs (PM-495): text replacements in the project documents as one commit on the default
   * branch. Only the Operator, in the owner's own conversation, during an open owner request.
   */
  writeProjectDocs(
    ctx: ToolContext,
    args: {
      baseCommit: string;
      message: string;
      edits: { doc: ProjectDoc; old_text: string; new_text: string }[];
    },
  ): Promise<ProjectDocWrite>;
  /**
   * list_decision_candidates (PM-496): the owners' answers on cards that may be decisions. Only the
   * Operator, not in guest conversations; needs no open request. Counts as a look.
   */
  listDecisionCandidates(ctx: ToolContext, args: { limit?: number }): Promise<DecisionCandidatesList>;
  /**
   * mark_decision_candidates (PM-496): the owner's verdict on offered candidates, all or nothing. Only the
   * Operator, in the owner's own conversation, during an open owner request.
   */
  markDecisionCandidates(ctx: ToolContext, args: { items: DecisionMark[] }): Promise<{ marked: number }>;
}

/** What get_checklist answers: the list (null: none yet) and what each template would add to it. */
export interface ChecklistToolView {
  checklist: ProjectChecklist | null;
  templates: { id: string; checklist: string[] }[];
}

/** The input of update_checklist, after the tool checked it per operation. */
export interface UpdateChecklistInput {
  op: 'init' | 'add' | 'edit' | 'set_condition' | 'set_state' | 'apply_template';
  itemId?: string;
  title?: string;
  hint?: string | null;
  condition?: ChecklistCondition | null;
  state?: 'open' | 'done' | 'not_needed';
  reason?: string;
  templateId?: string;
}

/** What update_checklist answers: the list after the change, the item it made and the items a template added. */
export interface UpdateChecklistResult {
  checklist: ProjectChecklist;
  itemId?: string;
  added?: string[];
}

/** The tools of services/operator (PM-605). */
export interface OperatorToolsHandler {
  getRoleConfiguration(ctx: ToolContext, args: { role: BuiltInRoleId }): Promise<RoleConfigurationRead>;
  requestStructuralReview(
    ctx: ToolContext,
    args: { signalId: string; note: string },
  ): Promise<import('@projectman/shared').StructuralReviewResult>;
  getOperatorDiagnostics(
    ctx: ToolContext,
    args: { taskKey: string; limit?: number },
  ): Promise<OperatorDiagnostics>;
  /** get_checklist (PM-977): the Operator and the PM, internal general session, never a guest. */
  getChecklist(ctx: ToolContext): Promise<ChecklistToolView>;
  /** update_checklist (PM-977): the Operator only, internal general session; needs no owner request. */
  updateChecklist(ctx: ToolContext, args: UpdateChecklistInput): Promise<UpdateChecklistResult>;
  getOperatorKnowledge(ctx: ToolContext): Promise<OperatorKnowledgeDocument>;
  proposeOperatorKnowledge(
    ctx: ToolContext,
    args: ProposeOperatorKnowledgeRequest,
  ): Promise<{
    status: 'awaiting_approval';
    inbox_item_id: string;
    step_id: string;
    base_revision: number;
  }>;
  getOperatorPreference(ctx: ToolContext): Promise<OperatorPreferenceDocument>;
  setOperatorPreference(
    ctx: ToolContext,
    args: { expectedRevision: number; preference: OperatorPreferenceData },
  ): Promise<OperatorPreferenceDocument>;
  getProjectState(
    ctx: ToolContext,
    args: { taskKey?: string; messageId?: string },
  ): Promise<TaskStateReport | ProjectStateReport | MessageStateReport>;
  operate(
    ctx: ToolContext,
    args: { title: string; operation: OperatorOperation; plan?: OperatorPlan },
  ): Promise<{
    status: 'done' | 'awaiting_approval' | 'refused';
    step_id: string;
    changes: ConfigChangeRow[];
    config_version?: string | null;
    inbox_item_id?: string;
    deduplicated?: true;
  }>;
  /**
   * execute_operation (PM-888): the Operator starts one command on the shared super-operation path, as itself,
   * during an open owner request in its own general conversation. A K3 effect waits for the owner's own yes and
   * goes on by itself after it. The same `requestKey` in the same request is the same operation; `operate` and
   * `member_update` commands are `super_operation_unsupported`.
   */
  executeOperation(
    ctx: ToolContext,
    args: { requestKey: string; taskKey?: string; command: SuperCommand },
  ): Promise<{ operation: SuperOperation }>;
  /** get_operation (PM-888): one operation of the project and, once recorded, its result. */
  getOperation(ctx: ToolContext, args: { operationId: string }): Promise<SuperOperationDetail>;
  /** get_machine_status (PM-888): the administration status and, when the target has the capability, its machine. */
  getMachineStatus(
    ctx: ToolContext,
    args: { target: AdministrationTarget },
  ): Promise<{ status: AdministrationStatus; machine: AdministrationMachineSnapshot | null }>;
  /** get_machine_logs (PM-888): the filtered diagnostic log of the hub or of an engine linked to the project. */
  getMachineLogs(
    ctx: ToolContext,
    args: { target: AdministrationTarget } & AdministrationLogsOptions,
  ): Promise<{ entries: DiagnosticLogEntry[] }>;
  startTask(
    ctx: ToolContext,
    args: { taskKey: string; assignee?: string; despitePrerequisites?: boolean; signalId?: string },
  ): Promise<{
    task_key: string;
    session_id: string | null;
    hired: string | null;
    /** The card's assignee after the start. */
    assignee: string | null;
    /** Gate labels and the members started to set them (PM-236). */
    awaiting?: { labels: string[]; members: string[] };
    /** Seniors the card waits for, without an assigned developer (PM-348). */
    senior_wait?: { seniors: string[] };
  }>;
  startMember(
    ctx: ToolContext,
    args: { member: string; text: string; taskKey?: string; signalId?: string; despiteWorkers?: boolean },
  ): Promise<MemberStartResult>;
  /**
   * screen_question (PM-558): the Operator settles a question of an AI member that waits for its screening:
   * `answered` (with `answer`), `forwarded` (to a member, `forwardTo`), `moot`, or sent on to the people as a
   * `decision` or a `todo` (with the todo's fields). `note` is always the reason. Only the Operator, not in a
   * guest conversation; needs no open request.
   */
  screenQuestion(
    ctx: ToolContext,
    args: {
      itemId: string;
      outcome: ScreeningOutcome;
      note: string;
      answer?: string;
      forwardTo?: MemberHandle;
      todo?: ScreeningTodo;
      feedbackId?: string;
    },
  ): Promise<{
    inboxItemId: string;
    outcome: ScreeningOutcome;
    recipient?: QuestionRecipient;
    recipientRefusal?: QuestionRecipientRefusal;
  }>;
  combineQuestions(
    ctx: ToolContext,
    args: { itemIds: string[]; question: string; note: string },
  ): Promise<{ primaryItemId: string; linkedItemIds: string[] }>;
  dismissSignal(
    ctx: ToolContext,
    args: { signalId: string; note: string },
  ): Promise<{ signalId: string; state: 'dismissed' }>;
  /**
   * The PM opens a todo in the integrator's queue (PM-808), the way the system does for an obligation: the
   * PM is the asker, so the answer comes back to it. The owners get it when the integrator cannot take it.
   * Refused (`obligation_tracked`) on a card projectman follows itself.
   */
  openIntegratorTodo(
    ctx: ToolContext,
    args: { taskKey?: string; question: string; what: string; where: string; expected: string },
  ): Promise<{
    itemId: string;
    recipient: QuestionRecipient;
    recipientRefusal: QuestionRecipientRefusal | null;
  }>;
  triageLoop(
    ctx: ToolContext,
    args: {
      signalId: string;
      outcome: 'progress' | 'loop';
      note: string;
      evidenceIds: string[];
    },
  ): Promise<{
    state: 'observing' | 'awaiting_owner' | 'resolved';
    loopId: string;
    inboxItemId: string | null;
  }>;
}

/**
 * The caller of the bearer MCP (PM-760): an integrator key, one project, no provider session. It is a
 * separate type on purpose: `ToolContext.sessionId` is never filled with an empty or invented id, and the
 * member tools that need a session cannot be given this one.
 */
export interface ExternalToolContext {
  principal: IntegratorPrincipal;
  projectKey: string;
  /** The actor every change is recorded as: the Operator-bound super actor, or the owner via the key. */
  actor: Actor;
  requestId: string;
}

/** What send_message answers for the integrator: the same delivery report, without the session-bound parts. */
export interface ExternalSentMessage {
  messageId: string;
  deliveredTo: string[];
  recipients: SentMessageRecipient[];
}

/**
 * The domain calls of the tools the bearer MCP serves. Each method is bound to the project of the context
 * and re-reads the credential's rights; none reads a session, a member's private file or a working directory.
 */
export interface ExternalToolsHandler {
  /** The projects whose owner the key's holder currently is; the only call without a project. */
  listProjects(
    principal: IntegratorPrincipal,
    requestId: string,
  ): Promise<{ projects: { key: string; name: string }[] }>;
  listTasks(ctx: ExternalToolContext, args: ListTasksInput): Promise<TaskSummary[]>;
  getTask(ctx: ExternalToolContext, args: { taskKey: string; eventId?: string }): Promise<TaskToolDetail>;
  createTask(
    ctx: ExternalToolContext,
    args: Parameters<TaskToolsHandler['createTask']>[1],
  ): Promise<{ task: Task }>;
  updateTask(
    ctx: ExternalToolContext,
    args: Parameters<TaskToolsHandler['updateTask']>[1],
  ): Promise<{ task: Task }>;
  sendMessage(
    ctx: ExternalToolContext,
    args: { to: string[]; text: string; taskKey?: string; kind: MessageKind; despiteWorkers?: boolean },
  ): Promise<ExternalSentMessage>;
  listMembers(ctx: ExternalToolContext): Promise<MemberView[]>;
  getProjectState(
    ctx: ExternalToolContext,
    args: { taskKey?: string; messageId?: string },
  ): Promise<TaskStateReport | ProjectStateReport | MessageStateReport>;
  getOperatorDiagnostics(
    ctx: ExternalToolContext,
    args: { taskKey: string; limit?: number },
  ): Promise<OperatorDiagnostics>;
  listAttachments(
    ctx: ExternalToolContext,
    args: { taskKey: string; offset?: number; limit?: number },
  ): Promise<AttachmentPage>;
  checkRelease(ctx: ExternalToolContext, args: { commit?: string }): Promise<ReleaseCheckResult>;
  listSuperHandoffs(
    ctx: ExternalToolContext,
    query: ListSuperHandoffsQuery,
  ): Promise<{ handoffs: SuperHandoff[] }>;
  executeSuperHandoff(
    ctx: ExternalToolContext,
    args: { handoffId: string; requestId: string },
  ): Promise<{ operation: SuperOperation }>;
  superOperate(
    ctx: ExternalToolContext,
    request: SuperOperateRequest,
  ): Promise<{ operation: SuperOperation }>;
  getSuperOperation(ctx: ExternalToolContext, operationId: string): Promise<SuperOperationDetail>;
  querySuperDiagnostics(
    ctx: ExternalToolContext,
    request: SuperDiagnosticsRequest,
  ): Promise<SuperDiagnosticsResponse>;
  getAdministrationStatus(
    ctx: ExternalToolContext,
    target: AdministrationTarget,
  ): Promise<{ status: AdministrationStatus }>;
  getAdministrationLogs(
    ctx: ExternalToolContext,
    args: { target: AdministrationTarget } & AdministrationLogsOptions,
  ): Promise<{ entries: DiagnosticLogEntry[] }>;
  getMachineSnapshot(
    ctx: ExternalToolContext,
    target: AdministrationTarget,
  ): Promise<{ snapshot: AdministrationMachineSnapshot }>;
  resolveIntegratorTodo(
    ctx: ExternalToolContext,
    args: { itemId: string; optionId: 'todo_done' | 'todo_cannot'; note?: string },
  ): Promise<{ item: InboxItem }>;
  /**
   * resolve_integrator_fix_limit (PM-714): the integrator decides the fix round limit item addressed to it
   * (replan, reassign, another_round) or hands it to the owners (to_owner, with a note). Only that item.
   */
  resolveIntegratorFixLimit(
    ctx: ExternalToolContext,
    args: {
      itemId: string;
      optionId: 'replan' | 'reassign' | 'another_round' | 'to_owner';
      note?: string;
    },
  ): Promise<{ item: InboxItem }>;
  /** list_integrator_inbox (PM-714): what the integrator is the recipient of, each with its full text. */
  listIntegratorInbox(
    ctx: ExternalToolContext,
    args: { state: 'open' | 'all' },
  ): Promise<{ items: InboxItem[] }>;
  relayOwnerAnswer(
    ctx: ExternalToolContext,
    args: { itemId: string; answer: string },
  ): Promise<{ item: InboxItem }>;
  /** search_history for the integrator's bound access (PM-787); the same result as the member tool. */
  searchHistory(ctx: ExternalToolContext, args: HistorySearchInput): Promise<HistorySearchResult>;
  readHistorySource(ctx: ExternalToolContext, args: HistorySourceReadArgs): Promise<HistorySourceRead>;
  /** read_project_doc (PM-784): the Operator's document read; super and read keys. */
  readProjectDoc(
    ctx: ExternalToolContext,
    args: { doc: ProjectDoc; fromLine?: number; lineCount?: number },
  ): Promise<ProjectDocRead>;
  /** write_project_docs (PM-784): super keys only; the append-only document rules apply as for the Operator. */
  writeProjectDocs(
    ctx: ExternalToolContext,
    args: {
      baseCommit: string;
      message: string;
      edits: { doc: ProjectDoc; old_text: string; new_text: string }[];
    },
  ): Promise<ProjectDocWrite>;
  /** get_project_doc_write (PM-784): the state of one write the same owner's keys made. */
  getProjectDocWrite(ctx: ExternalToolContext, args: { writeId: string }): Promise<ExternalDocWriteState>;
  getRoleConfiguration(
    ctx: ExternalToolContext,
    args: { role: BuiltInRoleId },
  ): Promise<RoleConfigurationRead>;
  /** propose_release (PM-784): super keys only; a `preview` records nothing. */
  proposeRelease(
    ctx: ExternalToolContext,
    args: { title: string; summary: string; commit?: string; preview?: boolean },
  ): Promise<ProposedRelease>;
  requestStructuralReview(
    ctx: ExternalToolContext,
    args: { signalId: string; note: string },
  ): Promise<StructuralReviewResult>;
  /** ask_human (PM-784): a question of the integrator to the owners, answered only by their own login. */
  askHuman(
    ctx: ExternalToolContext,
    args: {
      question: string;
      options?: QuestionOptionInput[];
      taskKey?: string;
      to?: MemberHandle[];
      recommended?: string;
      recommendationReason?: string;
      details?: string;
      attachmentIds?: string[];
      responsePurpose?: QuestionResponsePurpose;
    },
  ): Promise<{
    inboxItemId: string;
    approvalLabel?: string;
    attachments?: QuestionAttachment[];
    state: 'open';
  }>;
  /** get_super_question (PM-784): the integrator owner's own question and, once answered, the answer. */
  getSuperQuestion(ctx: ExternalToolContext, args: { itemId: string }): Promise<ExternalQuestionRead>;
  withdrawQuestion(
    ctx: ExternalToolContext,
    args: { itemId: string; reason: string },
  ): Promise<{ itemId: string; state: 'cancelled' }>;
  /** read_attachment (PM-784): one chunk of a file of a card, byte-exact. */
  readAttachment(
    ctx: ExternalToolContext,
    args: { taskKey: string; attachmentId: string; offsetBytes?: number; maxBytes?: number },
  ): Promise<ExternalAttachmentRead>;
}

/** The credential modes of an integrator key (PM-757), as the external tool policy sees them. */
export type ExternalCredentialMode = IntegratorPrincipal['mode'];

/** What the bearer MCP endpoint needs from the composition: the handler and the execution scope around it. */
export interface ExternalMcpBackend {
  handler: ExternalToolsHandler;
  /** Runs one project-bound tool call inside the key's execution scope and audit (`SuperOperator.execute`). */
  execute<T>(
    context: { principal: IntegratorPrincipal; requestId: string },
    target: { projectKey: string; taskKey?: string; operation: string },
    run: () => Promise<T>,
  ): Promise<T>;
  /** Resolves the call's context: re-checks the key, the holder's ownership and the mode, and binds the actor. */
  bind(
    input: { principal: IntegratorPrincipal; projectKey: string; requestId: string },
    operation: 'read' | 'write',
  ): Promise<ExternalToolContext>;
}
