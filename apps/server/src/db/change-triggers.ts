import type { ProjectChangeKind } from '@projectman/shared';

type Row = 'NEW' | 'OLD';
type Statement = 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * A table whose rows are durable state a project change names (PM-761). An SQLite trigger writes
 * the journal entry in the transaction of the very statement, so no write path (a facade, a sweep, a
 * recovery) can change the state without it, and a rollback takes the entry back. Only the entity
 * is named (project key, kind, entity id, time), never the content, and no rule: what a row means is
 * decided in the domain, not in SQL.
 *
 * Used by migration 81 only: its text is frozen there, so a table added later needs a migration of its
 * own that calls `changeTriggerSql`. A migration that rebuilds one of these tables drops its
 * triggers; `project-change-journal.test.ts` fails until the rebuild creates them again, and also when
 * a table is in neither this list nor `UNJOURNALED_TABLES`.
 */
interface ChangeTriggerTable {
  table: string;
  kind: ProjectChangeKind;
  /** Which statements announce. */
  on: ReadonlyArray<Statement>;
  /** The project key column (or expression) of the row. */
  project: (row: Row) => string;
  /** The entity the entry names (an expression; `'NULL'` for none). */
  entity: (row: Row) => string;
  /** Where `project` and `entity` are read when they are not columns of the row itself. */
  from?: (row: Row) => string;
  /** A condition under which the statement announces (an UPDATE that changes nothing a reader sees stays quiet). */
  when?: Partial<Record<Statement, string>>;
}

const ownProject = (row: Row) => `${row}.project_key`;
const column = (name: string) => (row: Row) => `${row}.${name}`;
const ALL = ['INSERT', 'UPDATE', 'DELETE'] as const;
const WRITES = ['INSERT', 'UPDATE'] as const;

const ofProject = (
  table: string,
  kind: ProjectChangeKind,
  entity: string,
  on: ReadonlyArray<Statement> = ALL,
): ChangeTriggerTable => ({
  table,
  kind,
  on,
  project: ownProject,
  entity: column(entity),
});

/**
 * The coverage matrix of the card's read model. Kind `task`: the card and every durable table its
 * view or the board reads; the entity is the card key. A card deleted by a cascade is announced by the
 * card row itself.
 */
const V81_CHANGE_TRIGGER_TABLES: readonly ChangeTriggerTable[] = [
  ofProject('tasks', 'task', 'key'),
  {
    // A link belongs to the card; once the card is gone (a cascade) there is no project to name.
    table: 'task_links',
    kind: 'task',
    on: ALL,
    project: () => 'project_key',
    entity: () => 'key',
    from: (row) => `tasks WHERE id = ${row}.task_id`,
  },
  ofProject('attachments', 'task', 'task_key'),
  ofProject('task_covers', 'task', 'task_key'),
  ofProject('task_fix_limits', 'task', 'task_key'),
  ofProject('task_hand_ons', 'task', 'task_key'),
  ofProject('task_handovers', 'task', 'task_key'),
  ofProject('task_review_pins', 'task', 'task_key'),
  ofProject('task_loops', 'task', 'task_key'),
  ofProject('senior_waits', 'task', 'task_key'),
  ofProject('deferred_starts', 'task', 'task_key'),
  ofProject('full_test_runs', 'task', 'task_key'),
  ofProject('timeline_events', 'timeline', 'id', ['INSERT']),
  ofProject('team_messages', 'message', 'id', WRITES),
  ofProject('message_attachments', 'message', 'message_id', WRITES),
  ofProject('inbox_items', 'inbox', 'id', WRITES),
  ofProject('question_groups', 'inbox', 'primary_item_id'),
  {
    // The configuration is git's; the project record carries its version. Only a new version (or a new
    // project) is a change, so a recovery that finds the record already at the version stays quiet.
    table: 'projects',
    kind: 'configuration',
    on: WRITES,
    project: column('key'),
    entity: () => 'NULL',
    when: { UPDATE: 'OLD.config_version IS NOT NEW.config_version' },
  },
  {
    // The pause of the whole instance belongs to every project.
    table: 'pauses',
    kind: 'pause',
    on: WRITES,
    project: () => 'key',
    entity: column('id'),
    from: (row) => `projects WHERE ${row}.project_key IS NULL OR key = ${row}.project_key`,
  },
  ofProject('session_pauses', 'pause', 'pause_id', WRITES),
  ofProject('task_handoffs', 'handoff', 'id', WRITES),
  ofProject('operator_requests', 'operation', 'id', WRITES),
  {
    // A step belongs to its request, which names the project.
    table: 'operator_steps',
    kind: 'operation',
    on: WRITES,
    project: () => 'project_key',
    entity: column('request_id'),
    from: (row) => `operator_requests WHERE id = ${row}.request_id`,
  },
  ofProject('super_operation_audit', 'operation', 'id', ['INSERT']),
  ofProject('task_merges', 'operation', 'id', WRITES),
  ofProject('merge_trains', 'operation', 'id', WRITES),
  ofProject('releases', 'operation', 'id', WRITES),
  ofProject('doc_writes', 'operation', 'id', WRITES),
];

/**
 * Tables added after migration 81, each group with a migration of its own that calls `changeTriggerSql`
 * on its group (a migration's text is frozen, so it names its own group, never the whole later list).
 */
/** Migration 83 (PM-762): the durable hand-over to the integrator and the operation it starts. */
export const V83_CHANGE_TRIGGER_TABLES: readonly ChangeTriggerTable[] = [
  ofProject('super_handoffs', 'handoff', 'id', WRITES),
  ofProject('super_operations', 'operation', 'id', WRITES),
];

/** Migration 92 (PM-876): the merge checks with their measurements. */
export const V92_CHANGE_TRIGGER_TABLES: readonly ChangeTriggerTable[] = [
  ofProject('merge_check_runs', 'operation', 'id', WRITES),
];

/** Migration 130 (PM-1135): the acceptance items of a card; an item belongs to the card, like a link. */
export const V130_CHANGE_TRIGGER_TABLES: readonly ChangeTriggerTable[] = [
  {
    table: 'task_acceptance_items',
    kind: 'task',
    on: ALL,
    project: () => 'project_key',
    entity: () => 'key',
    from: (row) => `tasks WHERE id = ${row}.task_id`,
  },
];

/** Migration 100 (PM-885) rebuilds these two tables of migration 81, which drops their triggers: it creates them again. */
export const V100_REBUILT_TRIGGER_TABLES: readonly ChangeTriggerTable[] = V81_CHANGE_TRIGGER_TABLES.filter(
  (entry) => entry.table === 'operator_requests' || entry.table === 'operator_steps',
);

/** Migration 136 (PM-1159) rebuilds these two tables of migration 81, which drops their triggers: it creates them again. */
export const V136_REBUILT_TRIGGER_TABLES: readonly ChangeTriggerTable[] = V81_CHANGE_TRIGGER_TABLES.filter(
  (entry) => entry.table === 'pauses' || entry.table === 'session_pauses',
);

export const CHANGE_TRIGGER_TABLES: readonly ChangeTriggerTable[] = [
  // Migration 131 (PM-1150) drops `senior_waits` with its triggers: the wait is an obligation row now.
  ...V81_CHANGE_TRIGGER_TABLES.filter((entry) => entry.table !== 'senior_waits'),
  ...V83_CHANGE_TRIGGER_TABLES,
  ...V92_CHANGE_TRIGGER_TABLES,
  ...V130_CHANGE_TRIGGER_TABLES,
];

/**
 * Tables with no trigger, and why. Every table is in this list or in `CHANGE_TRIGGER_TABLES`
 * (`project-change-journal.test.ts`), so a new table makes someone decide.
 */
export const UNJOURNALED_TABLES: Readonly<Record<string, string>> = {
  project_checklists: 'Private owner/admin checklist; announced through project_checklist_changed.',
  project_checklist_items: 'Private owner/admin checklist; announced through project_checklist_changed.',
  web_push_devices: 'personal notification settings, not project state',
  web_push_settings: 'personal notification settings, not project state',
  web_push_items: 'personal notification settings, not project state',
  ntfy_channels: 'personal notification settings, not project state',
  auth_sessions: 'login sessions, not project state',
  counters: 'number allocator; the card row announces itself',
  decision_candidate_state: 'Operator bookkeeping that no project reader reads',
  decision_offers: 'Operator bookkeeping that no project reader reads',
  email_login_codes: 'credentials, not project state',
  email_login_events: 'credentials audit, not project state',
  email_contacts: 'owner/admin email read model with its own email_changed event (PM-940)',
  email_contact_events: 'owner/admin email audit with its own email_changed event (PM-940)',
  email_messages: 'owner/admin email log with its own email_changed event (PM-940)',
  engines: 'written with the project fan-out by the engine registry, in its own transaction',
  project_engines:
    'written by the engine registry in one transaction with the project’s own engine journal row (PM-1060)',
  owner_accounts: 'instance-level accounts of the host owner’s administration (PM-1062), not project state',
  owner_invitations:
    'instance-level invitations of the host owner’s administration (PM-1062), not project state',
  host_requests:
    'requests of a project manager to the host (PM-1064); the host reads them from their own list and the project sees their timeline events',
  feedback_events: 'the feedback tool has its own read model',
  feedback_launch_codes: 'the feedback tool has its own read model',
  feedback_marker_colors: 'the feedback tool has its own read model',
  feedback_marks: 'the feedback tool has its own read model',
  feedback_reads: 'the feedback tool has its own read model',
  feedback_sessions: 'the feedback tool has its own read model',
  system_feedback_items:
    'the system feedback page has its own live event (PM-479), not a project reader view',
  system_feedback_occurrences:
    'the system feedback page has its own live event (PM-479), not a project reader view',
  system_feedback_forwarding: 'an instance setting with its own live event (PM-479), not project state',
  history_doc_state: 'derived history index state (PM-786), not project state',
  history_dirty: 'derived history index queue (PM-786), not project state',
  history_documents: 'derived history index (PM-786), not project state',
  history_fts: 'derived history index (PM-786), not project state',
  history_fts_config: 'shadow table of history_fts',
  history_fts_data: 'shadow table of history_fts',
  history_fts_docsize: 'shadow table of history_fts',
  history_fts_idx: 'shadow table of history_fts',
  history_index_state: 'derived history index state (PM-786), not project state',
  history_searches: 'private search log (PM-787), not project state',
  history_semantic_chunks: 'derived vector index of the history (PM-767), not project state',
  history_semantic_dirty: 'derived vector index queue (PM-767), not project state',
  history_semantic_sources: 'derived vector index state (PM-767), not project state',
  history_semantic_state: 'derived vector index backfill checkpoint (PM-767), not project state',
  instance_meta: 'the journal generation itself',
  integrator_key_audit: 'key audit, not project state',
  integrator_keys: 'credentials, not project state',
  invitations: 'member administration; the configuration version changes when one is accepted',
  member_queue_items:
    'member queue (PM-894); its sources (messages, inbox items) are journaled and it announces itself',
  member_state: 'activity pattern; no durability is promised',
  member_workspaces: 'machine-local workspace bookkeeping of the runner',
  merge_check_run_tasks: 'written in the same transaction as its merge_check_runs row, which is journaled',
  merge_queue_revisions: 'CAS counter; task_merges announces queue changes in the same transaction',
  obligations: 'obligation bookkeeping; its wake and hand-over are timeline events',
  operator_grants: 'the owner’s grant for machine operations (PM-881), not project state',
  operator_execution_intents: 'recovery intent; its outcome is the configuration and operation rows',
  operator_signals: 'announced by the inbox item it raises',
  operator_signal_arms: 'detector bookkeeping; the signals it gates are not journaled either',
  project_change_events: 'the journal itself',
  question_group_items: 'written with its group, which is journaled',
  release_deployment_requests: 'deploy controller bookkeeping; the release row is journaled',
  release_deployments: 'deploy controller bookkeeping; the release row is journaled',
  compute_job_runs:
    'run bookkeeping of a compute job; its end is a note on the card and the run is read by id',
  release_publications:
    'publish_release bookkeeping of a tag and a GitHub release; the repository and GitHub hold them',
  schedule_runs: 'scheduler bookkeeping',
  session_cleanups: 'machine-local cleanup bookkeeping of the runner',
  sessions: 'terminal and activity pattern; no durability is promised',
  sqlite_sequence: 'SQLite internal',
  task_workspace_bindings: 'machine-local workspace bookkeeping of the runner',
  token_usage: 'usage statistics, not a reader view',
  users: 'accounts, not project state',
};

export function changeTriggerName(table: string, statement: string): string {
  return `${table}_change_${statement.toLowerCase()}`;
}

/** The triggers of one table. */
export function changeTriggerSql(entry: ChangeTriggerTable): string {
  return entry.on
    .map((statement) => {
      const row: Row = statement === 'DELETE' ? 'OLD' : 'NEW';
      const when = entry.when?.[statement];
      return `CREATE TRIGGER ${changeTriggerName(entry.table, statement)} AFTER ${statement} ON ${entry.table}${
        when ? `\n      WHEN ${when}` : ''
      }
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT ${entry.project(row)}, '${entry.kind}', ${entry.entity(row)}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')${
          entry.from ? ` FROM ${entry.from(row)}` : ''
        };
      END;`;
    })
    .join('\n');
}

/** The triggers migration 81 creates: its text is frozen, later tables get their own migration. */
export function changeTriggersSql(): string {
  return V81_CHANGE_TRIGGER_TABLES.map(changeTriggerSql).join('\n');
}
