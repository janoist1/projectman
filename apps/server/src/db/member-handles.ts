import type { Db } from './database';
import { parseJson, toJson } from './json';

/**
 * The columns that hold a member's handle and follow it when an AI member is renamed (PM-1025).
 * The one registration: `rename` is built from it, and `member-handles.test.ts` fails for a
 * handle-like column that is in neither this list nor `UNREWRITTEN_HANDLE_COLUMNS`.
 */
interface HandleTable {
  table: string;
  columns: readonly string[];
  /** The rows of one project (`@project`); the default is the table's own `project_key` column. */
  scope?: string;
}

const PROJECT_TASKS = 'SELECT id FROM tasks WHERE project_key = @project';

export const REWRITTEN_HANDLE_COLUMNS: readonly HandleTable[] = [
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
  { table: 'senior_waits', columns: ['decided_by'] },
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
  { table: 'feedback_marks', columns: ['author', 'handed_to'] },
  {
    table: 'feedback_events',
    columns: ['actor'],
    scope: 'mark_id IN (SELECT id FROM feedback_marks WHERE project_key = @project)',
  },
  { table: 'feedback_launch_codes', columns: ['member'] },
  { table: 'feedback_sessions', columns: ['member', 'revoked_by'] },
  { table: 'feedback_marker_colors', columns: ['member'] },
  { table: 'feedback_reads', columns: ['member'] },
  { table: 'question_groups', columns: ['by_handle'] },
  { table: 'super_handoffs', columns: ['requested_by'] },
  { table: 'history_documents', columns: ['author'] },
  { table: 'history_searches', columns: ['member'] },
  { table: 'obligations', columns: ['responsible'] },
  { table: 'member_queue_items', columns: ['member', 'from_handle'] },
  { table: 'email_contacts', columns: ['handle', 'changed_by', 'requested_by'] },
  { table: 'email_contact_events', columns: ['handle', 'by', 'requested_by'] },
  { table: 'email_messages', columns: ['member', 'contact', 'decided_by'] },
  { table: 'project_checklist_items', columns: ['updated_by'] },
  { table: 'inbox_items', columns: ['source'] },
  { table: 'pauses', columns: ['requested_by', 'resumed_by'] },
  { table: 'team_messages', columns: ['from_handle'] },
  { table: 'host_requests', columns: ['opened_by'] },
];

/** Handle lists kept as a JSON array of strings, or (`receipts`) of receipts naming a handle and where it was handed on. */
export const REWRITTEN_HANDLE_JSON: readonly {
  table: string;
  column: string;
  kind: 'handles' | 'receipts';
}[] = [
  { table: 'team_messages', column: 'to_handles', kind: 'handles' },
  { table: 'team_messages', column: 'receipts', kind: 'receipts' },
  { table: 'inbox_items', column: 'assignees', kind: 'handles' },
  { table: 'task_loops', column: 'members', kind: 'handles' },
  { table: 'task_loops', column: 'deciders', kind: 'handles' },
  { table: 'task_fix_limits', column: 'deciders', kind: 'handles' },
];

/** Handle-like columns a rename leaves alone, with the reason: history, storage keys, or no handle at all. */
export const UNREWRITTEN_HANDLE_COLUMNS: Readonly<Record<string, string>> = {
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

const scopeOf = (entry: HandleTable): string => entry.scope ?? 'project_key = @project';

const jsonRowsWhere = (entry: (typeof REWRITTEN_HANDLE_JSON)[number]): string =>
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
  const updates = REWRITTEN_HANDLE_COLUMNS.flatMap((entry) =>
    entry.columns.map((column) =>
      db.prepare(`UPDATE ${entry.table} SET ${column} = @to WHERE ${column} = @from AND ${scopeOf(entry)}`),
    ),
  );
  const arrays = REWRITTEN_HANDLE_JSON.map((entry) => ({
    entry,
    select: db.prepare(
      `SELECT rowid AS id, ${entry.column} AS value FROM ${entry.table} WHERE project_key = @project AND ${jsonRowsWhere(entry)}`,
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
