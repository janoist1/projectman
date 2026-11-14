import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createRepositories, migrate } from '../src/db';
import { migrateRemaining, migrationsBefore, migrationsThrough } from './helpers/migrations';

it('preserves signals and their indexes while allowing cards_closed', () => {
  const db = new Database(':memory:');
  try {
    migrate(db, migrationsBefore('cards-closed-signal'));
    db.exec(`INSERT INTO projects (key, name, config_version, created_at, updated_at)
      VALUES ('AR', 'Example', 'v1', '2026-01-01', '2026-01-01');
      INSERT INTO operator_signals (id, project_key, kind, case_key, state, actionable, subject,
        raised_at, delivered_at, delivered_to, decision_note)
      VALUES ('ops_old', 'AR', 'outage', 'outage:1', 'open', 1, 'outage-1',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'pm', 'Checked');`);
    const before = db.prepare('SELECT * FROM operator_signals').all();
    migrate(db, migrationsThrough('cards-closed-signal'));
    expect(db.prepare('SELECT * FROM operator_signals').all()).toEqual(before);
    migrateRemaining(db);
    const repo = createRepositories(db).projectManagerSignals;
    repo.insert({ ...repo.get('ops_old')!, id: 'ops_closed', kind: 'cards_closed', caseKey: 'cards_closed' });
    expect(repo.get('ops_closed')?.kind).toBe('cards_closed');
    expect(() => repo.insert({ ...repo.get('ops_closed')!, id: 'ops_duplicate' })).toThrow(/UNIQUE/);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'operator_signals'")
        .all(),
    ).toEqual(
      expect.arrayContaining([{ name: 'operator_signals_open' }, { name: 'operator_signals_delivery' }]),
    );
  } finally {
    db.close();
  }
});
