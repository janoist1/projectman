import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createRepositories, migrate } from '../src/db';
import { migrateRemaining, migrationsBefore } from './helpers/migrations';

it('preserves signal delivery and decisions and permits both start condition kinds', () => {
  const db = new Database(':memory:');
  try {
    migrate(db, migrationsBefore('start-condition-signals'));
    db.exec(`INSERT INTO operator_signals (id, project_key, kind, case_key, state, actionable,
      task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at,
      delivered_at, follow_up_at, decision_note, delivered_to)
      VALUES ('ops_old', 'AR', 'cards_closed', 'old', 'dismissed', 1, 'AR-1', 'subject',
        'inb_old', 'msg_old', '2026-11-14', 'owner', '2026-11-14', '2026-11-14',
        '2026-11-15', 'Checked', 'pm');`);
    const before = db.prepare('SELECT * FROM operator_signals').all();
    migrateRemaining(db);
    expect(db.prepare('SELECT * FROM operator_signals').all()).toEqual(before);
    const repo = createRepositories(db).projectManagerSignals;
    for (const kind of ['start_condition_met', 'start_condition_changed'] as const) {
      const signal = { ...repo.get('ops_old')!, id: kind, kind, caseKey: kind };
      repo.insert(signal);
      expect(repo.get(kind)?.kind).toBe(kind);
      expect(() => repo.insert({ ...signal, id: `duplicate_${kind}` })).toThrow(/UNIQUE/);
    }
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
