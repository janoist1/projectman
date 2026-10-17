import type { ProjectChangeKind } from '@projectman/shared';

type Row = 'NEW' | 'OLD';

/**
 * A table whose rows are durable state a project change names (PM-761). An SQLite trigger writes
 * the journal entry in the transaction of the very statement, so no write path (a facade, a sweep, a
 * recovery) can change the state without it, and a rollback takes the entry back. Only the entity
 * is named, never the content.
 *
 * Used by migration 80 only: its text is frozen there, so a table added later needs a migration of its
 * own that calls `changeTriggerSql`. A migration that rebuilds one of these tables drops its
 * triggers; `change-triggers.test.ts` fails until the rebuild creates them again.
 */
export interface ChangeTriggerTable {
  table: string;
  kind: ProjectChangeKind;
  /** Which statements announce. */
  on: ReadonlyArray<'INSERT' | 'UPDATE' | 'DELETE'>;
  /** The project key column (or expression) of the row. */
  project: (row: Row) => string;
  /** The entity the entry names. */
  entity: (row: Row) => string;
  /** Where `project` and `entity` are read when they are not columns of the row itself. */
  from?: (row: Row) => string;
}

const ownProject = (row: Row) => `${row}.project_key`;
const column = (name: string) => (row: Row) => `${row}.${name}`;
const ALL = ['INSERT', 'UPDATE', 'DELETE'] as const;

export const CHANGE_TRIGGER_TABLES: readonly ChangeTriggerTable[] = [
  { table: 'tasks', kind: 'task', on: ALL, project: ownProject, entity: column('key') },
  {
    // A link belongs to the card; once the card is gone (a cascade) there is no project to name.
    table: 'task_links',
    kind: 'task',
    on: ALL,
    project: () => 'project_key',
    entity: () => 'key',
    from: (row) => `tasks WHERE id = ${row}.task_id`,
  },
  { table: 'attachments', kind: 'task', on: ALL, project: ownProject, entity: column('task_key') },
  { table: 'project_focus_items', kind: 'task', on: ALL, project: ownProject, entity: column('task_key') },
  { table: 'timeline_events', kind: 'timeline', on: ['INSERT'], project: ownProject, entity: column('id') },
  {
    table: 'team_messages',
    kind: 'message',
    on: ['INSERT', 'UPDATE'],
    project: ownProject,
    entity: column('id'),
  },
  {
    table: 'inbox_items',
    kind: 'inbox',
    on: ['INSERT', 'UPDATE'],
    project: ownProject,
    entity: column('id'),
  },
  {
    table: 'projects',
    kind: 'configuration',
    on: ['INSERT', 'UPDATE'],
    project: column('key'),
    entity: column('key'),
  },
  {
    // The pause of the whole instance belongs to every project.
    table: 'pauses',
    kind: 'pause',
    on: ['INSERT', 'UPDATE'],
    project: () => 'key',
    entity: column('id'),
    from: (row) => `projects WHERE ${row}.project_key IS NULL OR key = ${row}.project_key`,
  },
  {
    table: 'session_pauses',
    kind: 'pause',
    on: ['INSERT', 'UPDATE'],
    project: ownProject,
    entity: column('pause_id'),
  },
  {
    table: 'task_handoffs',
    kind: 'handoff',
    on: ['INSERT', 'UPDATE'],
    project: ownProject,
    entity: column('id'),
  },
  {
    table: 'operator_requests',
    kind: 'operation',
    on: ['INSERT', 'UPDATE'],
    project: ownProject,
    entity: column('id'),
  },
  {
    table: 'super_operation_audit',
    kind: 'operation',
    on: ['INSERT'],
    project: ownProject,
    entity: column('id'),
  },
  {
    table: 'task_merges',
    kind: 'operation',
    on: ['INSERT', 'UPDATE'],
    project: ownProject,
    entity: column('id'),
  },
];

export function changeTriggerName(table: string, statement: string): string {
  return `${table}_change_${statement.toLowerCase()}`;
}

/** The triggers of one table. */
export function changeTriggerSql(entry: ChangeTriggerTable): string {
  return entry.on
    .map((statement) => {
      const row: Row = statement === 'DELETE' ? 'OLD' : 'NEW';
      return `CREATE TRIGGER ${changeTriggerName(entry.table, statement)} AFTER ${statement} ON ${entry.table}
      BEGIN
        INSERT INTO project_change_events (project_key, kind, entity_id, at)
        SELECT ${entry.project(row)}, '${entry.kind}', ${entry.entity(row)}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')${
          entry.from ? ` FROM ${entry.from(row)}` : ''
        };
      END;`;
    })
    .join('\n');
}

export function changeTriggersSql(): string {
  return CHANGE_TRIGGER_TABLES.map(changeTriggerSql).join('\n');
}
