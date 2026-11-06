import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

/** PM-1225: the obligations table accepts the `next_step` kind; its rows and indexes carry over. */
describe('next step obligation migration', () => {
  it('keeps the rows with the word to the project manager and takes a next step row', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version <= 138)) db.exec(migration.sql);
      db.pragma('user_version = 138');
      db.exec(`INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at)
        VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO obligations (id, project_key, task_key, kind, responsible, subject, opened_at, due_at, state, updated_at, pm_told_at)
        VALUES ('obl_old', 'AR', 'AR-1', 'work', 'dev-1', 'development@2026-10-18T10:00:00.000Z',
          '2026-10-18T10:00:00.000Z', '2026-10-18T10:40:00.000Z', 'open', '2026-10-18T10:30:00.000Z', '2026-10-18T10:30:00.000Z');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.obligations.liveOfKind('AR', 'AR-1', 'work')).toMatchObject({
        id: 'obl_old',
        responsible: 'dev-1',
        pmToldAt: '2026-10-18T10:30:00.000Z',
      });
      const row = {
        id: 'obl_next',
        projectKey: 'AR',
        taskKey: 'AR-2',
        kind: 'next_step' as const,
        responsible: null,
        subject: 'backlog@2026-10-18T11:00:00.000Z',
        openedAt: '2026-10-18T11:00:00.000Z',
        dueAt: '2026-10-18T11:20:00.000Z',
      };
      expect(repos.obligations.insert(row)).toBe(true);
      // The unique index survived: the same step does not open twice.
      expect(repos.obligations.insert({ ...row, id: 'obl_again' })).toBe(false);
    } finally {
      db.close();
    }
  });
});
