import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import {
  BASELINE_RELEASE,
  BASELINE_VERSION,
  LATEST_SCHEMA_VERSION,
  migrate,
  migrations,
  schemaVersion,
} from '../src/db';
import { BASELINE_SQL } from '../src/db/schema/baseline-0152';
import { schemaDigest } from './helpers/schema-snapshot';

// Complete chain at d3468c591, compared with this baseline in commit 9dfb388fd.
const OLD_CHAIN_SCHEMA_SHA256 = '320ae6959f31377bab77b3fa8e2feabd4ed2f2d28a92298d6536c7791fb59219';

it('keeps the frozen baseline equal to the complete old migration chain', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(BASELINE_SQL);
    expect(schemaDigest(db)).toBe(OLD_CHAIN_SCHEMA_SHA256);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

it('initializes fresh databases at the latest version with independent generations', () => {
  const databases = [new Database(':memory:'), new Database(':memory:')];
  try {
    const generations = databases.map((db) => {
      db.pragma('foreign_keys = ON');
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      const row = db
        .prepare("SELECT value FROM instance_meta WHERE key = 'project_change_generation'")
        .get() as { value: string };
      expect(row.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      return row.value;
    });
    expect(generations[0]).not.toBe(generations[1]);
  } finally {
    databases.forEach((db) => db.close());
  }
});

it.each([1, BASELINE_VERSION - 1])(
  'refuses schema %i without writing and identifies the recovery release',
  (version) => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('keep');");
      db.pragma(`user_version = ${version}`);
      const before = db.serialize();
      let message = '';
      try {
        migrate(db);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(String(version));
      expect(message).toContain(String(BASELINE_VERSION));
      expect(message).toContain(BASELINE_RELEASE);
      expect(message).toContain('docs/DEPLOY.md');
      expect(db.serialize().equals(before)).toBe(true);
    } finally {
      db.close();
    }
  },
);

it('refuses an unversioned nonempty database without writing', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE foreign_data (value TEXT); INSERT INTO foreign_data VALUES ('keep');");
    const before = db.serialize();
    expect(() => migrate(db)).toThrow(/no schema version/);
    expect(db.serialize().equals(before)).toBe(true);
  } finally {
    db.close();
  }
});

it('upgrades an existing baseline database through the later migrations without replacing its generation', () => {
  const db = new Database(':memory:');
  try {
    db.exec(BASELINE_SQL);
    db.pragma(`user_version = ${BASELINE_VERSION}`);
    const before = db.prepare('SELECT * FROM instance_meta').all();
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare('SELECT * FROM instance_meta').all()).toEqual(before);
  } finally {
    db.close();
  }
});

it('leaves a database already at the latest version untouched', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    db.exec("INSERT INTO instance_meta VALUES ('preserved', 'keep');");
    const before = db.serialize();
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.serialize().equals(before)).toBe(true);
  } finally {
    db.close();
  }
});

it('numbers migrations consecutively after the baseline', () => {
  expect(migrations.map((m) => m.version)).toEqual(
    migrations.map((_, index) => BASELINE_VERSION + index + 1),
  );
});
