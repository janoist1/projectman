import { createHash } from 'node:crypto';
import type { Db } from '../../src/db/database';

/** Stable schema evidence, independent of creation order and SQLite's internal tables. */
export function schemaSnapshot(db: Db) {
  const shadows = new Set(
    (db.pragma('table_list') as { name: string; type: string }[])
      .filter((table) => table.type === 'shadow')
      .map((table) => table.name),
  );
  return (
    db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name",
      )
      .all() as { type: string; name: string; tbl_name: string; sql: string }[]
  ).filter((row) => !shadows.has(row.name));
}

export function schemaDigest(db: Db): string {
  return createHash('sha256')
    .update(JSON.stringify(schemaSnapshot(db)))
    .digest('hex');
}
