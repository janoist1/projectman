import { BASELINE_VERSION } from './schema/baseline-0152';

/**
 * Versioned migrations after the frozen baseline. Each runs once in a transaction.
 * Never edit the baseline or a released migration: append a new migration instead.
 */
interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [];

migrations.push({
  version: 153,
  name: 'full test run command',
  // PM-1377: the command a full test run ran, so a merge reuses a pass only of the same command. Older rows stay
  // NULL and are never reused.
  sql: `ALTER TABLE full_test_runs ADD COLUMN command TEXT;`,
});
migrations.push({
  version: 154,
  name: 'task stage owner pick',
  // PM-1395: whom a step stage with a small-card rule gave the card to on entry (JSON `StageOwnerPick`); NULL:
  // the stage has no such rule. No old row needs a backfill: every card read before keeps the stage's owners.
  sql: `ALTER TABLE tasks ADD COLUMN stage_owner_pick TEXT;`,
});
export const LATEST_SCHEMA_VERSION = Math.max(BASELINE_VERSION, ...migrations.map((m) => m.version));
