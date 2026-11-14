# Database migrations

The frozen baseline is `../schema/baseline-0152.ts`. Append migrations as
`NNNN-name.sql`: four digits, then lowercase words or numbers separated by hyphens.
Start at the next free version after the baseline and existing files. Numbers must be
unique and consecutive. Every card that adds a migration rewrites the one line of `LATEST`
with the newest migration's `NNNN-name`; two parallel cards then conflict on that line, and the
merge regenerates it (`npm run merge:regenerate`, which renumbers the new migrations after the
newest one in main and rewrites `LATEST`). The number can therefore change at merge: in tests
and docs refer to a migration by its name (`apps/server/test/helpers/migrations.ts`:
`migrationsBefore('name')`, `migrationsThrough('name')`), never by number. To renumber by hand
after merging main into your branch, run `npm run migrations:renumber -- --base main`: it refuses
when a migration of main is missing or changed, and never renumbers one that is in main.
Begin the SQL with `-- PM-xxxx: reason for the change`.

Never edit the baseline or a released SQL or metadata file. Append another migration.
There are no TypeScript migration steps. The loader ignores dotfiles, this README and `LATEST`;
all other files must be SQL or matching metadata. `db-migration-files.test.ts` guards this.

A migration creating, rebuilding or dropping a table, or adding/removing a handle column,
also supplies `NNNN-name.meta.json`. All objects are strict (unknown keys fail):

```json
{
  "tables": {
    "example_items": {
      "journal": { "kind": "task", "entity": "task_key" },
      "handles": {
        "rewritten": ["created_by"],
        "json": { "watchers": "handles" },
        "unrewritten": { "cwd": "a storage path under the member storage handle" }
      }
    },
    "example_log": { "journal": { "none": "private bookkeeping with no project reader" } },
    "removed_items": { "dropped": true }
  }
}
```

`journal` replaces the table's classification. `kind` is a `ProjectChangeKind`;
`on` defaults to INSERT, UPDATE, DELETE. Without `from`, `project` (default
`project_key`) and `entity` are column names; `entity: null` writes NULL.
With `from`, `project` is required and both it and `entity` are SQL expressions;
`{row}` expands to NEW or OLD. Example: `{"kind":"task","project":"project_key",
"entity":"key","from":"tasks WHERE id = {row}.task_id"}`. `when` maps statement
names to SQL conditions. Only declare journal triggers when creating/rebuilding the
table or explicitly dropping its old triggers: existing trigger names are an error.
`journal.none` requires a reason of at least 11 characters.

`handles` adds classifications: `rewritten` columns, `json` columns of kind `handles`
or `receipts`, `unrewritten` columns with reasons, and optional `scope` (SQL selecting
project rows with `@project` when there is no `project_key`). `removed` deletes column
classifications before additions. `dropped: true` clears all table classifications and
cannot coexist with other keys. Baseline lists are frozen; new entries go here only.
`project-change-journal.test.ts` and `member-handles-columns.test.ts` guard coverage.

The loader validates the entire folder before database writes and reads it lazily.
Each SQL file, its journal triggers and user_version run in one transaction. Build
copies this folder to `dist/migrations` beside the server bundles; all deployment
packages carry it without an engine-specific path.

SQL and JSON have no import edge. Run `npm run handover-check` to select their tests.
A data transformation test should call `migrate(db, migrationsBefore('your-step'))` (or
`migrationsThrough`) for the fixture and `migrateRemaining(db)` before using a repository, so
future migrations do not change its fixture.
