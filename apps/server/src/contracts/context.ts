import type { FastifyBaseLogger } from 'fastify';
import type { AgentSandbox, SubagentDefinition } from './runner';
import type { SessionPolicy } from './session-policy';
import type {
  AiMemberConfig,
  Attachment,
  MemberView,
  PausePoint,
  ProjectConfig,
  SessionState,
  Stage,
  Task,
  TaskRelation,
  TimelineEvent,
  WorkDoing,
  WorkItemRef,
} from '@projectman/shared';

/**
 * What an AI member knows when a fresh session starts. Owned by src/context and
 * src/worktree.
 */

export interface ContextPackInput {
  /**
   * The server runs the full test before review on this task's handed-over commits (PM-217, PM-332): the
   * executor is available and the task's repository has a `reviewTest`. The developer's steps then ask
   * for targeted tests only. Omitted when false.
   */
  serverFullTest?: boolean;
  /** Rebuilt from actual placement for every start, including resumes. */
  sessionPolicy?: SessionPolicy;
  /**
   * The CLI's own sandbox the session's shell commands run in (PM-167), as the runner gets it;
   * absent when they are not sandboxed. A Claude member is told its boundary instead of the
   * server's command forms.
   */
  sandbox?: AgentSandbox;
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
  /**
   * The readable attachments of the task's direct parent (PM-228), named in the kick-off brief next to the
   * task's own, since the team tools read them with the parent's key. Omitted when the task has no parent,
   * the parent has none, or the member may not read the parent.
   */
  parentAttachments?: { taskKey: string; attachments: Attachment[] };
  /**
   * The member's other running sessions on cards that belong with this task (PM-184), for the brief
   * and the continue message. Omitted (or empty) when there are none.
   */
  relatedSessions?: RelatedSession[];
  /**
   * The task's relations to other cards, both directions (PM-192), listed by kind in the kick-off
   * brief. Omitted (or empty) when it has none.
   */
  relations?: TaskRelation[];
  /**
   * The theme the task belongs to, its own or its parent's (PM-192), named in the kick-off brief. Omitted
   * when it has none.
   */
  theme?: Pick<Task, 'key' | 'title' | 'stageId' | 'status'>;
  /**
   * The commit the member's session reviewed in its last round on this task (PM-213). Set only for a
   * resumed reviewer whose round before pinned one; the continue message names it, so the reviewer
   * reads only what changed since.
   */
  lastReviewedCommit?: string;
  /** Other members' sessions working on the task now (PM-249). Omitted when none. */
  cardWorkers?: CardWorker[];
  /**
   * Questions asked on the card (PM-249), oldest first: a new conversation gets the latest ones, a
   * resumed one those since it last ran. Omitted when none.
   */
  cardQuestions?: CardQuestion[];
}

/** A member whose session works on the card now, as another member's brief names it (PM-249). */
export interface CardWorker {
  handle: string;
  displayName: string;
  /** `roleLabel(member.role, customRoles)`, as in the team list of the system prompt. */
  role: string;
  state: SessionState;
  /** `Session.doing`, when the member gave a sentence. */
  doing?: WorkDoing;
}

/** A question an AI member asked people on the card with ask_human (PM-249). */
export interface CardQuestion {
  inboxItemId: string;
  /** The member who asked (the inbox item's `source`). */
  asker: string;
  /** `payload.question`, else the item's title. */
  question: string;
  askedAt: string;
  /** The `question_asked` timeline event; get_task event_id reads the whole question. */
  askedEventId: string | null;
  /** Expired and cancelled questions are left out. */
  state: 'open' | 'answered';
  /** `answerText(item)`, `resolution.by` and `.at`, and the `question_answered` event. */
  answer?: { by: string; text: string; at: string; eventId: string | null };
}

/** How a card relates to the task a session starts on. */
export type CardRelation = 'parent' | 'subtask' | 'prerequisite' | 'prerequisite_of';

/** A running session of the same member on a card that belongs with the task (`prerequisite_of`: that card has this one as its prerequisite). */
export interface RelatedSession {
  taskKey: string;
  title: string;
  relation: CardRelation;
  state: SessionState;
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
  /**
   * What a resumed task session is told first about the card now (PM-249): who else works on it and
   * the questions asked or answered since it last ran; null when neither.
   */
  standing: string | null;
  /**
   * Subagents the session is started with (`StartSessionSpec.subagents`): the cheap subagent when
   * the member has one (PM-179), which the system prompt then tells it how to use; else empty.
   */
  subagents: SubagentDefinition[];
}

export interface ContextPackBuilder {
  build(input: ContextPackInput): ContextPack;
  /**
   * What the compaction of a conversation is told to keep (PM-213, English prompt text). Absent:
   * the builder has no compaction text, and sessions are never compacted.
   */
  readonly compactInstruction?: string;
  /**
   * What a session is told when a pause ended (PM-219, English prompt text): where it was cut, and
   * whether its process was started again (`restarted`). Absent: no nudge, the session just goes on.
   */
  pauseNudge?(input: { point: PausePoint; tool: string | null; restarted: boolean }): string;
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
  /** The worktree's own admin directory inside `gitDir` (`worktrees/<name>`, PM-399). */
  worktreeGitDir?: string;
  path: string;
  branch: string;
  /** Repo name from the project config. */
  repo: string;
}

/**
 * The head of the branch a task's developer hands over (PM-183): its commit, and whether the
 * developer's working directory holds uncommitted work (`changes` files modified, added or
 * untracked). Dirty work is not part of the commit.
 */
export interface SourceHead {
  commit: string;
  branch: string;
  dirty: boolean;
  changes: number;
  /** The developer's working directory the head was read from. */
  path: string;
  /** When the commit was made (ISO time, the committer date); null when git did not say. */
  committedAt: string | null;
}

/** Why the worktree dependencies were left as they were (PM-412). */
export type DependencySkip =
  | 'present'
  | 'disabled'
  | 'not_worktree'
  | 'no_lockfile'
  | 'not_ignored'
  | 'no_reference'
  | 'unsupported'
  | 'reference_changed'
  | 'target_changed'
  | 'failed';

export type DependencyRefreshResult =
  | { status: 'cloned' | 'refreshed'; reference: string; dirs: string[]; ms: number }
  | { status: 'skipped'; reason: DependencySkip };

export interface WorktreeManager {
  /** Clones missing or stale task dependencies. Never rejects or installs packages. */
  refreshDependencies(path: string): Promise<DependencyRefreshResult>;
  /** The head and cleanliness of a task worktree; null when it is detached or has no commit. */
  head(path: string): Promise<SourceHead | null>;
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
  /** PM-332: clone node_modules into a task worktree from an installed checkout with the same lockfile (APFS clonefile, macOS). Default false. */
  cloneDependencies?: boolean;
}

/* ---------- member workspaces (PM-138) ---------- */

/** One durable workspace per project x member x repository. */
export interface MemberWorkspaceKey {
  project: ProjectConfig;
  repoName: string;
  member: string;
}

/**
 * The directories of a member workspace, `<rootDir>/<PROJECT>/<handle>/<repo>/`: `repo` is an
 * independent clone with its own `.git` (no shared object store, alternates or worktree link),
 * `cache` and `tmp` belong to the member alone.
 */
export interface MemberWorkspaceInfo {
  path: string;
  gitDir: string;
  cacheDir: string;
  tempDir: string;
}

/** What a workspace has checked out after preparation. */
export interface WorkspaceCheckout {
  /** The branch checked out; null for a detached review checkout. */
  branch: string | null;
  /** The commit HEAD points at. */
  head: string;
}

/** A committed branch tip in another repository (a teammate's workspace or the project repository). */
export interface WorkspaceSource {
  /** A repository the server may read: a member workspace or the project's repository. */
  path: string;
  /** Full ref name, e.g. `refs/heads/AR-2-fix` or `refs/remotes/origin/AR-2-fix`. */
  ref: string;
}

/**
 * Refusals of the member workspace manager (`MemberWorkspaceError.code`):
 * - `workspace_dirty`: uncommitted changes, untracked files or an unfinished git operation
 *   (`details.operation`); nothing is stashed, reset or cleaned;
 * - `workspace_fetch_failed`: the default branch could not be fetched fresh, so no new task branch
 *   starts from a stale base;
 * - `workspace_branch_missing`: the task's recorded branch is gone from the workspace;
 * - `workspace_source_missing`: the commit under review is not on the handed-over branch;
 * - `workspace_invalid`: the directory is not a workspace this manager made (a worktree link,
 *   alternates, a symlink, another repository).
 */
export type MemberWorkspaceErrorCode =
  | 'workspace_dirty'
  | 'workspace_fetch_failed'
  | 'workspace_branch_missing'
  | 'workspace_source_missing'
  | 'workspace_invalid';

export interface MemberWorkspaceManager {
  /** Where the workspace is (or would be), without creating anything. */
  location(key: MemberWorkspaceKey): Promise<MemberWorkspaceInfo>;
  /**
   * The member's own directory for sessions with no repository to work in (a general chat, a
   * schedule run, a task without a repository), made when missing: `<root>/<PROJECT>/<handle>/.home`
   * (PM-141, the managed VM's `member_workspace` placement).
   */
  home(key: { projectKey: string; member: string }): Promise<string>;
  /**
   * Creates the workspace when it is missing (a clone of the project's repository without
   * hardlinks or alternates); `created` tells whether it was made now.
   */
  ensure(key: MemberWorkspaceKey): Promise<MemberWorkspaceInfo & { created: boolean }>;
  /** Uncommitted work or an unfinished git operation, and what is checked out. */
  status(key: MemberWorkspaceKey): Promise<{
    dirty: boolean;
    operation: string | null;
    checkout: WorkspaceCheckout | null;
  }>;
  /**
   * The commit the workspace's own `branch` points at (PM-183), and whether the workspace holds
   * uncommitted work while that branch is checked out (work on another branch is not the task's);
   * null when the workspace lacks the branch.
   */
  sourceHead(key: MemberWorkspaceKey, branch: string): Promise<SourceHead | null>;
  /**
   * Fetches the default branch fresh (the project repository's `origin` first, when it has one)
   * and returns its commit; `workspace_fetch_failed` when a fetch fails.
   */
  fetchBase(key: MemberWorkspaceKey): Promise<{ branch: string; commit: string }>;
  /**
   * A branch of `taskKey` (`<KEY>` or `<KEY>-*`, `preferred` first): in the workspace (`source`
   * null), else in the project repository's branches or its `origin` tracking branches.
   */
  findTaskBranch(
    key: MemberWorkspaceKey,
    taskKey: string,
    preferred?: string,
  ): Promise<{ branch: string; source: WorkspaceSource | null } | null>;
  /** The commit a branch of another repository points at; null when it has none. */
  resolveSource(source: WorkspaceSource): Promise<string | null>;
  /**
   * Puts a clean workspace on a task branch, never resetting, stashing or cleaning:
   * - `continue`: the branch must exist in the workspace (`workspace_branch_missing`);
   * - `create`: a new branch at `startPoint` (a commit already fetched, e.g. by `fetchBase`);
   * - `fetch`: the branch is fetched from `source` (committed work only) when the workspace lacks it.
   */
  checkoutTaskBranch(
    key: MemberWorkspaceKey,
    target:
      | { mode: 'continue'; branch: string }
      | { mode: 'create'; branch: string; startPoint: string }
      | { mode: 'fetch'; branch: string; source: WorkspaceSource },
  ): Promise<WorkspaceCheckout>;
  /**
   * Detaches a clean workspace at `commit`, fetched from `source` (committed work only);
   * `workspace_source_missing` when the commit is not on that branch any more.
   */
  checkoutReview(
    key: MemberWorkspaceKey,
    source: WorkspaceSource,
    commit: string,
  ): Promise<WorkspaceCheckout>;
  /**
   * Where the server reads a committed branch of the workspace from (publishing, PM-142): the
   * workspace itself when the server owns its files, else a bundle (`bundle: true`) the member's
   * worker made of that branch, copied into the server's own spool, so the server never runs git
   * in a worker's repository (PM-140). `done` removes what was made.
   */
  exportBranch(
    key: MemberWorkspaceKey,
    branch: string,
  ): Promise<{ path: string; bundle: boolean; done(): Promise<void> }>;
}

export interface MemberWorkspaceManagerOptions {
  /** Where member workspaces live, e.g. ~/.projectman/workspaces. */
  rootDir: string;
  logger: FastifyBaseLogger;
}
