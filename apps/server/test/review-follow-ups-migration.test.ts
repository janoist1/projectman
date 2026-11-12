import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

it('carries the operator signals over unchanged and takes the review_follow_ups kind (PM-1362)', () => {
  const db = new Database(':memory:');
  try {
    for (const migration of migrations.filter((m) => m.version < 152)) db.exec(migration.sql);
    db.pragma('user_version = 151');
    db.exec(`INSERT INTO projects (key, name, config_version, created_at, updated_at) VALUES ('AR', 'Example', 'v1', '2026-01-01', '2026-01-01');
      INSERT INTO operator_signals (id, project_key, kind, case_key, state, actionable, task_key, subject, raised_at, delivered_at, delivered_to, decision_note)
      VALUES ('ops_old', 'AR', 'relation_check', 'relation_check:AR-1:prerequisite:AR-2', 'dismissed', 0, 'AR-1', 'prerequisite:AR-2', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'pm', 'Checked.');`);
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    const repo = createRepositories(db).operatorSignals;
    expect(repo.get('ops_old')).toMatchObject({
      kind: 'relation_check',
      caseKey: 'relation_check:AR-1:prerequisite:AR-2',
      state: 'dismissed',
      taskKey: 'AR-1',
      subject: 'prerequisite:AR-2',
      deliveredAt: '2026-01-01T00:01:00.000Z',
      deliveredTo: 'pm',
      decisionNote: 'Checked.',
    });
    repo.insert({
      ...repo.get('ops_old')!,
      id: 'ops_new',
      kind: 'review_follow_ups',
      caseKey: 'review_follow_ups:AR-1:evt_1',
      subject: 'evt_1',
      state: 'pending',
      resolvedAt: null,
    });
    expect(repo.listOfTask('AR', 'AR-1', 'review_follow_ups').map((signal) => signal.id)).toEqual([
      'ops_new',
    ]);
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
