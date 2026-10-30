import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

/** PM-1150: the open Senior waits become `senior_wait` obligations; the table goes. */
describe('Senior wait obligation migration', () => {
  it('carries an unanswered, an asked and an ended wait over as the obligations they stand for', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version <= 130)) db.exec(migration.sql);
      db.pragma('user_version = 130');
      db.exec(`INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at)
        VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO senior_waits (id, project_key, task_key, since, inbox_item_id, asked_at, decision, decided_by, decided_at, ended_at, end_reason)
        VALUES ('sw_quiet', 'AR', 'AR-1', '2026-10-18T10:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
          ('sw_asked', 'AR', 'AR-2', '2026-10-18T09:00:00.000Z', 'inb_asked', '2026-10-18T09:30:00.000Z', NULL, NULL, NULL, NULL, NULL),
          ('sw_answered', 'AR', 'AR-3', '2026-10-18T08:00:00.000Z', 'inb_answered', '2026-10-18T08:30:00.000Z',
            'wait', 'owner', '2026-10-18T08:40:00.000Z', NULL, NULL),
          ('sw_ended', 'AR', 'AR-4', '2026-10-18T07:00:00.000Z', NULL, NULL, NULL, NULL, NULL, '2026-10-18T07:10:00.000Z', 'senior');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'senior_waits'").all()).toEqual([]);
      const repos = createRepositories(db);
      const live = repos.obligations.listLive('AR').filter((row) => row.kind === 'senior_wait');
      expect(live.map((row) => row.taskKey).sort()).toEqual(['AR-1', 'AR-2', 'AR-3']);
      expect(repos.obligations.liveOfKind('AR', 'AR-1', 'senior_wait')).toMatchObject({
        responsible: null,
        subject: 'senior_busy@2026-10-18T10:00:00.000Z',
        openedAt: '2026-10-18T10:00:00.000Z',
        dueAt: '2026-10-18T10:30:00.000Z',
        state: 'open',
        handedOverAt: null,
        inboxItemId: null,
      });
      // The question stays with its item; the owners' answer is read from that item.
      expect(repos.obligations.liveOfKind('AR', 'AR-2', 'senior_wait')).toMatchObject({
        state: 'handed_over',
        handedOverAt: '2026-10-18T09:30:00.000Z',
        inboxItemId: 'inb_asked',
      });
      expect(repos.obligations.liveOfKind('AR', 'AR-3', 'senior_wait')).toMatchObject({
        state: 'handed_over',
        inboxItemId: 'inb_answered',
      });
      expect(repos.obligations.liveOfKind('AR', 'AR-4', 'senior_wait')).toBeNull();
    } finally {
      db.close();
    }
  });
});
