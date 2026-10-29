import { TaskComplexity, taskSeq } from '@projectman/shared';
import type { CollectingSourceEvidence, RankedCard, Task, TaskLink, TaskPriority } from '@projectman/shared';
import type { Statement } from 'better-sqlite3';
import type { TaskSchedulingQuery } from '../contracts';
import type { Db } from './database';
import { parseJson, toJson } from './json';

/** Persisted values: never renumber these levels. */
const PRIORITY_COLUMN: Record<TaskPriority, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
const PRIORITY_LEVEL: Record<number, TaskPriority> = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };

interface TaskRow {
  kind: string;
  /** The theme stored on this card (none on a subtask). */
  theme_key: string | null;
  /** The theme the card reads: its parent's for a subtask, else its own. */
  effective_theme: string | null;
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
  board_rank: number;
  labels: string;
  visibility: string;
  created_by: string;
  created_at: string;
  stage_entered_at: string | null;
  updated_at: string;
  closed_at: string | null;
  complexity: string | null;
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

interface PullRequestLinkRef {
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
    | 'boardRank'
    | 'labels'
    | 'stageEnteredAt'
    | 'updatedAt'
    | 'closedAt'
    | 'parentKey'
    /** The theme to store: a card's own (null removes it), never a subtask's. */
    | 'themeKey'
  >
> & { complexity?: TaskComplexity | null };

const COLUMNS: Record<keyof TaskPatch, string> = {
  title: 'title',
  description: 'description',
  stageId: 'stage_id',
  status: 'status',
  assignee: 'assignee',
  repo: 'repo',
  priority: 'priority',
  boardRank: 'board_rank',
  labels: 'labels',
  stageEnteredAt: 'stage_entered_at',
  updatedAt: 'updated_at',
  closedAt: 'closed_at',
  parentKey: 'parent_key',
  themeKey: 'theme_key',
  complexity: 'complexity',
};

/**
 * A card as it is read: with the theme it shows. A subtask shows its parent's (read here, so a parent
 * changing theme writes nothing to its subtasks); any other card shows its own.
 */
const taskSelect = (index = '') =>
  `SELECT t.*, CASE WHEN t.parent_key IS NOT NULL THEN p.theme_key ELSE t.theme_key END
    AS effective_theme FROM tasks t${index ? ` INDEXED BY ${index}` : ''} LEFT JOIN tasks p ON p.key = t.parent_key`;
const TASK_SELECT = taskSelect();

/**
 * The scheduling reads (PM-770), each filtered in SQL. Sets travel as one bound JSON array. The partial
 * indexes `tasks_scheduling_*` serve the pull, open and closed reads (their literals match the index
 * conditions). The key reads are driven by the unique key index (`+t.project_key` keeps the planner from
 * walking the project's index range instead), the parent reads are pinned to `tasks_parent`
 * (without table statistics the planner would walk a project index). A test pins the plans.
 * The closing time is compared as a time (an old row may carry an offset), not as text; text that is no
 * time is left out, and the GLOB keeps SQLite from reading a bare number as a Julian day.
 */
export const SCHEDULING_SQL = {
  linksOfIds: 'SELECT * FROM task_links WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY id',
  keys: `${TASK_SELECT} WHERE +t.project_key = ? AND t.key IN (SELECT value FROM json_each(?)) ORDER BY t.seq`,
  children: `${taskSelect('tasks_parent')} WHERE t.project_key = ? AND t.parent_key IN (SELECT value FROM json_each(?))
      AND t.status NOT IN ('done', 'cancelled') ORDER BY t.seq`,
  childrenAll: `${taskSelect('tasks_parent')} WHERE t.project_key = ? AND t.parent_key IN (SELECT value FROM json_each(?))
    ORDER BY t.seq`,
  pullUrgent: `${TASK_SELECT} WHERE t.project_key = ? AND t.stage_id = ? AND t.kind = 'task' AND t.status = 'active'
      AND t.assignee IS NULL AND t.priority = 1 ORDER BY t.seq`,
  queue: `${TASK_SELECT} WHERE t.project_key = ? AND t.stage_id = ? AND t.kind = 'task' AND t.status = 'active'
      ORDER BY t.seq`,
  open: `${TASK_SELECT} WHERE t.project_key = ? AND t.status NOT IN ('done', 'cancelled') ORDER BY t.seq`,
  // The `list_tasks` page: the stage and assignee filters are optional (a stage names only `task` cards, a
  // theme carries the first stage's id), the newest change first. Open reads keep to the open partial index.
  listedOpen: `${TASK_SELECT} WHERE t.project_key = @projectKey AND t.status NOT IN ('done', 'cancelled')
      AND (@stageId IS NULL OR (t.kind = 'task' AND t.stage_id = @stageId))
      AND (@assignee IS NULL OR t.assignee = @assignee)
    ORDER BY t.updated_at DESC, t.key LIMIT @limit`,
  listedStatus: `${TASK_SELECT} WHERE t.project_key = @projectKey AND t.status = @status
      AND (@stageId IS NULL OR (t.kind = 'task' AND t.stage_id = @stageId))
      AND (@assignee IS NULL OR t.assignee = @assignee)
    ORDER BY t.updated_at DESC, t.key LIMIT @limit`,
  closed: `${TASK_SELECT} WHERE t.project_key = ? AND t.kind = 'task' AND t.status IN ('done', 'cancelled')
      AND t.closed_at IS NOT NULL AND t.seq > ?
      AND t.closed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'
      AND unixepoch(t.closed_at, 'subsec') <= unixepoch(?, 'subsec')
    ORDER BY t.seq LIMIT ?`,
} as const;

function toLink(r: LinkRow): TaskLink {
  const link: TaskLink = { kind: r.kind as TaskLink['kind'], ref: r.ref };
  if (r.author) link.author = r.author;
  if (r.repo) link.repo = r.repo;
  if (r.title !== null) link.title = r.title;
  if (r.state !== null) link.state = r.state;
  return link;
}

function toTask(r: TaskRow, links: TaskLink[]): Task {
  const complexity = TaskComplexity.safeParse(parseJson<unknown>(r.complexity, null));
  return {
    // Only what is not the default is present, so a plain card reads as it did before themes.
    ...(r.kind === 'theme' ? { kind: 'theme' as const } : {}),
    ...(r.effective_theme ? { themeKey: r.effective_theme } : {}),
    ...(complexity.success ? { complexity: complexity.data } : {}),
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
    priority: r.priority === null ? null : (PRIORITY_LEVEL[r.priority] ?? null),
    boardRank: r.board_rank,
    labels: parseJson<string[]>(r.labels, []),
    links,
    createdBy: r.created_by,
    createdAt: r.created_at,
    stageEnteredAt: r.stage_entered_at ?? r.created_at,
    updatedAt: r.updated_at,
    closedAt: r.closed_at,
  };
}

/** The origin a card's `task_created` events prove: anything but one well-formed event is `unknown`. */
function createdOrigin(events: string[]): CollectingSourceEvidence['origin'] {
  if (events.length !== 1) return 'unknown';
  const data = parseJson<unknown>(events[0], null);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'unknown';
  const { imported } = data as { imported?: unknown };
  if (imported === undefined || imported === false) return 'native';
  return imported === true ? 'imported' : 'unknown';
}

export function createTaskRepository(db: Db) {
  const statements = {
    get: db.prepare(`${TASK_SELECT} WHERE t.key = ?`),
    list: db.prepare(`${TASK_SELECT} WHERE t.project_key = ? ORDER BY t.seq`),
    listLinks: db.prepare(
      `SELECT l.* FROM task_links l JOIN tasks t ON t.id = l.task_id
       WHERE t.project_key = ? ORDER BY l.id`,
    ),
    byAssignee: db.prepare(`${TASK_SELECT} WHERE t.project_key = ? AND t.assignee = ? ORDER BY t.seq`),
    byAssigneeLinks: db.prepare(
      `SELECT l.* FROM task_links l JOIN tasks t ON t.id = l.task_id
       WHERE t.project_key = ? AND t.assignee = ? ORDER BY l.id`,
    ),
    children: db.prepare(`${TASK_SELECT} WHERE t.project_key = ? AND t.parent_key = ? ORDER BY t.seq`),
    childrenLinks: db.prepare(
      `SELECT l.* FROM task_links l JOIN tasks t ON t.id = l.task_id
       WHERE t.project_key = ? AND t.parent_key = ? ORDER BY l.id`,
    ),
    linksOf: db.prepare('SELECT * FROM task_links WHERE task_id = ? ORDER BY id'),
    // PM-770: the scheduling reads. The links are those of the selected cards only (the unique
    // `(task_id, ...)` index); the sets travel as one bound JSON array.
    linksOfIds: db.prepare(SCHEDULING_SQL.linksOfIds),
    schedulingKeys: db.prepare(SCHEDULING_SQL.keys),
    schedulingChildren: db.prepare(SCHEDULING_SQL.children),
    schedulingChildrenAll: db.prepare(SCHEDULING_SQL.childrenAll),
    schedulingPullUrgent: db.prepare(SCHEDULING_SQL.pullUrgent),
    schedulingQueue: db.prepare(SCHEDULING_SQL.queue),
    schedulingOpen: db.prepare(SCHEDULING_SQL.open),
    countNotCancelled: db.prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE project_key = ? AND status <> 'cancelled'",
    ),
    schedulingListedOpen: db.prepare(SCHEDULING_SQL.listedOpen),
    schedulingListedStatus: db.prepare(SCHEDULING_SQL.listedStatus),
    schedulingClosed: db.prepare(SCHEDULING_SQL.closed),
    // Uses the `task_links_ref` index: card relations are links with no repository.
    linking: db.prepare(
      `SELECT t.*, CASE WHEN t.parent_key IS NOT NULL THEN p.theme_key ELSE t.theme_key END AS effective_theme
       FROM task_links l JOIN tasks t ON t.id = l.task_id LEFT JOIN tasks p ON p.key = t.parent_key
       WHERE l.kind = ? AND l.repo = '' AND l.ref = ? AND t.project_key = ? ORDER BY t.seq`,
    ),
    deleteLink: db.prepare(`DELETE FROM task_links WHERE task_id = ? AND kind = ? AND repo = '' AND ref = ?`),
    insert: db.prepare(
      `INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, assignee,
         repo, priority, labels, visibility, created_by, created_at, stage_entered_at, updated_at, closed_at, parent_key,
         kind, theme_key, board_rank, complexity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    setBoardRank: db.prepare('UPDATE tasks SET board_rank = ? WHERE key = ? AND project_key = ?'),
    // The open cards of a project that stand in these stages (themes are no cards of the board).
    boardCards: db.prepare(
      `SELECT key, seq, board_rank, updated_at FROM tasks
       WHERE project_key = ? AND kind = 'task' AND status NOT IN ('done', 'cancelled')
         AND stage_id IN (SELECT value FROM json_each(?))`,
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
       WHERE t.project_key = ? AND l.kind = 'pull_request' AND l.repo = ? AND l.ref = ?`,
    ),
    updateLinkState: db.prepare('UPDATE task_links SET state = ?, title = ?, updated_at = ? WHERE id = ?'),
    pullRequestHeads: db.prepare(
      `SELECT l.id, l.head_sha, t.project_key AS projectKey, t.key AS taskKey FROM task_links l
       JOIN tasks t ON t.id = l.task_id
       WHERE t.project_key = ? AND l.kind = 'pull_request' AND l.repo = ? AND l.ref = ? ORDER BY t.seq`,
    ),
    updateLinkHead: db.prepare('UPDATE task_links SET head_sha = ?, updated_at = ? WHERE id = ?'),
    attributeAuthor: db.prepare(
      `UPDATE task_links SET author = ?, updated_at = ?
       WHERE kind = 'pull_request' AND repo = ? AND ref = ?
         AND (author IS NULL OR author <> ?)
         AND (author_source IS NULL OR author_source <> 'published')
         AND task_id IN (SELECT id FROM tasks WHERE project_key = ?)`,
    ),
    findByPullRequest: db.prepare(
      `SELECT DISTINCT t.project_key AS projectKey, t.key AS taskKey FROM task_links l
       JOIN tasks t ON t.id = l.task_id
       WHERE t.project_key = ? AND l.kind = 'pull_request' AND l.repo = ? AND l.ref = ? ORDER BY t.seq`,
    ),
    watchablePullRequests: db.prepare(
      `SELECT l.repo, l.ref, l.state, t.key AS task_key, t.project_key FROM task_links l
       JOIN tasks t ON t.id = l.task_id
       WHERE l.kind = 'pull_request' AND l.repo <> ''
         AND (l.state IS NULL OR l.state NOT IN ('merged', 'closed'))
         AND t.status NOT IN ('done', 'cancelled')`,
    ),
    // PM-797: the facts that say whether a card has (or had) a source of its own, from the card's own rows only.
    sourceFacts: db.prepare(
      `SELECT
         t.assignee IS NOT NULL AS assigned,
         (EXISTS (SELECT 1 FROM task_links l WHERE l.task_id = t.id AND l.kind IN ('branch', 'pull_request'))
          OR EXISTS (SELECT 1 FROM task_review_pins p WHERE p.project_key = t.project_key AND p.task_key = t.key)
          OR EXISTS (SELECT 1 FROM task_handovers h WHERE h.project_key = t.project_key AND h.task_key = t.key)
          OR EXISTS (SELECT 1 FROM task_workspace_bindings b WHERE b.project_key = t.project_key AND b.task_key = t.key)
          OR EXISTS (SELECT 1 FROM task_merges m WHERE m.project_key = t.project_key AND m.task_key = t.key)
          OR EXISTS (SELECT 1 FROM sessions s
                     WHERE s.project_key = t.project_key AND s.work_item_type = 'task' AND s.work_item_ref = t.key
                       AND (s.branch IS NOT NULL OR s.reviewed_commit IS NOT NULL))
          OR EXISTS (SELECT 1 FROM timeline_events e
                     WHERE e.project_key = t.project_key AND e.task_key = t.key
                       AND (e.type = 'task_merged'
                         OR (e.type = 'task_link_added' AND json_extract(e.data, '$.kind') IN ('branch', 'pull_request'))
                         OR (e.type = 'task_stage_changed'
                             AND (json_extract(e.data, '$.reviewPin') IS NOT NULL
                               OR json_extract(e.data, '$.branchMoved') IS NOT NULL))
                         OR (e.type = 'task_updated' AND json_extract(e.data, '$.reviewPin') IS NOT NULL)))
         ) AS source,
         EXISTS (SELECT 1 FROM timeline_events e
                 WHERE e.project_key = t.project_key AND e.task_key = t.key AND e.type = 'task_assigned'
                   AND (json_extract(e.data, '$.assignee') IS NOT NULL
                     OR json_extract(e.data, '$.previous') IS NOT NULL
                     OR json_extract(e.data, '$.from') IS NOT NULL)) AS worked
       FROM tasks t WHERE t.project_key = ? AND t.key = ?`,
    ),
    createdEvents: db.prepare(
      `SELECT data FROM timeline_events WHERE project_key = ? AND task_key = ? AND type = 'task_created'`,
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

  /** The stored cards of these rows, once each by key, by number, with the links of exactly these cards. */
  function hydrate(rows: Iterable<TaskRow>): Task[] {
    const unique = new Map<string, TaskRow>();
    for (const row of rows) unique.set(row.key, row);
    const sorted = [...unique.values()].sort((a, b) => a.seq - b.seq);
    return withLinks(
      sorted,
      () => statements.linksOfIds.all(JSON.stringify(sorted.map((r) => r.id))) as LinkRow[],
    );
  }

  const rowsOfKeys = (projectKey: string, keys: readonly string[]): TaskRow[] =>
    keys.length === 0
      ? []
      : (statements.schedulingKeys.all(projectKey, JSON.stringify([...new Set(keys)])) as TaskRow[]);

  function closedRows(
    projectKey: string,
    query: Extract<TaskSchedulingQuery, { kind: 'closed-worktrees' }>,
  ): TaskRow[] {
    const { closedBefore, afterSeq = 0, limit = 100 } = query;
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(closedBefore) ||
      !Number.isFinite(Date.parse(closedBefore))
    )
      throw new RangeError(`closedBefore must be a UTC ISO time: ${closedBefore}`);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      throw new RangeError(`afterSeq must be a non-negative integer: ${afterSeq}`);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new RangeError(`limit must be an integer from 1 to 500: ${limit}`);
    return statements.schedulingClosed.all(projectKey, afterSeq, closedBefore, limit) as TaskRow[];
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

  return {
    upsertLink,

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
          task.priority === null ? null : PRIORITY_COLUMN[task.priority],
          toJson(task.labels),
          'shared', // Legacy column, not read since PM-987.
          task.createdBy,
          task.createdAt,
          task.stageEnteredAt ?? task.createdAt,
          task.updatedAt,
          task.closedAt,
          task.parentKey ?? null,
          task.kind ?? 'task',
          // A subtask has none of its own: it reads its parent's.
          task.parentKey ? null : (task.themeKey ?? null),
          task.boardRank ?? 0,
          task.complexity ? toJson(task.complexity) : null,
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

    /**
     * The stored cards a scheduling query selects (`TaskSchedulingReader`), filtered in SQL, with only their
     * own links: no project-wide list, no board view. The selection rules are the query's own; the gates
     * and the ranking stay in the shared package, which decides on what this returns.
     */
    readScheduling(projectKey: string, query: TaskSchedulingQuery): Task[] {
      switch (query.kind) {
        case 'keys':
          return hydrate(rowsOfKeys(projectKey, query.keys));
        case 'queue':
          return hydrate(statements.schedulingQueue.all(projectKey, query.stageId) as TaskRow[]);
        case 'pull':
          return hydrate(statements.schedulingPullUrgent.all(projectKey, query.stageId) as TaskRow[]);
        case 'children': {
          if (query.parentKeys.length === 0) return [];
          const statement = query.includeClosed
            ? statements.schedulingChildrenAll
            : statements.schedulingChildren;
          return hydrate(
            statement.all(projectKey, JSON.stringify([...new Set(query.parentKeys)])) as TaskRow[],
          );
        }
        case 'open':
          return hydrate(statements.schedulingOpen.all(projectKey) as TaskRow[]);
        case 'listed': {
          const { status, stageId = null, assignee = null, limit } = query;
          const params = { projectKey, stageId, assignee, limit };
          // Newest change first, as the SQL ordered them; `hydrate` would sort by number.
          const rows =
            status === 'open'
              ? (statements.schedulingListedOpen.all(params) as TaskRow[])
              : (statements.schedulingListedStatus.all({ ...params, status }) as TaskRow[]);
          const byKey = new Map(hydrate(rows).map((task) => [task.key, task]));
          return rows.map((row) => byKey.get(row.key)!);
        }
        case 'closed-worktrees':
          return hydrate(closedRows(projectKey, query));
      }
    },

    /** How many cards of the project are not cancelled (themes included), without reading them. */
    countNotCancelled(projectKey: string): number {
      return (statements.countNotCancelled.get(projectKey) as { n: number }).n;
    },

    listByAssignee(projectKey: string, handle: string): Task[] {
      return withLinks(
        statements.byAssignee.all(projectKey, handle) as TaskRow[],
        () => statements.byAssigneeLinks.all(projectKey, handle) as LinkRow[],
      );
    },

    /**
     * The open cards standing in `stageIds` with what orders them (`board-order` in the shared package),
     * read without their links: the manual order of a board column (PM-118).
     */
    boardCards(projectKey: string, stageIds: readonly string[]): RankedCard[] {
      const rows = statements.boardCards.all(projectKey, JSON.stringify(stageIds)) as Array<{
        key: string;
        board_rank: number;
        updated_at: string;
      }>;
      return rows.map((row) => ({ key: row.key, rank: row.board_rank, updatedAt: row.updated_at }));
    },

    /** Writes ranks and nothing else: no card's update time moves with its place. */
    setBoardRanks(projectKey: string, ranks: ReadonlyArray<{ key: string; rank: number }>): void {
      for (const { key, rank } of ranks) statements.setBoardRank.run(rank, key, projectKey);
    },

    /**
     * What the hub's own records say about the source of a card (PM-797): null when the card is not in the
     * project. A database error is not turned into empty evidence. The origin is `native` only when exactly one
     * well-formed `task_created` event says the card was made here.
     */
    sourceEvidence(projectKey: string, taskKey: string): CollectingSourceEvidence | null {
      const facts = statements.sourceFacts.get(projectKey, taskKey) as
        { assigned: number; source: number; worked: number } | undefined;
      if (!facts) return null;
      const created = statements.createdEvents.all(projectKey, taskKey) as Array<{ data: string }>;
      return {
        sourceRecorded: facts.source === 1,
        workRecorded: facts.assigned === 1 || facts.worked === 1,
        origin: createdOrigin(created.map((row) => row.data)),
      };
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

    /** Writes only the fields in `patch`, so concurrent changes of other fields survive. */
    update(id: string, patch: TaskPatch): void {
      const fields = (Object.keys(COLUMNS) as Array<keyof TaskPatch>).filter((f) => patch[f] !== undefined);
      if (fields.length === 0) return;
      const signature = fields.join(',');
      let statement = updates.get(signature);
      if (!statement) {
        const sets = fields.map((f) => `${COLUMNS[f]} = @${f}`);
        statement = db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`);
        updates.set(signature, statement);
      }
      const values: Record<string, unknown> = { id };
      for (const field of fields) values[field] = patch[field];
      if (patch.priority !== undefined)
        values.priority = patch.priority === null ? null : PRIORITY_COLUMN[patch.priority];
      if (patch.labels) values.labels = toJson(patch.labels);
      if (patch.complexity !== undefined)
        values.complexity = patch.complexity === null ? null : toJson(patch.complexity);
      statement.run(values);
    },

    /** Updates the project's links to the same pull request; returns the keys of the tasks that changed. */
    updatePullRequestLinks(
      projectKey: string,
      repo: string,
      number: number,
      patch: { state: string; title?: string },
      at: string,
    ): string[] {
      const rows = statements.pullRequestLinks.all(projectKey, repo, String(number)) as Array<
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
     * Remembers the head commit of a pull request on the project's links to it. Returns the tasks whose
     * link had seen another head before: new commits landed there. A first sighting is not a change.
     */
    recordPullRequestHead(
      projectKey: string,
      repo: string,
      number: number,
      headSha: string,
      at: string,
    ): Array<{ projectKey: string; taskKey: string }> {
      const rows = statements.pullRequestHeads.all(projectKey, repo, String(number)) as Array<{
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

    /** The project's tasks (project key + task key) linking a pull request. */
    findByPullRequest(
      projectKey: string,
      repo: string,
      number: number,
    ): Array<{ projectKey: string; taskKey: string }> {
      return statements.findByPullRequest.all(projectKey, repo, String(number)) as Array<{
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
