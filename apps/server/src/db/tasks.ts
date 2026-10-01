import { taskSeq } from '@projectman/shared';
import type { Task, TaskLink } from '@projectman/shared';
import { legacyCheckLabels } from '@projectman/templates';
import type { Statement } from 'better-sqlite3';
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

/** The task fields one write changes; links are written with `upsertLink`. */
export type TaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'stageId'
    | 'status'
    | 'assignee'
    | 'repo'
    | 'priority'
    | 'labels'
    | 'visibility'
    | 'updatedAt'
    | 'closedAt'
    | 'parentKey'
  >
>;

const COLUMNS: Record<keyof TaskPatch, string> = {
  title: 'title',
  description: 'description',
  stageId: 'stage_id',
  status: 'status',
  assignee: 'assignee',
  repo: 'repo',
  priority: 'priority',
  labels: 'labels',
  visibility: 'visibility',
  updatedAt: 'updated_at',
  closedAt: 'closed_at',
  parentKey: 'parent_key',
};

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
    // Checks recorded before labels read as their labels; the next label write clears the column.
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

export function createTaskRepository(db: Db) {
  const statements = {
    get: db.prepare('SELECT * FROM tasks WHERE key = ?'),
    list: db.prepare('SELECT * FROM tasks WHERE project_key = ? ORDER BY seq'),
    listLinks: db.prepare(
      `SELECT l.* FROM task_links l JOIN tasks t ON t.id = l.task_id
       WHERE t.project_key = ? ORDER BY l.id`,
    ),
    byAssignee: db.prepare('SELECT * FROM tasks WHERE project_key = ? AND assignee = ? ORDER BY seq'),
    byAssigneeLinks: db.prepare(
      `SELECT l.* FROM task_links l JOIN tasks t ON t.id = l.task_id
       WHERE t.project_key = ? AND t.assignee = ? ORDER BY l.id`,
    ),
    children: db.prepare('SELECT * FROM tasks WHERE project_key = ? AND parent_key = ? ORDER BY seq'),
    childrenLinks: db.prepare(
      `SELECT l.* FROM task_links l JOIN tasks t ON t.id = l.task_id
       WHERE t.project_key = ? AND t.parent_key = ? ORDER BY l.id`,
    ),
    linksOf: db.prepare('SELECT * FROM task_links WHERE task_id = ? ORDER BY id'),
    // Uses the `task_links_ref` index: card relations are links with no repository.
    linking: db.prepare(
      `SELECT t.* FROM task_links l JOIN tasks t ON t.id = l.task_id
       WHERE l.kind = ? AND l.repo = '' AND l.ref = ? AND t.project_key = ? ORDER BY t.seq`,
    ),
    deleteLink: db.prepare(`DELETE FROM task_links WHERE task_id = ? AND kind = ? AND repo = '' AND ref = ?`),
    insert: db.prepare(
      `INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, assignee,
         repo, priority, labels, checks, visibility, created_by, created_at, updated_at, closed_at, parent_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    findLink: db.prepare('SELECT * FROM task_links WHERE task_id = ? AND kind = ? AND repo = ? AND ref = ?'),
    insertLink: db.prepare(
      `INSERT INTO task_links (task_id, kind, ref, repo, title, state, created_at, updated_at, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateLink: db.prepare(
      'UPDATE task_links SET title = ?, state = ?, author = ?, updated_at = ? WHERE id = ?',
    ),
    pullRequestLinks: db.prepare(
      `SELECT l.*, t.key AS task_key FROM task_links l JOIN tasks t ON t.id = l.task_id
       WHERE l.kind = 'pull_request' AND l.repo = ? AND l.ref = ?`,
    ),
    updateLinkState: db.prepare('UPDATE task_links SET state = ?, title = ?, updated_at = ? WHERE id = ?'),
    pullRequestHeads: db.prepare(
      `SELECT l.id, l.head_sha, t.project_key AS projectKey, t.key AS taskKey FROM task_links l
       JOIN tasks t ON t.id = l.task_id
       WHERE l.kind = 'pull_request' AND l.repo = ? AND l.ref = ? ORDER BY t.seq`,
    ),
    updateLinkHead: db.prepare('UPDATE task_links SET head_sha = ?, updated_at = ? WHERE id = ?'),
    attributeAuthor: db.prepare(
      `UPDATE task_links SET author = ?, updated_at = ?
       WHERE kind = 'pull_request' AND repo = ? AND ref = ?
         AND (author IS NULL OR author <> ?)
         AND (author_source IS NULL OR author_source <> 'published')
         AND task_id IN (SELECT id FROM tasks WHERE project_key = ?)`,
    ),
    publishAuthor: db.prepare(
      `UPDATE task_links SET author = ?, author_source = 'published', updated_at = ?
       WHERE id = ? AND (author_source IS NULL OR author_source <> 'published')`,
    ),
    findByPullRequest: db.prepare(
      `SELECT DISTINCT t.project_key AS projectKey, t.key AS taskKey FROM task_links l
       JOIN tasks t ON t.id = l.task_id
       WHERE l.kind = 'pull_request' AND l.repo = ? AND l.ref = ? ORDER BY t.seq`,
    ),
    watchablePullRequests: db.prepare(
      `SELECT l.repo, l.ref, l.state, t.key AS task_key, t.project_key FROM task_links l
       JOIN tasks t ON t.id = l.task_id
       WHERE l.kind = 'pull_request' AND l.repo <> ''
         AND (l.state IS NULL OR l.state NOT IN ('merged', 'closed'))
         AND t.status NOT IN ('done', 'cancelled')`,
    ),
  };
  /** UPDATE statements per set of changed columns. */
  const updates = new Map<string, Statement>();

  /** Tasks with their links; `links` reads the links of exactly these tasks in one query. */
  function withLinks(rows: TaskRow[], links: () => LinkRow[]): Task[] {
    if (rows.length === 0) return [];
    if (rows.length === 1) {
      const row = rows[0]!;
      return [toTask(row, (statements.linksOf.all(row.id) as LinkRow[]).map(toLink))];
    }
    const byTask = new Map<string, TaskLink[]>();
    for (const link of links()) {
      const list = byTask.get(link.task_id) ?? [];
      list.push(toLink(link));
      byTask.set(link.task_id, list);
    }
    return rows.map((r) => toTask(r, byTask.get(r.id) ?? []));
  }

  /** Adds a link or refreshes its title/state; returns what happened. */
  function upsertLink(taskId: string, link: TaskLink, at: string): 'inserted' | 'updated' | 'unchanged' {
    const repo = link.repo ?? '';
    const existing = statements.findLink.get(taskId, link.kind, repo, link.ref) as LinkRow | undefined;
    if (!existing) {
      statements.insertLink.run(
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
    statements.updateLink.run(title, state, author, at, existing.id);
    return 'updated';
  }

  /**
   * Adds or refreshes a link a publication made, and records `author` as its durable author: the
   * authenticated member who published it. The first publication of a link wins, and polling never
   * replaces it (`attributePullRequestAuthor` skips it). A link that exists without such provenance
   * (an earlier `link_pull_request`, or the login match) takes it over.
   */
  function recordPublication(
    taskId: string,
    link: TaskLink,
    author: string,
    at: string,
  ): 'inserted' | 'updated' | 'unchanged' {
    const result = upsertLink(taskId, link, at);
    const row = statements.findLink.get(taskId, link.kind, link.repo ?? '', link.ref) as LinkRow | undefined;
    if (!row) return result;
    const changed = statements.publishAuthor.run(author, at, row.id).changes > 0;
    return changed && result === 'unchanged' ? 'updated' : result;
  }

  return {
    upsertLink,
    recordPublication,

    insert(task: Task): void {
      db.transaction(() => {
        statements.insert.run(
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
      const row = statements.get.get(key) as TaskRow | undefined;
      return row ? withLinks([row], () => [])[0]! : null;
    },

    list(projectKey: string): Task[] {
      return withLinks(
        statements.list.all(projectKey) as TaskRow[],
        () => statements.listLinks.all(projectKey) as LinkRow[],
      );
    },

    listByAssignee(projectKey: string, handle: string): Task[] {
      return withLinks(
        statements.byAssignee.all(projectKey, handle) as TaskRow[],
        () => statements.byAssigneeLinks.all(projectKey, handle) as LinkRow[],
      );
    },

    /** The subtasks of a task. */
    children(projectKey: string, parentKey: string): Task[] {
      return withLinks(
        statements.children.all(projectKey, parentKey) as TaskRow[],
        () => statements.childrenLinks.all(projectKey, parentKey) as LinkRow[],
      );
    },

    /**
     * The tasks of the project that have a link of one of these kinds to `ref` (a task key): the
     * other direction of a card relation. Each task once, by number.
     */
    linking(projectKey: string, kinds: readonly string[], ref: string): Task[] {
      const rows = new Map<string, TaskRow>();
      for (const kind of kinds)
        for (const row of statements.linking.all(kind, ref, projectKey) as TaskRow[]) rows.set(row.id, row);
      return [...rows.values()]
        .sort((a, b) => a.seq - b.seq)
        .map((row) => toTask(row, (statements.linksOf.all(row.id) as LinkRow[]).map(toLink)));
    },

    /** Removes a card relation link; returns whether it was there. */
    removeLink(taskId: string, kind: string, ref: string): boolean {
      return statements.deleteLink.run(taskId, kind, ref).changes > 0;
    },

    /**
     * Writes only the fields in `patch`, so concurrent changes of other fields survive. Writing
     * labels also clears the legacy checks column they were read with.
     */
    update(id: string, patch: TaskPatch): void {
      const fields = (Object.keys(COLUMNS) as Array<keyof TaskPatch>).filter((f) => patch[f] !== undefined);
      if (fields.length === 0) return;
      const signature = fields.join(',');
      let statement = updates.get(signature);
      if (!statement) {
        const sets = fields.map((f) => `${COLUMNS[f]} = @${f}`);
        if (fields.includes('labels')) sets.push(`checks = '{}'`);
        statement = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`);
        updates.set(signature, statement);
      }
      const values: Record<string, unknown> = { id };
      for (const field of fields) values[field] = patch[field];
      if (patch.labels) values.labels = toJson(patch.labels);
      statement.run(values);
    },

    /** Updates every link to the same pull request; returns the keys of the tasks that changed. */
    updatePullRequestLinks(
      repo: string,
      number: number,
      patch: { state: string; title?: string },
      at: string,
    ): string[] {
      const rows = statements.pullRequestLinks.all(repo, String(number)) as Array<
        LinkRow & { task_key: string }
      >;
      const changed: string[] = [];
      for (const row of rows) {
        const title = patch.title ?? row.title;
        if (row.state === patch.state && row.title === title) continue;
        statements.updateLinkState.run(patch.state, title, at, row.id);
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
      const rows = statements.pullRequestHeads.all(repo, String(number)) as Array<{
        id: number;
        head_sha: string | null;
        projectKey: string;
        taskKey: string;
      }>;
      const moved = new Map<string, { projectKey: string; taskKey: string }>();
      for (const row of rows) {
        if (row.head_sha === headSha) continue;
        statements.updateLinkHead.run(headSha, at, row.id);
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
      return statements.attributeAuthor.run(author, at, repo, String(number), author, projectKey).changes > 0;
    },

    /** Tasks (project key + task key) linking a pull request. */
    findByPullRequest(repo: string, number: number): Array<{ projectKey: string; taskKey: string }> {
      return statements.findByPullRequest.all(repo, String(number)) as Array<{
        projectKey: string;
        taskKey: string;
      }>;
    },

    /** Pull request links of tasks that are still open, whose PR is not merged or closed yet. */
    listWatchablePullRequests(): PullRequestLinkRef[] {
      const rows = statements.watchablePullRequests.all() as Array<{
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
