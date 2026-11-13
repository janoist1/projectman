import { migrationFiles } from './migration-files';
import type { MigrationFile } from './migration-files';
import type { Db } from './database';
import { parseJson, toJson } from './json';

/**
 * The columns that hold a member's handle and follow it when an AI member is renamed (PM-1025).
 * Frozen baseline registrations. New columns belong in migration metadata, never these lists.
 * `member-handles-columns.test.ts` guards the resulting handleColumns() registry.
 */
interface HandleTable {
  table: string;
  columns: readonly string[];
  /** The rows of one project (`@project`); the default is the table's own `project_key` column. */
  scope?: string;
}

const PROJECT_TASKS = 'SELECT id FROM tasks WHERE project_key = @project';

const BASELINE_REWRITTEN_HANDLE_COLUMNS: readonly HandleTable[] = [
  { table: 'tasks', columns: ['assignee', 'created_by'] },
  { table: 'task_links', columns: ['author'], scope: `task_id IN (${PROJECT_TASKS})` },
  {
    table: 'task_acceptance_items',
    columns: ['marked_by', 'confirmed_by', 'created_by'],
    scope: `task_id IN (${PROJECT_TASKS})`,
  },
  { table: 'sessions', columns: ['member'] },
  { table: 'member_state', columns: ['handle'] },
  { table: 'schedule_runs', columns: ['member'] },
  { table: 'invitations', columns: ['member_handle'] },
  { table: 'attachments', columns: ['uploaded_by_handle', 'deleted_by_handle'] },
  { table: 'message_attachments', columns: ['uploaded_by_handle', 'deleted_by_handle'] },
  { table: 'task_workspace_bindings', columns: ['member'] },
  { table: 'token_usage', columns: ['member'] },
  { table: 'task_review_pins', columns: ['pinned_by'] },
  { table: 'task_covers', columns: ['set_by_handle'] },
  { table: 'task_loops', columns: ['notified', 'let_run_by'] },
  { table: 'task_fix_limits', columns: ['decider'] },
  { table: 'task_handoffs', columns: ['from_member', 'to_member'] },
  { table: 'task_hand_ons', columns: ['mover', 'requested_by'] },
  { table: 'operator_requests', columns: ['from_handle'] },
  {
    table: 'operator_steps',
    columns: ['member'],
    scope: 'request_id IN (SELECT id FROM operator_requests WHERE project_key = @project)',
  },
  { table: 'operator_signals', columns: ['decided_by', 'delivered_to'] },
  { table: 'task_merges', columns: ['merger', 'started_by'] },
  { table: 'releases', columns: ['proposed_by', 'decided_by'] },
  { table: 'release_publications', columns: ['published_by'] },
  { table: 'doc_writes', columns: ['author', 'requested_by'] },
  { table: 'compute_job_runs', columns: ['requested_by'] },
  { table: 'feedback_marks', columns: ['author', 'handed_to'] },
  {
    table: 'feedback_events',
    columns: ['actor'],
    scope: 'mark_id IN (SELECT id FROM feedback_marks WHERE project_key = @project)',
  },
  { table: 'feedback_deletions', columns: ['author', 'deleted_by'] },
  { table: 'feedback_launch_codes', columns: ['member'] },
  { table: 'feedback_sessions', columns: ['member', 'revoked_by'] },
  { table: 'feedback_marker_colors', columns: ['member'] },
  { table: 'feedback_reads', columns: ['member'] },
  { table: 'question_groups', columns: ['by_handle'] },
  { table: 'super_handoffs', columns: ['requested_by'] },
  { table: 'history_documents', columns: ['author'] },
  { table: 'history_searches', columns: ['member'] },
  { table: 'obligations', columns: ['responsible', 'decided_by'] },
  { table: 'member_queue_items', columns: ['member', 'from_handle'] },
  { table: 'email_contacts', columns: ['handle', 'changed_by', 'requested_by'] },
  { table: 'email_contact_events', columns: ['handle', 'by', 'requested_by'] },
  { table: 'email_messages', columns: ['member', 'contact', 'decided_by'] },
  { table: 'project_checklist_items', columns: ['updated_by'] },
  { table: 'inbox_items', columns: ['source'] },
  { table: 'pauses', columns: ['requested_by', 'resumed_by'] },
  { table: 'team_messages', columns: ['from_handle'] },
  { table: 'message_turns', columns: ['handle'] },
  { table: 'host_requests', columns: ['opened_by'] },
];

/** Handle lists kept as a JSON array of strings, or (`receipts`) of receipts naming a handle and where it was handed on. */
const BASELINE_REWRITTEN_HANDLE_JSON: readonly {
  table: string;
  column: string;
  kind: 'handles' | 'receipts';
  scope?: string;
}[] = [
  { table: 'team_messages', column: 'to_handles', kind: 'handles' },
  { table: 'team_messages', column: 'receipts', kind: 'receipts' },
  { table: 'inbox_items', column: 'assignees', kind: 'handles' },
  { table: 'task_loops', column: 'members', kind: 'handles' },
  { table: 'task_loops', column: 'deciders', kind: 'handles' },
  { table: 'task_fix_limits', column: 'deciders', kind: 'handles' },
];

/** Handle-like columns a rename leaves alone, with the reason: history, storage keys, or no handle at all. */
const BASELINE_UNREWRITTEN_HANDLE_COLUMNS: Readonly<Record<string, string>> = {
  'timeline_events.actor_handle':
    'the timeline is append-only; the old handle resolves through formerHandles',
  'member_workspaces.member': 'a storage key: the workspace stays under the member storage handle',
  'sessions.cwd': 'a storage path under the member storage handle',
  'sessions.transcript_path': 'a storage path under the member storage handle',
  'operator_signals.case_key': 'identifies a recorded case, historical',
  'invitations.invited_by': 'the human who invited; an AI member does not invite',
  'system_feedback_items.forwarded_by': 'an owner decides; an AI member does not',
  'system_feedback_items.dismissed_by': 'an owner decides; an AI member does not',
  'system_feedback_forwarding.changed_by': 'an owner decides; an AI member does not',
  'engines.created_by': 'a user id, not a handle',
  'engines.revoked_by': 'a user id, not a handle',
  'project_engines.added_by': 'a user id, not a handle',
  'integrator_keys.user_id': 'a user id, not a handle',
  'projects.created_by': 'a user id, not a handle',
  'owner_accounts.granted_by': 'a user id, not a handle',
  'owner_accounts.revoked_by': 'a user id, not a handle',
  'owner_invitations.created_by': 'a user id, not a handle',
  'host_requests.answered_by': 'a user id, not a handle',
  'deferred_starts.spec': 'a start naming the member makes the rename refuse (member_session_live)',
};

/** Frozen baseline classifications; append new classifications in migration metadata. */
export function handleColumns(files: readonly MigrationFile[] = migrationFiles()) {
  let rewritten = BASELINE_REWRITTEN_HANDLE_COLUMNS.map((e) => ({ ...e, columns: [...e.columns] }));
  let json = BASELINE_REWRITTEN_HANDLE_JSON.map((e) => ({ ...e }));
  const unrewritten = { ...BASELINE_UNREWRITTEN_HANDLE_COLUMNS };
  for (const file of [...files].sort((a, b) => a.version - b.version))
    for (const [table, meta] of Object.entries(file.meta?.tables ?? {})) {
      const dropped = 'dropped' in meta;
      const handles = dropped ? undefined : meta.handles;
      const removed = new Set(handles?.removed ?? []);
      rewritten = rewritten
        .map((e) => (e.table === table ? { ...e, columns: e.columns.filter((c) => !removed.has(c)) } : e))
        .filter((e) => !(dropped && e.table === table));
      json = json.filter((e) => e.table !== table || (!dropped && !removed.has(e.column)));
      for (const key of Object.keys(unrewritten))
        if (key.startsWith(table + '.') && (dropped || removed.has(key.slice(table.length + 1))))
          delete unrewritten[key];
      if (!handles) continue;
      let entry = rewritten.find((e) => e.table === table);
      if (!entry) {
        entry = { table, columns: [] };
        rewritten.push(entry);
      }
      if (handles.scope !== undefined) entry.scope = handles.scope;
      if (handles.scope !== undefined)
        json = json.map((value) => (value.table === table ? { ...value, scope: handles.scope } : value));
      entry.columns = [...new Set([...entry.columns, ...(handles.rewritten ?? [])])];
      for (const [column, kind] of Object.entries(handles.json ?? {})) {
        json = json.filter((e) => e.table !== table || e.column !== column);
        json.push({ table, column, kind, ...(entry.scope !== undefined ? { scope: entry.scope } : {}) });
      }
      for (const [column, reason] of Object.entries(handles.unrewritten ?? {}))
        unrewritten[table + '.' + column] = reason;
    }
  return { rewritten: rewritten.filter((e) => e.columns.length), json, unrewritten };
}

const scopeOf = (entry: HandleTable): string => entry.scope ?? 'project_key = @project';

const jsonRowsWhere = (entry: (typeof BASELINE_REWRITTEN_HANDLE_JSON)[number]): string =>
  entry.kind === 'handles'
    ? `EXISTS (SELECT 1 FROM json_each(${entry.column}) WHERE value = @from)`
    : `EXISTS (SELECT 1 FROM json_each(${entry.column}) WHERE json_extract(value, '$.handle') = @from OR json_extract(value, '$.handedOffTo') = @from)`;

interface Receipt {
  handle?: string;
  handedOffTo?: string;
}

/**
 * Rewrites a member's handle to its new one in the working state (PM-1025). Idempotent: a row that
 * no longer holds the old handle is left alone, so a crash between the configuration commit and this
 * step is repaired by running it again. Runs in the caller's unit of work.
 */
export function createMemberHandleRepository(db: Db) {
  const { rewritten, json } = handleColumns();
  const updates = rewritten.flatMap((entry) =>
    entry.columns.map((column) =>
      db.prepare(`UPDATE ${entry.table} SET ${column} = @to WHERE ${column} = @from AND ${scopeOf(entry)}`),
    ),
  );
  const arrays = json.map((entry) => ({
    entry,
    select: db.prepare(
      `SELECT rowid AS id, ${entry.column} AS value FROM ${entry.table} WHERE ${entry.scope ?? 'project_key = @project'} AND ${jsonRowsWhere(entry)}`,
    ),
    update: db.prepare(`UPDATE ${entry.table} SET ${entry.column} = @value WHERE rowid = @id`),
  }));
  return {
    rename(projectKey: string, from: string, to: string): void {
      const params = { project: projectKey, from, to };
      for (const statement of updates) statement.run(params);
      for (const { entry, select, update } of arrays) {
        for (const row of select.all(params) as { id: number; value: string }[]) {
          const swap = (handle: string | undefined) => (handle === from ? to : handle);
          const value =
            entry.kind === 'handles'
              ? parseJson<string[]>(row.value, []).map((handle) => swap(handle))
              : parseJson<Receipt[]>(row.value, []).map((receipt) => ({
                  ...receipt,
                  ...(receipt.handle !== undefined ? { handle: swap(receipt.handle) } : {}),
                  ...(receipt.handedOffTo !== undefined ? { handedOffTo: swap(receipt.handedOffTo) } : {}),
                }));
          update.run({ id: row.id, value: toJson(value) });
        }
      }
    },
  };
}
