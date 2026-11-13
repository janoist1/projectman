import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { latestSchemaVersion, migrate } from '../src/db';
import { migrationFiles } from '../src/db/migration-files';

it('rewrites the retired release and Operator approval items to alerts and drops the retired signal rows (PM-1384)', () => {
  const db = new Database(':memory:');
  try {
    migrate(
      db,
      migrationFiles().filter((m) => m.version < 157),
    );
    const item = db.prepare(
      `INSERT INTO inbox_items (id, project_key, kind, assignees, source, title, payload, options, state, created_at, updated_at)
       VALUES (?, 'AR', ?, '[]', 'system', 'Old', ?, '[]', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    item.run('inb_release', 'release', '{"release":{"releaseId":"rel_1"}}', 'resolved');
    item.run('inb_release_open', 'release', '{"release":{"releaseId":"rel_2"}}', 'open');
    item.run('inb_operator', 'approval', '{"operator":{"requestId":"opr_1"}}', 'resolved');
    item.run('inb_email', 'approval', '{"email":{"emailId":"eml_1"}}', 'resolved');
    item.run('inb_question', 'question', '{}', 'open');
    db.exec(`INSERT INTO projects (key, name, config_version, created_at, updated_at) VALUES ('AR', 'Example', 'v1', '2026-01-01', '2026-01-01');
      INSERT INTO operator_signals (id, project_key, kind, case_key, state, actionable, raised_at)
      VALUES ('ops_idle', 'AR', 'idle', 'idle:AR-1', 'resolved', 0, '2026-01-01T00:00:00.000Z'),
             ('ops_nobody', 'AR', 'nobody', 'nobody:AR-2', 'open', 0, '2026-01-01T00:00:00.000Z'),
             ('ops_kept', 'AR', 'merge_blocked', 'merge_blocked:AR-1', 'open', 0, '2026-01-01T00:00:00.000Z');`);

    expect(migrate(db)).toBe(latestSchemaVersion());

    const items = db.prepare('SELECT id, kind, payload, state FROM inbox_items ORDER BY id').all();
    expect(items).toEqual([
      { id: 'inb_email', kind: 'approval', payload: '{"email":{"emailId":"eml_1"}}', state: 'resolved' },
      { id: 'inb_operator', kind: 'alert', payload: '{}', state: 'resolved' },
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
