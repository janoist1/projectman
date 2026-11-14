import type { Db } from '../../src/db';
import { migrate } from '../../src/db';
import { migrationFiles, type MigrationFile } from '../../src/db/migration-files';

// Migration numbers change at merge time (PM-1496), so tests pick a step by its name (`NNNN-name` without the number).
function indexOfStep(name: string): number {
  const index = migrationFiles().findIndex((file) => file.name === name);
  if (index < 0) throw new Error(`No migration is named ${name}.`);
  return index;
}

/** The migrations that run before the named step. */
export function migrationsBefore(name: string): MigrationFile[] {
  return migrationFiles().slice(0, indexOfStep(name));
}

/** The migrations up to and including the named step. */
export function migrationsThrough(name: string): MigrationFile[] {
  return migrationFiles().slice(0, indexOfStep(name) + 1);
}

/**
 * Applies the migrations that follow the step a test examined. The repositories prepare statements against
 * the whole schema, so a later migration (a new column) must not break the test.
 */
export function migrateRemaining(db: Db): number {
  return migrate(db, migrationFiles());
}
