import type { Task, TaskLink } from '@projectman/shared';
import { legacyCheckLabels } from '@projectman/templates';
import type { Db } from './database';
import { parseJson, toJson } from './json';

interface TaskRow {
  parent_key: string | null;
  id: string;
  project_key: string;
  key: string;
  seq: number;
  title: string;
  description: string;
  stage_id: string;
  status: string;
  assignee: string | null;
  repo: string | null;
  priority: number | null;
  labels: string;
  checks: string;
  visibility: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface LinkRow {
  author: string | null;
  id: number;
  task_id: string;
  kind: string;
  ref: string;
  repo: string;
  title: string | null;
  state: string | null;
}

export interface PullRequestLinkRef {
  projectKey: string;
  taskKey: string;
  repo: string;
  number: number;
  state: string | null;
}

function toLink(r: LinkRow): TaskLink {
  const link: TaskLink = { kind: r.kind as TaskLink['kind'], ref: r.ref };
  if (r.author) link.author = r.author;
  if (r.repo) link.repo = r.repo;
  if (r.title !== null) link.title = r.title;
  if (r.state !== null) link.state = r.state;
  return link;
}

function toTask(r: TaskRow, links: TaskLink[]): Task {
  return {
    parentKey: r.parent_key,
    id: r.id,
    projectKey: r.project_key,
    key: r.key,
    title: r.title,
    description: r.description,
    stageId: r.stage_id,
    status: r.status as Task['status'],
    assignee: r.assignee,
    repo: r.repo,
    priority: r.priority,
    // Checks recorded before labels read as their labels; the next write clears the column.
    labels: [
      ...new Set([
        ...parseJson<string[]>(r.labels, []),
        ...legacyCheckLabels(parseJson<Record<string, string>>(r.checks, {})),
      ]),
    ],
    links,
    visibility: r.visibility as Task['visibility'],
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
  };
}

/** Sequence number of a task key ("AR-21" -> 21). */
export function taskSeq(key: string): number {
  return Number(key.slice(key.lastIndexOf('-') + 1));
}

export function createTaskRepository(db: Db) {
  const linksOf = db.prepare('SELECT * FROM task_links WHERE task_id = ? ORDER BY id');

  function withLinks(rows: TaskRow[]): Task[] {
    if (rows.length === 0) return [];
    if (rows.length === 1) {
      const row = rows[0]!;
      return [toTask(row, (linksOf.all(row.id) as LinkRow[]).map(toLink))];
    }
    const byTask = new Map<string, TaskLink[]>();
    const all = db
      .prepare(
        `SELECT l.* FROM task_links l JOIN tasks t ON t.id = l.task_id
         WHERE t.project_key = ? ORDER BY l.id`,
      )
      .all(rows[0]!.project_key) as LinkRow[];
    for (const link of all) {
      const list = byTask.get(link.task_id) ?? [];
      list.push(toLink(link));
      byTask.set(link.task_id, list);
    }
    return rows.map((r) => toTask(r, byTask.get(r.id) ?? []));
  }

  /** Adds a link or refreshes its title/state; returns what happened. */
  function upsertLink(taskId: string, link: TaskLink, at: string): 'inserted' | 'updated' | 'unchanged' {
    const repo = link.repo ?? '';
    const existing = db
      .prepare('SELECT * FROM task_links WHERE task_id = ? AND kind = ? AND repo = ? AND ref = ?')
      .get(taskId, link.kind, repo, link.ref) as LinkRow | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO task_links (task_id, kind, ref, repo, title, state, created_at, updated_at, author)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        taskId,
        link.kind,
        link.ref,
        repo,
        link.title ?? null,
        link.state ?? null,
        at,
        at,
        link.author ?? null,
      );
      return 'inserted';
    }
    const title = link.title ?? existing.title;
    const state = link.state ?? existing.state;
    const author = existing.author ?? link.author ?? null;
    if (title === existing.title && state === existing.state && author === existing.author)
      return 'unchanged';
    db.prepare('UPDATE task_links SET title = ?, state = ?, author = ?, updated_at = ? WHERE id = ?').run(
      title,
      state,
      author,
      at,
      existing.id,
    );
    return 'updated';
  }

  return {
    upsertLink,

    insert(task: Task): void {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, assignee,
             repo, priority, labels, checks, visibility, created_by, created_at, updated_at, closed_at, parent_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          task.id,
          task.projectKey,
          task.key,
          taskSeq(task.key),
          task.title,
          task.description,
          task.stageId,
          task.status,
          task.assignee,
          task.repo,
          task.priority,
          toJson(task.labels),
          '{}',
          task.visibility,
          task.createdBy,
          task.createdAt,
          task.updatedAt,
          task.closedAt,
          task.parentKey ?? null,
        );
        for (const link of task.links) upsertLink(task.id, link, task.createdAt);
      })();
    },

    get(key: string): Task | null {
      const row = db.prepare('SELECT * FROM tasks WHERE key = ?').get(key) as TaskRow | undefined;
      return row ? withLinks([row])[0]! : null;
    },

    getById(id: string): Task | null {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
      return row ? withLinks([row])[0]! : null;
    },

    list(projectKey: string): Task[] {
      const rows = db
        .prepare('SELECT * FROM tasks WHERE project_key = ? ORDER BY seq')
        .all(projectKey) as TaskRow[];
      return withLinks(rows);
    },

    listByAssignee(projectKey: string, handle: string): Task[] {
      const rows = db
        .prepare('SELECT * FROM tasks WHERE project_key = ? AND assignee = ? ORDER BY seq')
        .all(projectKey, handle) as TaskRow[];
      return rows.map((r) => toTask(r, (linksOf.all(r.id) as LinkRow[]).map(toLink)));
    },

    /** Updates the task's own fields (links are managed with upsertLink). */
    update(task: Task): void {
      db.prepare(
        `UPDATE tasks SET title = ?, description = ?, stage_id = ?, status = ?, assignee = ?, repo = ?,
           priority = ?, labels = ?, checks = ?, visibility = ?, updated_at = ?, closed_at = ?, parent_key = ?
         WHERE id = ?`,
      ).run(
        task.title,
        task.description,
        task.stageId,
        task.status,
        task.assignee,
        task.repo,
        task.priority,
        toJson(task.labels),
        '{}',
        task.visibility,
        task.updatedAt,
        task.closedAt,
        task.parentKey ?? null,
        task.id,
      );
    },

    /** Updates every link to the same pull request; returns the keys of the tasks that changed. */
    updatePullRequestLinks(
      repo: string,
      number: number,
      patch: { state: string; title?: string },
      at: string,
    ): string[] {
      const rows = db
        .prepare(
          `SELECT l.*, t.key AS task_key FROM task_links l JOIN tasks t ON t.id = l.task_id
           WHERE l.kind = 'pull_request' AND l.repo = ? AND l.ref = ?`,
        )
        .all(repo, String(number)) as Array<LinkRow & { task_key: string }>;
      const changed: string[] = [];
      for (const row of rows) {
        const title = patch.title ?? row.title;
        if (row.state === patch.state && row.title === title) continue;
        db.prepare('UPDATE task_links SET state = ?, title = ?, updated_at = ? WHERE id = ?').run(
          patch.state,
          title,
          at,
          row.id,
        );
        changed.push(row.task_key);
      }
      return changed;
    },

    /**
     * Remembers the head commit of a pull request on every link to it. Returns the tasks whose
     * link had seen another head before: new commits landed there. A first sighting is not a change.
     */
    recordPullRequestHead(
      repo: string,
      number: number,
      headSha: string,
      at: string,
    ): Array<{ projectKey: string; taskKey: string }> {
      const rows = db
        .prepare(
          `SELECT l.id, l.head_sha, t.project_key AS projectKey, t.key AS taskKey FROM task_links l
           JOIN tasks t ON t.id = l.task_id
           WHERE l.kind = 'pull_request' AND l.repo = ? AND l.ref = ? ORDER BY t.seq`,
        )
        .all(repo, String(number)) as Array<{
        id: number;
        head_sha: string | null;
        projectKey: string;
        taskKey: string;
      }>;
      const moved = new Map<string, { projectKey: string; taskKey: string }>();
      for (const row of rows) {
        if (row.head_sha === headSha) continue;
        db.prepare('UPDATE task_links SET head_sha = ?, updated_at = ? WHERE id = ?').run(
          headSha,
          at,
          row.id,
        );
        if (row.head_sha !== null)
          moved.set(`${row.projectKey}/${row.taskKey}`, { projectKey: row.projectKey, taskKey: row.taskKey });
      }
      return [...moved.values()];
    },

    /** A matched GitHub identity supersedes the assignee fallback. */
    attributePullRequestAuthor(
      projectKey: string,
      repo: string,
      number: number,
      author: string,
      at: string,
    ): boolean {
      const result = db
        .prepare(
          `UPDATE task_links SET author = ?, updated_at = ?
         WHERE kind = 'pull_request' AND repo = ? AND ref = ?
           AND (author IS NULL OR author <> ?)
           AND task_id IN (SELECT id FROM tasks WHERE project_key = ?)`,
        )
        .run(author, at, repo, String(number), author, projectKey);
      return result.changes > 0;
    },

    /** Tasks (project key + task key) linking a pull request. */
    findByPullRequest(repo: string, number: number): Array<{ projectKey: string; taskKey: string }> {
      return db
        .prepare(
          `SELECT DISTINCT t.project_key AS projectKey, t.key AS taskKey FROM task_links l
           JOIN tasks t ON t.id = l.task_id
           WHERE l.kind = 'pull_request' AND l.repo = ? AND l.ref = ? ORDER BY t.seq`,
        )
        .all(repo, String(number)) as Array<{ projectKey: string; taskKey: string }>;
    },

    /** Pull request links of tasks that are still open, whose PR is not merged or closed yet. */
    listWatchablePullRequests(): PullRequestLinkRef[] {
      const rows = db
        .prepare(
          `SELECT l.repo, l.ref, l.state, t.key AS task_key, t.project_key FROM task_links l
           JOIN tasks t ON t.id = l.task_id
           WHERE l.kind = 'pull_request' AND l.repo <> ''
             AND (l.state IS NULL OR l.state NOT IN ('merged', 'closed'))
             AND t.status NOT IN ('done', 'cancelled')`,
        )
        .all() as Array<{
        repo: string;
        ref: string;
        state: string | null;
        task_key: string;
        project_key: string;
      }>;
      return rows
        .filter((r) => /^\d+$/.test(r.ref))
        .map((r) => ({
          projectKey: r.project_key,
          taskKey: r.task_key,
          repo: r.repo,
          number: Number(r.ref),
          state: r.state,
        }));
    },
  };
}
