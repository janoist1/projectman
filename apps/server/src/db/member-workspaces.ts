import type { Db } from './database';

/** The session process that holds a member workspace (the reservation). */
export interface WorkspaceHolder {
  sessionId: string;
  taskKey: string;
  /** The process of the session (the leader of its process group); null until it started. */
  pid: number | null;
  since: string;
}

/** A member's durable workspace for one repository of a project (PM-138). */
export interface MemberWorkspaceRecord {
  id: string;
  projectKey: string;
  member: string;
  repo: string;
  path: string;
  /** Goes up when the workspace is made again (or moves): older conversations do not belong to it. */
  generation: number;
  createdAt: string;
  holder: WorkspaceHolder | null;
}

/** What a member's task uses in a workspace. */
export interface TaskWorkspaceBinding {
  projectKey: string;
  taskKey: string;
  member: string;
  workspaceId: string;
  /** `work`: the task's branch; `review`: a pinned commit of the handed-over branch. */
  kind: 'work' | 'review';
  /** work: the task branch. */
  branch: string | null;
  /** work: the default branch commit a new branch started from; review: the round's review base. */
  baseCommit: string | null;
  /** review: the repository and ref the commit was handed over in. */
  sourcePath: string | null;
  sourceRef: string | null;
  /** review: the pinned commit; work: the commit a taken-over branch continued from. */
  sourceCommit: string | null;
  /** review: the round number (1, 2, …); 0 for work. */
  round: number;
  /** review: a new round is due (the task entered a stage, the developer asked for a re-review). */
  refresh: boolean;
  /** The workspace generation the binding's conversation belongs to. */
  generation: number;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceRow {
  id: string;
  project_key: string;
  member: string;
  repo: string;
  path: string;
  generation: number;
  created_at: string;
  holder_session_id: string | null;
  holder_task_key: string | null;
  holder_pid: number | null;
  held_since: string | null;
}

interface BindingRow {
  project_key: string;
  task_key: string;
  member: string;
  workspace_id: string;
  kind: 'work' | 'review';
  branch: string | null;
  base_commit: string | null;
  source_path: string | null;
  source_ref: string | null;
  source_commit: string | null;
  round: number;
  refresh: number;
  generation: number;
  created_at: string;
  updated_at: string;
}

const toWorkspace = (r: WorkspaceRow): MemberWorkspaceRecord => ({
  id: r.id,
  projectKey: r.project_key,
  member: r.member,
  repo: r.repo,
  path: r.path,
  generation: r.generation,
  createdAt: r.created_at,
  holder:
    r.holder_session_id && r.holder_task_key
      ? {
          sessionId: r.holder_session_id,
          taskKey: r.holder_task_key,
          pid: r.holder_pid,
          since: r.held_since ?? '',
        }
      : null,
});

const toBinding = (r: BindingRow): TaskWorkspaceBinding => ({
  projectKey: r.project_key,
  taskKey: r.task_key,
  member: r.member,
  workspaceId: r.workspace_id,
  kind: r.kind,
  branch: r.branch,
  baseCommit: r.base_commit,
  sourcePath: r.source_path,
  sourceRef: r.source_ref,
  sourceCommit: r.source_commit,
  round: r.round,
  refresh: r.refresh !== 0,
  generation: r.generation,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createMemberWorkspaceRepository(db: Db) {
  const statements = {
    get: db.prepare('SELECT * FROM member_workspaces WHERE id = ?'),
    find: db.prepare('SELECT * FROM member_workspaces WHERE project_key = ? AND member = ? AND repo = ?'),
    findByPath: db.prepare('SELECT * FROM member_workspaces WHERE path = ?'),
    insert: db.prepare(
      `INSERT INTO member_workspaces (id, project_key, member, repo, path, generation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    relocate: db.prepare('UPDATE member_workspaces SET path = ?, generation = ? WHERE id = ?'),
    hold: db.prepare(
      `UPDATE member_workspaces SET holder_session_id = ?, holder_task_key = ?, holder_pid = ?, held_since = ?
       WHERE id = ?`,
    ),
    holderPid: db.prepare(
      'UPDATE member_workspaces SET holder_pid = ? WHERE id = ? AND holder_session_id = ?',
    ),
    release: db.prepare(
      `UPDATE member_workspaces SET holder_session_id = NULL, holder_task_key = NULL, holder_pid = NULL,
         held_since = NULL WHERE id = ? AND holder_session_id = ?`,
    ),
    heldBy: db.prepare('SELECT * FROM member_workspaces WHERE holder_session_id = ?'),
    binding: db.prepare(
      `SELECT * FROM task_workspace_bindings
       WHERE project_key = ? AND task_key = ? AND member = ? AND workspace_id = ?`,
    ),
    bindingsOfTask: db.prepare(
      'SELECT * FROM task_workspace_bindings WHERE project_key = ? AND task_key = ? ORDER BY updated_at, member',
    ),
    upsertBinding: db.prepare(
      `INSERT INTO task_workspace_bindings (project_key, task_key, member, workspace_id, kind, branch,
         base_commit, source_path, source_ref, source_commit, round, refresh, generation, created_at, updated_at)
       VALUES (@projectKey, @taskKey, @member, @workspaceId, @kind, @branch, @baseCommit, @sourcePath,
         @sourceRef, @sourceCommit, @round, @refresh, @generation, @createdAt, @updatedAt)
       ON CONFLICT (project_key, task_key, member, workspace_id) DO UPDATE SET kind = excluded.kind,
         branch = excluded.branch, base_commit = excluded.base_commit, source_path = excluded.source_path,
         source_ref = excluded.source_ref, source_commit = excluded.source_commit, round = excluded.round,
         refresh = excluded.refresh, generation = excluded.generation, updated_at = excluded.updated_at`,
    ),
    refreshTask: db.prepare(
      `UPDATE task_workspace_bindings SET refresh = 1
       WHERE project_key = ? AND task_key = ? AND kind = 'review'`,
    ),
    refreshMember: db.prepare(
      `UPDATE task_workspace_bindings SET refresh = 1
       WHERE project_key = ? AND task_key = ? AND member = ? AND kind = 'review'`,
    ),
  };

  return {
    get(id: string): MemberWorkspaceRecord | null {
      const row = statements.get.get(id) as WorkspaceRow | undefined;
      return row ? toWorkspace(row) : null;
    },
    find(projectKey: string, member: string, repo: string): MemberWorkspaceRecord | null {
      const row = statements.find.get(projectKey, member, repo) as WorkspaceRow | undefined;
      return row ? toWorkspace(row) : null;
    },
    findByPath(path: string): MemberWorkspaceRecord | null {
      const row = statements.findByPath.get(path) as WorkspaceRow | undefined;
      return row ? toWorkspace(row) : null;
    },
    insert(record: Omit<MemberWorkspaceRecord, 'holder'>): void {
      statements.insert.run(
        record.id,
        record.projectKey,
        record.member,
        record.repo,
        record.path,
        record.generation,
        record.createdAt,
      );
    },
    relocate(id: string, path: string, generation: number): void {
      statements.relocate.run(path, generation, id);
    },
    /** Records the holder, replacing whoever held it (the caller checked that it may). */
    hold(id: string, holder: WorkspaceHolder): void {
      statements.hold.run(holder.sessionId, holder.taskKey, holder.pid, holder.since, id);
    },
    /** The started process of the session that holds the workspace. */
    setHolderPid(id: string, sessionId: string, pid: number): void {
      statements.holderPid.run(pid, id, sessionId);
    },
    /** Frees the workspace when the session holds it; another holder is left alone. */
    release(id: string, sessionId: string): void {
      statements.release.run(id, sessionId);
    },
    /** The workspaces a session holds. */
    heldBy(sessionId: string): MemberWorkspaceRecord[] {
      return (statements.heldBy.all(sessionId) as WorkspaceRow[]).map(toWorkspace);
    },
    binding(
      projectKey: string,
      taskKey: string,
      member: string,
      workspaceId: string,
    ): TaskWorkspaceBinding | null {
      const row = statements.binding.get(projectKey, taskKey, member, workspaceId) as BindingRow | undefined;
      return row ? toBinding(row) : null;
    },
    /** The bindings of a task, least recently updated first. */
    bindingsOfTask(projectKey: string, taskKey: string): TaskWorkspaceBinding[] {
      return (statements.bindingsOfTask.all(projectKey, taskKey) as BindingRow[]).map(toBinding);
    },
    saveBinding(binding: TaskWorkspaceBinding): void {
      statements.upsertBinding.run({ ...binding, refresh: binding.refresh ? 1 : 0 });
    },
    /** A new review round is due for the task's reviewers (all of them, or one member). */
    requestReviewRound(projectKey: string, taskKey: string, member?: string): number {
      return (
        member
          ? statements.refreshMember.run(projectKey, taskKey, member)
          : statements.refreshTask.run(projectKey, taskKey)
      ).changes;
    },
  };
}
