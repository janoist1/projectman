import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { CheckName, CheckState, MemberHandle, MemberView, Task, TaskDetail } from '@projectman/shared';

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

export interface TeamToolsHandler {
  /** send_message: deliver a message to team members (AI sessions or human inboxes). */
  sendMessage(
    ctx: ToolContext,
    args: { to: MemberHandle[]; text: string; taskKey?: string },
  ): Promise<{ messageId: string; deliveredTo: MemberHandle[] }>;
  /** list_members: roster with handles, roles and status. */
  listMembers(ctx: ToolContext): Promise<MemberView[]>;
  /** get_task: task with recent timeline. */
  getTask(ctx: ToolContext, args: { taskKey: string }): Promise<TaskDetail>;
  /** update_task: move stage (gates enforced), record a check result, add a note. */
  updateTask(
    ctx: ToolContext,
    args: {
      taskKey: string;
      stageId?: string;
      check?: { name: CheckName; state: CheckState };
      note?: string;
    },
  ): Promise<{ task: Task }>;
  /** link_pull_request: attach a GitHub PR to the task. */
  linkPullRequest(
    ctx: ToolContext,
    args: { taskKey: string; repo: string; number: number },
  ): Promise<{ task: Task }>;
  /** ask_human: create a question in a human's inbox; the answer arrives later as a team message. */
  askHuman(
    ctx: ToolContext,
    args: { question: string; options?: string[]; taskKey?: string; to?: MemberHandle[] },
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
