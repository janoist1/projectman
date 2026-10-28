import type { AgentProvider, InboxItem, InboxKind, InboxState } from '@projectman/shared';
import type { Statement } from 'better-sqlite3';
import type { Db } from './database';
import { parseJson, toJson } from './json';

interface InboxRow {
  seq: number;
  id: string;
  project_key: string;
  kind: string;
  assignees: string;
  source: string;
  session_id: string | null;
  task_key: string | null;
  title: string;
  body: string | null;
  payload: string;
  options: string;
  state: string;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

interface InboxFilter {
  /** One state, or any of several (a question is pending while `open` or `screening`). */
  state?: InboxState | readonly InboxState[];
  kind?: InboxKind;
  taskKey?: string;
  /** The newest N matching items (still returned oldest first). Without it nothing is cut off. */
  limit?: number;
}

const toItem = (r: InboxRow): InboxItem => ({
  id: r.id,
  projectKey: r.project_key,
  kind: r.kind as InboxKind,
  assignees: parseJson<string[]>(r.assignees, []),
  source: r.source,
  sessionId: r.session_id,
  taskKey: r.task_key,
  title: r.title,
  body: r.body,
  payload: parseJson<Record<string, unknown>>(r.payload, {}),
  options: parseJson<InboxItem['options']>(r.options, []),
  state: r.state as InboxState,
  resolution: parseJson<InboxItem['resolution']>(r.resolution, null),
  createdAt: r.created_at,
});

export function createInboxRepository(db: Db) {
  const statements = {
    get: db.prepare('SELECT * FROM inbox_items WHERE id = ?'),
    insert: db.prepare(
      `INSERT INTO inbox_items (id, project_key, kind, assignees, source, session_id, task_key, title, body, payload,
         options, state, resolution, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateAssignees: db.prepare(
      "UPDATE inbox_items SET assignees = ?, updated_at = ? WHERE id = ? AND state IN ('open', 'screening')",
    ),
    close: db.prepare(
      `UPDATE inbox_items SET state = ?, resolution = ?, updated_at = ? WHERE id = ? AND state IN ('open', 'screening')`,
    ),
    release: db.prepare(
      `UPDATE inbox_items SET state = 'open', payload = ?, options = ?, updated_at = ? WHERE id = ? AND state = 'screening'`,
    ),
    listOpen: db.prepare(`SELECT * FROM inbox_items WHERE state = 'open' ORDER BY seq`),
    listOpenOfKind: db.prepare(`SELECT * FROM inbox_items WHERE state = 'open' AND kind = ? ORDER BY seq`),
    latestProviderQuota: db.prepare(`SELECT * FROM inbox_items
      WHERE kind = 'alert' AND json_extract(payload, '$.alert') = 'provider_rate_limited'
        AND json_extract(payload, '$.provider') = ? ORDER BY seq DESC LIMIT 1`),
    gateRequest: db.prepare(
      `SELECT * FROM inbox_items WHERE project_key = ? AND kind = 'decision' AND task_key = ?
         AND json_extract(payload, '$.gate.requestId') = ? ORDER BY seq`,
    ),
    openGateRequests: db.prepare(
      `SELECT * FROM inbox_items WHERE project_key = ? AND kind = 'decision' AND state = 'open' AND task_key = ?
         AND json_extract(payload, '$.gate.fromStageId') = ? AND json_extract(payload, '$.gate.toStageId') = ?
       ORDER BY seq`,
    ),
    questionsWithAttachment: db.prepare(
      `SELECT * FROM inbox_items WHERE project_key = ? AND kind = 'question'
         AND EXISTS (SELECT 1 FROM json_each(payload, '$.attachments') WHERE json_extract(value, '$.id') = ?)
       ORDER BY seq`,
    ),
    updatePayload: db.prepare('UPDATE inbox_items SET payload = ?, updated_at = ? WHERE id = ?'),
    countOpenFor: db.prepare(
      `SELECT COUNT(*) AS n FROM inbox_items
       WHERE project_key = ? AND state = 'open' AND EXISTS (SELECT 1 FROM json_each(assignees) WHERE value = ?)`,
    ),
  };
  /** List statements per combination of filters. */
  const lists = new Map<string, Statement>();

  const get = (id: string): InboxItem | null => {
    const row = statements.get.get(id) as InboxRow | undefined;
    return row ? toItem(row) : null;
  };

  const listeners: Array<(item: InboxItem) => void> = [];
  /** Runs `write` and the change listeners in one transaction, so what a listener derives commits with the item. */
  const changing = <T>(id: string, write: () => T): T =>
    db.transaction(() => {
      const result = write();
      const item = listeners.length > 0 ? get(id) : null;
      if (item) for (const listener of listeners) listener(item);
      return result;
    })();

  return {
    /**
     * `listener` runs inside the transaction of every write that changes an item, with the item as it is
     * then (the member queue keeps its rows of the item true, PM-894). It must be idempotent.
     */
    onChange(listener: (item: InboxItem) => void): void {
      listeners.push(listener);
    },
    groupOf(id: string): {
      primaryItemId: string;
      projectKey: string;
      question: string;
      by: string;
      note: string;
      itemIds: string[];
    } | null {
      const row = db
        .prepare(
          `SELECT g.* FROM question_groups g JOIN question_group_items i
        ON i.primary_item_id = g.primary_item_id WHERE i.item_id = ?`,
        )
        .get(id) as
        | { primary_item_id: string; project_key: string; question: string; by_handle: string; note: string }
        | undefined;
      if (!row) return null;
      const members = db
        .prepare('SELECT item_id FROM question_group_items WHERE primary_item_id = ? ORDER BY rowid')
        .all(row.primary_item_id) as { item_id: string }[];
      return {
        primaryItemId: row.primary_item_id,
        projectKey: row.project_key,
        question: row.question,
        by: row.by_handle,
        note: row.note,
        itemIds: members.map((m) => m.item_id),
      };
    },
    createGroup(input: {
      primaryItemId: string;
      projectKey: string;
      question: string;
      by: string;
      note: string;
      itemIds: string[];
      at: string;
    }): void {
      db.prepare(
        'INSERT INTO question_groups (primary_item_id, project_key, question, created_at, by_handle, note) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(input.primaryItemId, input.projectKey, input.question, input.at, input.by, input.note);
      const insert = db.prepare('INSERT INTO question_group_items (item_id, primary_item_id) VALUES (?, ?)');
      for (const id of input.itemIds) insert.run(id, input.primaryItemId);
    },
    /** Durable human answer messages, independent of current source-card existence or visibility. */
    groupAnsweredCount(primaryItemId: string): number {
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT i.id) AS n
        FROM question_groups g
        JOIN question_group_items gi ON gi.primary_item_id = g.primary_item_id
        JOIN inbox_items i ON i.id = gi.item_id
        JOIN inbox_items p ON p.id = g.primary_item_id
        JOIN team_messages m ON m.project_key = g.project_key
          AND json_extract(m.origin, '$.kind') = 'answer'
          AND json_extract(m.origin, '$.inboxItemId') = i.id
        WHERE g.primary_item_id = ? AND p.state = 'resolved'
          AND json_extract(p.resolution, '$.rule') IS NULL
          AND m.from_handle = json_extract(p.resolution, '$.by')
          AND COALESCE(m.via, '') = COALESCE(json_extract(p.resolution, '$.via'), '')
          AND EXISTS (SELECT 1 FROM json_each(m.to_handles) WHERE value = i.source)`,
        )
        .get(primaryItemId) as { n: number };
      return row.n;
    },
    updateOperator(
      id: string,
      payload: Record<string, unknown>,
      options: InboxItem['options'],
      at: string,
    ): InboxItem | null {
      changing(id, () =>
        db
          .prepare(
            "UPDATE inbox_items SET payload = ?, options = ?, updated_at = ? WHERE id = ? AND state = 'open'",
          )
          .run(toJson(payload), toJson(options), at, id),
      );
      return get(id);
    },
    /**
     * The payload and the assignees of an item still open (a delegated permission question, PM-169); the body
     * only when given (a fix limit decision that changes hands, PM-801).
     */
    updateOpen(
      id: string,
      payload: Record<string, unknown>,
      assignees: string[],
      at: string,
      body?: string,
    ): InboxItem | null {
      const changes = changing(id, () =>
        body === undefined
          ? db
              .prepare(
                "UPDATE inbox_items SET payload = ?, assignees = ?, updated_at = ? WHERE id = ? AND state = 'open'",
              )
              .run(toJson(payload), toJson(assignees), at, id).changes
          : db
              .prepare(
                "UPDATE inbox_items SET payload = ?, assignees = ?, body = ?, updated_at = ? WHERE id = ? AND state = 'open'",
              )
              .run(toJson(payload), toJson(assignees), body, at, id).changes,
      );
      return changes > 0 ? get(id) : null;
    },
    get,
    insert(item: InboxItem): void {
      changing(item.id, () =>
        statements.insert.run(
          item.id,
          item.projectKey,
          item.kind,
          toJson(item.assignees),
          item.source,
          item.sessionId,
          item.taskKey,
          item.title,
          item.body,
          toJson(item.payload),
          toJson(item.options),
          item.state,
          item.resolution ? toJson(item.resolution) : null,
          item.createdAt,
          item.createdAt,
        ),
      );
    },
    updateAssignees(id: string, assignees: string[], at: string): InboxItem | null {
      changing(id, () => statements.updateAssignees.run(toJson(assignees), at, id));
      return get(id);
    },
    /**
     * Changes state/resolution only while the item is still open or in screening; returns the item or null
     * if it was neither.
     */
    close(
      id: string,
      state: Exclude<InboxState, 'open' | 'screening'>,
      resolution: InboxItem['resolution'],
      at: string,
    ): InboxItem | null {
      const changes = changing(
        id,
        () => statements.close.run(state, resolution ? toJson(resolution) : null, at, id).changes,
      );
      return changes > 0 ? get(id) : null;
    },
    /**
     * Opens an item the Operator screened for the people (PM-556), with its new payload and options. False
     * when the item is not in screening (it was closed meanwhile).
     */
    release(
      id: string,
      change: { payload: Record<string, unknown>; options: InboxItem['options']; at: string },
    ): boolean {
      return (
        changing(
          id,
          () => statements.release.run(toJson(change.payload), toJson(change.options), change.at, id).changes,
        ) > 0
      );
    },
    /** Includes resolved alerts: acknowledging a quota alert does not end its hold. */
    latestProviderQuota(provider: AgentProvider): InboxItem | null {
      const row = statements.latestProviderQuota.get(provider) as InboxRow | undefined;
      return row ? toItem(row) : null;
    },
    /** Items of a project, oldest first. */
    list(projectKey: string, filter: InboxFilter = {}): InboxItem[] {
      const states = filter.state
        ? typeof filter.state === 'string'
          ? [filter.state]
          : [...filter.state]
        : [];
      const limited = filter.limit !== undefined;
      const signature = [
        states.length > 0 && `state${states.length}`,
        filter.kind && 'kind',
        filter.taskKey && 'task',
        limited && 'limit',
      ].join(',');
      let statement = lists.get(signature);
      if (!statement) {
        let sql = 'SELECT * FROM inbox_items WHERE project_key = @projectKey';
        if (states.length > 0) sql += ` AND state IN (${states.map((_, i) => `@state${i}`).join(', ')})`;
        if (filter.kind) sql += ' AND kind = @kind';
        if (filter.taskKey) sql += ' AND task_key = @taskKey';
        statement = db.prepare(`${sql} ORDER BY seq ${limited ? 'DESC LIMIT @limit' : 'ASC'}`);
        lists.set(signature, statement);
      }
      const params: Record<string, string | number> = { projectKey };
      if (limited) params.limit = filter.limit as number;
      states.forEach((state, i) => {
        params[`state${i}`] = state;
      });
      if (filter.kind) params.kind = filter.kind;
      if (filter.taskKey) params.taskKey = filter.taskKey;
      const rows = statement.all(params) as InboxRow[];
      return (limited ? rows.reverse() : rows).map(toItem);
    },
    /**
     * Questions answered after `after` and by no rule (PM-496), the earliest answer first. Unless
     * `includeOffered`, the ones the owner already gave a verdict on (`decision_offers`) are left out.
     */
    listAnsweredQuestions(projectKey: string, after: string, includeOffered = false): InboxItem[] {
      const rows = db
        .prepare(
          `SELECT * FROM inbox_items i WHERE i.project_key = ? AND i.kind = 'question' AND i.state = 'resolved'
             AND json_extract(i.resolution, '$.at') > ? AND json_extract(i.resolution, '$.rule') IS NULL
             AND (? OR NOT EXISTS (SELECT 1 FROM decision_offers o WHERE o.project_key = i.project_key AND o.item_id = i.id))
           ORDER BY json_extract(i.resolution, '$.at'), i.seq`,
        )
        .all(projectKey, after, includeOffered ? 1 : 0) as InboxRow[];
      return rows.map(toItem);
    },
    /** Open items across all projects, optionally of one kind. */
    listOpen(kind?: InboxKind): InboxItem[] {
      const rows = (kind ? statements.listOpenOfKind.all(kind) : statements.listOpen.all()) as InboxRow[];
      return rows.map(toItem);
    },
    /** The decision items of one gate request of a task (`payload.gate.requestId`), oldest first. */
    listGateRequest(projectKey: string, taskKey: string, requestId: string): InboxItem[] {
      return (statements.gateRequest.all(projectKey, taskKey, requestId) as InboxRow[]).map(toItem);
    },
    /** Open decision items requesting to move a task from one stage to another, oldest first. */
    listOpenGateRequests(
      projectKey: string,
      taskKey: string,
      fromStageId: string,
      toStageId: string,
    ): InboxItem[] {
      return (statements.openGateRequests.all(projectKey, taskKey, fromStageId, toStageId) as InboxRow[]).map(
        toItem,
      );
    },
    /** The questions, whatever their state, that name this file (PM-498), oldest first. */
    listQuestionsWithAttachment(projectKey: string, attachmentId: string): InboxItem[] {
      return (statements.questionsWithAttachment.all(projectKey, attachmentId) as InboxRow[]).map(toItem);
    },
    /** Replaces the payload of an item in any state (PM-498: a file of a question was deleted). */
    updatePayload(id: string, payload: Record<string, unknown>, at: string): InboxItem | null {
      const changes = changing(id, () => statements.updatePayload.run(toJson(payload), at, id).changes);
      return changes > 0 ? get(id) : null;
    },
    countOpenFor(projectKey: string, handle: string): number {
      return (statements.countOpenFor.get(projectKey, handle) as { n: number }).n;
    },
  };
}
