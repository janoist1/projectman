import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { migrate, migrations } from '../src/db';

it('preserves every signal field, ordering and partial uniqueness while extending only the kind constraint', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const migration of migrations.filter((m) => m.version < 71)) db.exec(migration.sql);
    db.pragma('user_version = 70');
    const insert =
      db.prepare(`INSERT INTO operator_signals (id, project_key, kind, case_key, state, actionable,
      task_key, subject, inbox_item_id, message_id, raised_at, decided_by, decided_at, resolved_at,
      delivered_at, follow_up_at, decision_note, delivered_to)
      VALUES (?, 'AR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const at = '2026-10-16T09:00:00.000Z';
    insert.run(
      'ops_open',
      'answer_stalled',
      'same-case',
      'open',
      1,
      'AR-1',
      'subject',
      'inb_1',
      'msg_1',
      at,
      null,
      null,
      null,
      at,
      at,
      'note',
      'pm',
    );
    insert.run(
      'ops_closed',
      'process_cleanup_failed',
      'same-case',
      'resolved',
      0,
      null,
      null,
      null,
      null,
      at,
      'owner',
      at,
      at,
      null,
      null,
      null,
      null,
    );
    const before = db.prepare('SELECT * FROM operator_signals ORDER BY rowid').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM operator_signals ORDER BY rowid').all()).toEqual(before);
    migrate(db);
    expect(db.prepare('SELECT * FROM operator_signals ORDER BY rowid').all()).toEqual(before);
    const add = db.prepare(`INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at)
      VALUES (?, 'AR', ?, ?, 'pending', ?)`);
    add.run('ops_structural', 'structural_pattern', 'pattern-case', at);
    add.run('ops_milestone', 'milestone_closed', 'milestone-case', at);
    expect(() => add.run('ops_unknown', 'unknown', 'unknown-case', at)).toThrow('CHECK');
    expect(() => add.run('ops_duplicate', 'structural_pattern', 'same-case', at)).toThrow('UNIQUE');
    db.prepare('UPDATE operator_signals SET resolved_at = ? WHERE id = ?').run(at, 'ops_open');
    expect(() => add.run('ops_new_episode', 'structural_pattern', 'same-case', at)).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
