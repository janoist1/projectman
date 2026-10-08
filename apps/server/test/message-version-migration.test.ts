import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('team message versions migration', () => {
  it('preserves legacy messages and safely reads new and malformed metadata', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((m) => m.version <= 37)) db.exec(migration.sql);
      db.pragma('user_version = 37');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO team_messages (id, project_key, from_handle, to_handles, task_key, body, created_at, delivered_at)
        VALUES ('old', 'AR', 'dev', '["cr"]', NULL, 'Old request', '2026-01-01', NULL);`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      const old = repos.messages.get('old')!;
      expect(old).not.toHaveProperty('kind');
      expect(old).not.toHaveProperty('version');
      const version = { stageId: 'review', commit: 'A', reviewCommit: 'A' };
      const subject = { type: 'permission' as const, inboxItemId: 'inb_1' };
      repos.messages.insert({ ...old, id: 'new', body: 'Current request', kind: 'action', version, subject });
      expect(repos.messages.get('new')).toMatchObject({ kind: 'action', version, subject });
      expect(repos.messages.hasNewerAction(old, 'cr')).toBe(false);
      repos.messages.insert({ ...old, id: 'newer_action', kind: 'action', version });
      // The sequence resolves newer requests even when both timestamps are identical.
      expect(repos.messages.hasNewerAction(old, 'cr')).toBe(true);
      expect(repos.messages.hasNewerAction(old, 'other')).toBe(false);
      const system = { ...old, from: 'system', kind: 'action' as const };
      repos.messages.insert({ ...system, id: 'system_1' });
      repos.messages.insert({ ...system, id: 'system_2' });
      expect(repos.messages.hasNewerAction(repos.messages.get('system_1')!, 'cr')).toBe(false);
      repos.messages.insert({
        ...system,
        id: 'permission_1',
        subject: { type: 'permission', inboxItemId: 'inb_1' },
      });
      repos.messages.insert({
        ...system,
        id: 'permission_2',
        subject: { type: 'permission', inboxItemId: 'inb_2' },
      });
      expect(repos.messages.hasNewerAction(repos.messages.get('permission_1')!, 'cr')).toBe(false);
      repos.messages.insert({
        ...system,
        id: 'permission_3',
        subject: { type: 'permission', inboxItemId: 'inb_1' },
      });
      expect(repos.messages.hasNewerAction(repos.messages.get('permission_1')!, 'cr')).toBe(true);
      db.prepare('UPDATE team_messages SET kind = ?, version = ?, subject = ? WHERE id = ?').run(
        'bogus',
        '{',
        '{"type":"other"}',
        'new',
      );
      const malformed = repos.messages.get('new')!;
      for (const field of ['kind', 'version', 'subject']) expect(malformed).not.toHaveProperty(field);
    } finally {
      db.close();
    }
  });
});
