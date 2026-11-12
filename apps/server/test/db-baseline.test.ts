import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { migrations } from '../src/db/migrations';
import { BASELINE_SQL, BASELINE_VERSION } from '../src/db/schema/baseline-0152';
import { schemaDigest, schemaSnapshot } from './helpers/schema-snapshot';

// Evidence from the complete 1–152 chain at d3468c591 (PM-1381).
const OLD_CHAIN_SCHEMA_SHA256 = '320ae6959f31377bab77b3fa8e2feabd4ed2f2d28a92298d6536c7791fb59219';

it('matches the complete old migration chain in schema and seed data', () => {
  const old = new Database(':memory:');
  const fresh = new Database(':memory:');
  try {
    old.pragma('foreign_keys = ON');
    fresh.pragma('foreign_keys = ON');
    for (const migration of migrations) old.exec(migration.sql);
    expect(Math.max(...migrations.map((m) => m.version))).toBe(BASELINE_VERSION);
    fresh.exec(BASELINE_SQL);
    expect(schemaSnapshot(fresh)).toEqual(schemaSnapshot(old));
    expect(schemaDigest(fresh)).toBe(OLD_CHAIN_SCHEMA_SHA256);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const contents = (db: Database.Database) =>
      schemaSnapshot(db)
        .filter((row) => row.type === 'table')
        .map((row) => {
          const data = db.prepare(`SELECT * FROM "${row.name}"`).all();
          if (row.name === 'instance_meta') {
            expect(data).toEqual([{ key: 'project_change_generation', value: expect.stringMatching(uuid) }]);
            return { name: row.name, data: [{ key: 'project_change_generation', value: '<generation>' }] };
          }
          return { name: row.name, data };
        });
    expect(contents(fresh)).toEqual(contents(old));
    for (const db of [old, fresh]) {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
    }
  } finally {
    old.close();
    fresh.close();
  }
});
