import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { latestSchemaVersion, migrate } from '../src/db';
import { migrationsBefore } from './helpers/migrations';

it('rewrites the retired release and Operator approval items to alerts and drops the retired signal rows (PM-1384)', () => {
  const db = new Database(':memory:');
  try {
    migrate(db, migrationsBefore('retired-inbox-and-signal-kinds'));
    const item = db.prepare(
      `INSERT INTO inbox_items (id, project_key, kind, assignees, source, title, payload, options, state, created_at, updated_at)
       VALUES (?, 'AR', ?, '[]', 'system', 'Old', ?, '[]', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    item.run('inb_release', 'release', '{"release":{"releaseId":"rel_1"}}', 'resolved');
    item.run('inb_release_open', 'release', '{"release":{"releaseId":"rel_2"}}', 'open');
    item.run('inb_operator', 'approval', '{"operator":{"requestId":"opr_1"}}', 'resolved');
    item.run('inb_email', 'approval', '{"email":{"emailId":"eml_1"}}', 'resolved');
    item.run('inb_question', 'question', '{}', 'open');
    item.run('inb_asked_by_operator', 'question', '{}', 'open');
    db.prepare("UPDATE inbox_items SET source = 'operator' WHERE id = 'inb_asked_by_operator'").run();
    item.run('inb_operator_session', 'decision', '{}', 'screening');
    item.run('inb_operator_session_done', 'decision', '{}', 'resolved');
    db.exec(`INSERT INTO sessions (id, project_key, member, work_item_type, work_item_ref, claude_session_id, cwd, state, started_at, last_activity_at)
      VALUES ('ses_operator', 'AR', 'operator', 'chat', 'x', 'c', '/', 'ended', '2026-01-01', '2026-01-01');
      UPDATE inbox_items SET session_id = 'ses_operator' WHERE id IN ('inb_operator_session', 'inb_operator_session_done');`);
    db.exec(`INSERT INTO projects (key, name, config_version, created_at, updated_at) VALUES ('AR', 'Example', 'v1', '2026-01-01', '2026-01-01');
      INSERT INTO operator_signals (id, project_key, kind, case_key, state, actionable, raised_at)
      VALUES ('ops_idle', 'AR', 'idle', 'idle:AR-1', 'resolved', 0, '2026-01-01T00:00:00.000Z'),
             ('ops_nobody', 'AR', 'nobody', 'nobody:AR-2', 'open', 0, '2026-01-01T00:00:00.000Z'),
             ('ops_kept', 'AR', 'merge_blocked', 'merge_blocked:AR-1', 'open', 0, '2026-01-01T00:00:00.000Z');`);

    expect(migrate(db)).toBe(latestSchemaVersion());

    const items = db.prepare('SELECT id, kind, payload, state FROM inbox_items ORDER BY id').all();
    expect(items).toEqual([
      { id: 'inb_asked_by_operator', kind: 'question', payload: '{}', state: 'cancelled' },
      { id: 'inb_email', kind: 'approval', payload: '{"email":{"emailId":"eml_1"}}', state: 'resolved' },
      { id: 'inb_operator', kind: 'alert', payload: '{}', state: 'resolved' },
      { id: 'inb_operator_session', kind: 'decision', payload: '{}', state: 'cancelled' },
      { id: 'inb_operator_session_done', kind: 'decision', payload: '{}', state: 'resolved' },
      { id: 'inb_question', kind: 'question', payload: '{}', state: 'open' },
      { id: 'inb_release', kind: 'alert', payload: '{}', state: 'resolved' },
      { id: 'inb_release_open', kind: 'alert', payload: '{}', state: 'cancelled' },
    ]);
    expect(db.prepare('SELECT id FROM operator_signals ORDER BY id').all()).toEqual([{ id: 'ops_kept' }]);
    expect(() =>
      db.exec(`INSERT INTO operator_signals (id, project_key, kind, case_key, state, actionable, raised_at)
        VALUES ('ops_new', 'AR', 'idle', 'idle:AR-9', 'open', 0, '2026-01-01T00:00:00.000Z')`),
    ).toThrow();
  } finally {
    db.close();
  }
});
