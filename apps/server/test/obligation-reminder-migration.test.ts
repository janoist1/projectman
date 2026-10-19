import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

/** PM-813: the reminders that wait undelivered get the obligation they remind of. */
describe('obligation reminder subject migration', () => {
  it('names the obligation of a waiting reminder, and leaves the others alone', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version <= 88)) db.exec(migration.sql);
      db.pragma('user_version = 88');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO obligations (id, project_key, task_key, kind, responsible, subject, opened_at, due_at, woken_at, state, closed_at, updated_at)
        VALUES ('obl_1', 'AR', 'AR-1', 'review_step', 'ana', 'review', '2026-10-18T10:00:00.000Z', '2026-10-18T10:30:00.000Z',
          '2026-10-18T10:31:00.000Z', 'fulfilled', '2026-10-18T12:00:00.000Z', '2026-10-18T12:00:00.000Z'),
          ('obl_2', 'AR', 'AR-2', 'work', 'dev', 'work', '2026-10-18T10:00:00.000Z', '2026-10-18T10:30:00.000Z',
          NULL, 'open', NULL, '2026-10-18T10:00:00.000Z');
        INSERT INTO team_messages (id, project_key, from_handle, to_handles, task_key, body, created_at, delivered_at, kind)
        VALUES ('m_wait', 'AR', 'system', '["ana"]', 'AR-1', 'projectman reminder: the review step of AR-1 waits', '2026-10-18T10:31:01.000Z', NULL, 'action'),
          ('m_norow', 'AR', 'system', '["ana"]', 'AR-3', 'projectman reminder: AR-3 waits', '2026-10-18T10:31:01.000Z', NULL, 'action'),
          ('m_human', 'AR', 'owner', '["ana"]', 'AR-1', 'projectman reminder: typed by a person', '2026-10-18T10:31:01.000Z', NULL, 'action'),
          ('m_done', 'AR', 'system', '["ana"]', 'AR-1', 'projectman reminder: already typed', '2026-10-18T10:31:01.000Z', '2026-10-18T10:32:00.000Z', 'action');
        INSERT INTO team_message_pending (message_id, project_key, handle, seq)
        SELECT id, project_key, 'ana', seq FROM team_messages WHERE id IN ('m_wait', 'm_norow', 'm_human');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.messages.get('m_wait')!.subject).toEqual({ type: 'obligation', obligationId: 'obl_1' });
      for (const id of ['m_norow', 'm_human', 'm_done'])
        expect(repos.messages.get(id)).not.toHaveProperty('subject');
    } finally {
      db.close();
    }
  });
});
