import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { migrate, schemaVersion, BASELINE_VERSION } from '../src/db';
import {
  loadMigrationFiles,
  migrationFiles,
  latestSchemaVersion,
  migrationMetaSchema,
} from '../src/db/migration-files';

const folders: string[] = [];

it('does not read migrations when a worker imports the module', async () => {
  vi.resetModules();
  const read = vi.fn(() => {
    throw new Error('migration directory unavailable in this bundle');
  });
  vi.doMock('node:fs', async (original) => ({
    ...(await original<typeof import('node:fs')>()),
    readdirSync: read,
  }));
  try {
    const module = await import('../src/db/migration-files');
    expect(read).not.toHaveBeenCalled();
    expect(() => module.migrationFiles()).toThrow(/unavailable/);
  } finally {
    vi.doUnmock('node:fs');
    vi.resetModules();
  }
});
const folder = () => {
  const path = mkdtempSync(join(tmpdir(), 'migration-files-'));
  folders.push(path);
  return path;
};
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('loads the real migrations consecutively after the baseline', () => {
  expect(migrationFiles().map((f) => f.version)).toEqual(
    migrationFiles().map((_, i) => BASELINE_VERSION + i + 1),
  );
  expect(latestSchemaVersion()).toBe(migrationFiles().at(-1)?.version ?? BASELINE_VERSION);
});

it.each([
  [['0153-first.sql', '0153-second.sql'], '0153-second.sql'],
  [['0153-first.sql', '0155-gap.sql'], '0155-gap.sql'],
  [['0154-first.sql'], '0154-first.sql'],
  [['0153_bad.sql'], '0153_bad.sql'],
  [['0153-first.meta.json'], '0153-first.meta.json'],
  [['0153-first.sql', '0153-first.meta.json'], '0153-first.meta.json'],
])('rejects invalid migration files %j before database writes', (names, culprit) => {
  const path = folder();
  for (const name of names)
    writeFileSync(join(path, name), name.endsWith('.json') ? '{"unknown": true}' : 'SELECT 1;');
  const db = new Database(':memory:');
  try {
    const before = db.serialize();
    expect(() => migrate(db, loadMigrationFiles(path, 152))).toThrow(culprit);
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});

it('names the build copy step when the migration folder is missing', () => {
  expect(() => loadMigrationFiles(join(folder(), 'missing'), 152)).toThrow(/build copies.*dist\/migrations/);
});

it('ignores dotfiles and the README and accepts matching metadata', () => {
  const path = folder();
  writeFileSync(join(path, '.DS_Store'), 'ignored');
  writeFileSync(join(path, 'README.md'), 'guide');
  writeFileSync(join(path, '0153-first.sql'), 'SELECT 1;');
  writeFileSync(join(path, '0153-first.meta.json'), '{"tables":{}}');
  expect(loadMigrationFiles(new URL(`file://${path}/`), 152)[0]).toMatchObject({
    version: 153,
    name: 'first',
    meta: { tables: {} },
  });
});

it('creates metadata journal triggers in the migration transaction', () => {
  const db = new Database(':memory:');
  try {
    const version = latestSchemaVersion() + 1;
    migrate(db, [
      ...migrationFiles(),
      {
        version,
        name: 'test-items',
        sql: 'CREATE TABLE test_items (project_key TEXT, id TEXT);',
        meta: migrationMetaSchema.parse({
          tables: { test_items: { journal: { kind: 'task', entity: 'id' } } },
        }),
      },
    ]);
    db.exec(
      "INSERT INTO projects (key, name, config_version, created_at, updated_at) VALUES ('AR', 'Example', 'v1', 'now', 'now'); INSERT INTO test_items VALUES ('AR', 'AR-1');",
    );
    expect(db.prepare("SELECT entity_id FROM project_change_events WHERE entity_id = 'AR-1'").all()).toEqual([
      { entity_id: 'AR-1' },
    ]);
    expect(schemaVersion(db)).toBe(version);
  } finally {
    db.close();
  }
});

it('rolls back SQL and version when metadata would recreate an existing trigger', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const before = db.serialize();
    expect(() =>
      migrate(db, [
        ...migrationFiles(),
        {
          version: latestSchemaVersion() + 1,
          name: 'bad-trigger',
          sql: 'CREATE TABLE rolled_back (id TEXT);',
          meta: { tables: { tasks: { journal: { kind: 'task', entity: 'key' } } } },
        },
      ]),
    ).toThrow(/already exists/);
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});
