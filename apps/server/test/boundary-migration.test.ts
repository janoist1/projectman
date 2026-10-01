import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { InboxItem, TimelineEvent } from '@projectman/shared';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, migrations } from '../src/db';

describe('boundary migration', () => {
  it('preserves old inbox and timeline data and is idempotent', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version <= 11)) db.exec(migration.sql);
      db.pragma('user_version = 11');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO inbox_items (id, project_key, kind, assignees, source, title, payload, options, state, created_at, updated_at)
        VALUES ('old_request', 'AR', 'question', '["owner"]', 'developer', 'Old question', '{}', '[]', 'open', '2026-01-01', '2026-01-01');
        INSERT INTO timeline_events (id, project_key, actor_kind, actor_handle, type, data, created_at)
        VALUES ('old_event', 'AR', 'human', 'owner', 'task_check_changed', '{"check":"code_review","to":"passed"}', '2026-01-01');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(InboxItem.parse(repos.inbox.get('old_request')).kind).toBe('question');
      expect(TimelineEvent.parse(repos.timeline.list('AR')[0]).type).toBe('task_check_changed');
      expect(repos.boundary.list()).toEqual([]);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'boundary_grants'").get()).toBeDefined();
    } finally {
      db.close();
    }
  });
});
