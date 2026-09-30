import type { FastifyBaseLogger } from 'fastify';
import type {
  AiMemberConfig,
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
}

export interface ContextPackBuilder {
  build(input: ContextPackInput): ContextPack;
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
