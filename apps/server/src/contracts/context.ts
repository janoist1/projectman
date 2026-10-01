import type { FastifyBaseLogger } from 'fastify';
import type {
  AiMemberConfig,
  Attachment,
  MemberView,
  ProjectConfig,
  Stage,
  Task,
  TimelineEvent,
  WorkItemRef,
} from '@projectman/shared';

/**
 * What an AI member knows when a fresh session starts. Owned by src/context and
 * src/worktree.
 */

export interface ContextPackInput {
  project: ProjectConfig;
  member: AiMemberConfig;
  workItem: WorkItemRef;
  task: Task | null;
  /** Current stage of the task, if any. */
  stage: Stage | null;
  /** Recent timeline of the task (oldest first). */
  timeline: TimelineEvent[];
  /** Roster of the team (humans and AI). */
  team: MemberView[];
  /** The member's own durable memory (markdown). */
  memory: string;
  /**
   * The task's readable attachments (metadata only, oldest first), listed in the kick-off brief.
   * Omitted (or empty) when the task has none or the work item is not a task.
   */
  attachments?: Attachment[];
}

export interface ContextPack {
  /**
   * Identity, team, how the team works, pipeline and labels, the current work item and its
   * steps, guardrails, role instructions, memory. English prompt text, rebuilt on every start
   * and resume (Claude Code: `--append-system-prompt`; Codex: `developer_instructions`).
   */
  appendSystemPrompt: string;
  /**
   * Kick-off message for a new work item: the task brief, or a scheduled run's prompt; null for
   * general chats and meetings.
   */
  initialMessage: string | null;
  /**
   * First message of a resumed task session that no message caused, so that it does not sit at its
   * prompt: it was restarted, which task and stage it is in, and to check where it left off before
   * it carries on. Null for other work items. A resume that a message caused (a person writing to
   * the stopped session, a waiting team message) gets that message instead.
   */
  continueMessage: string | null;
}

export interface ContextPackBuilder {
  build(input: ContextPackInput): ContextPack;
}

/**
 * Who opens a conversation, by its work item: tasks and scheduled runs start with the context
 * pack's initial message (the kick-off brief, the scheduled prompt), which the system types;
 * general chats and meetings start with what a person writes. The chat labels the first user
 * turn with it, live and when a transcript is read again.
 */
export function openingTurnOrigin(workItem: WorkItemRef): 'brief' | 'human' {
  return workItem.type === 'task' || workItem.type === 'schedule' ? 'brief' : 'human';
}

export interface MemberMemoryStore {
  read(projectKey: string, handle: string): Promise<string>;
  append(projectKey: string, handle: string, note: string): Promise<void>;
}

export interface WorktreeInfo {
  /** Absolute shared git directory where commits and branches are written. */
  gitDir?: string;
  path: string;
  branch: string;
  /** Repo name from the project config. */
  repo: string;
}

export interface WorktreeManager {
  /** Creates (or reuses) a git worktree + branch for a task in one of the project's repos. */
  ensureForTask(args: {
    project: ProjectConfig;
    repoName: string;
    taskKey: string;
    title: string;
  }): Promise<WorktreeInfo>;
  /** Finds the existing worktree at the task's deterministic path without creating anything. */
  find(args: { project: ProjectConfig; repoName: string; taskKey: string }): Promise<WorktreeInfo | null>;
  status(path: string): Promise<{ dirty: boolean; unpushedCommits: number }>;
  /** Refuses to remove a dirty worktree unless force is set. Keeps the branch. */
  remove(args: { path: string; force?: boolean }): Promise<void>;
}

export interface WorktreeManagerOptions {
  /** Where worktrees are created, e.g. ~/.projectman/worktrees. */
  rootDir: string;
  logger: FastifyBaseLogger;
}
