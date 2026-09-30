import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type {
  MemberHandle,
  MemberView,
  QuestionOptionInput,
  Task,
  TaskDetail,
  TaskStatus,
  Visibility,
} from '@projectman/shared';

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
}

export interface TeamToolsHandler {
  /** list_tasks: visible board tasks, newest update first. */
  listTasks(ctx: ToolContext, args: ListTasksInput): Promise<TaskSummary[]>;
  /** send_message: deliver a message to team members (AI sessions or human inboxes). */
  sendMessage(
    ctx: ToolContext,
    args: { to: MemberHandle[]; text: string; taskKey?: string },
  ): Promise<{ messageId: string; deliveredTo: MemberHandle[] }>;
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
