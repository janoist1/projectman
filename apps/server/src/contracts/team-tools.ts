import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type {
  Attachment,
  MemberHandle,
  MemberView,
  QuestionOptionInput,
  Task,
  TaskDetail,
  TaskStatus,
  Visibility,
  WorkItemRef,
  BoundaryRequest,
  BoundaryGrant,
  SubmitBoundaryRequest,
  DecideBoundaryRequest,
} from '@projectman/shared';
import type { PullRequestInfo, RemoteState } from './github';

/**
 * Team tools exposed to AI members through an MCP server ("team"), replacing the
 * desktop app's SendMessage. Tool names seen by Claude: mcp__team__<tool>.
 * The MCP transport lives in src/mcp; the behaviour is implemented by the domain.
 */

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
>;

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

export interface TeamToolsHandler {
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
  /** list_network_denials: destinations the egress proxy refused this session (PM-140), newest first. */
  listNetworkDenials(ctx: ToolContext): Promise<NetworkDenial[]>;
  /** list_tasks: visible board tasks, newest update first. */
  listTasks(ctx: ToolContext, args: ListTasksInput): Promise<TaskSummary[]>;
  /** send_message: deliver a message to team members (AI sessions or human inboxes). */
  sendMessage(
    ctx: ToolContext,
    args: { to: MemberHandle[]; text: string; taskKey?: string },
  ): Promise<{
    messageId: string;
    deliveredTo: MemberHandle[];
    /** Only the recipients that get the message somewhere else than on its own card (PM-182). */
    routed?: { handle: MemberHandle; workItem: WorkItemRef }[];
  }>;
  /** list_members: roster with handles, roles and status. */
  listMembers(ctx: ToolContext): Promise<MemberView[]>;
  /** get_task: task with recent timeline, and where its work happens. */
  getTask(ctx: ToolContext, args: { taskKey: string }): Promise<TaskToolDetail>;
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
