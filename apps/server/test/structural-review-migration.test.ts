import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, migrate, migrations } from '../src/db';

it('closes only open structural history once, retaining rows and an upgrade reason', () => {
  const db = new Database(':memory:');
  try {
    for (const migration of migrations.filter((m) => m.version < 86)) db.exec(migration.sql);
    db.pragma('user_version = 85');
    const insert =
      db.prepare(`INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at)
      VALUES (?, 'AR', ?, ?, ?, '2026-10-16T19:40:42.000Z')`);
    for (const kind of ['structural_pattern', 'milestone_closed', 'outage', 'stalled']) {
      for (const state of ['pending', 'open', 'dismissed', 'resolved']) {
        const id = `${kind}:${state}`;
        insert.run(id, kind, id, state);
      }
    }
    const before = db.prepare('SELECT * FROM operator_signals ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    migrate(db);
    const after = db.prepare('SELECT * FROM operator_signals ORDER BY id').all() as Record<string, unknown>[];
    expect(after).toHaveLength(before.length);
    for (const [index, row] of before.entries()) {
      const closed =
        ['structural_pattern', 'milestone_closed'].includes(String(row.kind)) &&
        ['pending', 'open'].includes(String(row.state));
      expect(after[index]).toEqual(
        closed
          ? {
              ...row,
              state: 'resolved',
              resolved_at: expect.any(String),
              decision_note: 'PM-780: retroactive report-only signal closed at upgrade',
            }
          : row,
      );
    }
    migrate(db);
    expect(db.prepare('SELECT * FROM operator_signals ORDER BY id').all()).toEqual(after);
    expect(db.prepare('SELECT * FROM operator_signal_arms').all()).toEqual([]);
  } finally {
    db.close();
  }
});

it('preserves every signal field, ordering and partial uniqueness while extending only the kind constraint', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const migration of migrations.filter((m) => m.version < 74)) db.exec(migration.sql);
    db.pragma('user_version = 73');
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
      'refinement_stalled',
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
    db.prepare(
      `INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at)
      VALUES ('ops_loop', 'AR', 'loop_suspected', 'loop-case', 'open', ?)`,
    ).run(at);
    const before = db.prepare('SELECT * FROM operator_signals ORDER BY rowid').all();
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare('SELECT * FROM operator_signals ORDER BY rowid').all()).toEqual(before);
    migrate(db);
    expect(db.prepare('SELECT * FROM operator_signals ORDER BY rowid').all()).toEqual(before);
    const add = db.prepare(`INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at)
      VALUES (?, 'AR', ?, ?, 'pending', ?)`);
    add.run('ops_structural', 'structural_pattern', 'pattern-case', at);
    add.run('ops_milestone', 'milestone_closed', 'milestone-case', at);
    add.run('ops_refinement', 'refinement_stalled', 'refinement-case', at);
    expect(() => add.run('ops_unknown', 'unknown', 'unknown-case', at)).toThrow('CHECK');
    expect(() => add.run('ops_duplicate', 'structural_pattern', 'same-case', at)).toThrow('UNIQUE');
    db.prepare('UPDATE operator_signals SET resolved_at = ? WHERE id = ?').run(at, 'ops_open');
    expect(() => add.run('ops_new_episode', 'structural_pattern', 'same-case', at)).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

it('keeps every signal row while the start_blocked kind is admitted, one open row per case (PM-455)', () => {
  const db = new Database(':memory:');
  try {
    for (const migration of migrations.filter((m) => m.version < 120)) db.exec(migration.sql);
    db.pragma('user_version = 119');
    const at = '2026-10-28T09:00:00.000Z';
    db.prepare(
      `INSERT INTO operator_signals (id, project_key, kind, case_key, state, actionable, task_key, subject,
      raised_at, delivered_at, follow_up_at, decision_note, delivered_to)
      VALUES ('ops_old', 'AR', 'nobody', 'nobody:AR-1:ready', 'open', 1, 'AR-1', 'ready', ?, ?, ?, 'note', 'pm')`,
    ).run(at, at, at);
    const before = db.prepare('SELECT * FROM operator_signals ORDER BY rowid').all();
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare('SELECT * FROM operator_signals ORDER BY rowid').all()).toEqual(before);
    const add = db.prepare(`INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at)
      VALUES (?, 'AR', 'start_blocked', 'start_blocked:AR-2:repo_required', 'pending', ?)`);
    add.run('ops_start_blocked', at);
    expect(() => add.run('ops_start_blocked_twice', at)).toThrow('UNIQUE');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
