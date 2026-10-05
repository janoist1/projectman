import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

describe('team message answers migration', () => {
  it('adds the answer column, leaves old messages without an answer and stores a new one', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version <= 32)) db.exec(migration.sql);
      db.pragma('user_version = 32');
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO team_messages (id, project_key, from_handle, to_handles, task_key, body, created_at, delivered_at)
        VALUES ('msg_old', 'AR', 'owner', '["dev"]', NULL, 'Answer to your question "Which?":\n\nThis one', '2026-01-01', NULL);`);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      const old = repos.messages.get('msg_old');
      expect(old).toMatchObject({ id: 'msg_old', from: 'owner', to: ['dev'] });
      expect(old).not.toHaveProperty('answer');

      repos.messages.insert({
        id: 'msg_new',
        projectKey: 'AR',
        from: 'owner',
        to: ['dev'],
        taskKey: null,
        body: 'Answer to your question "Which?":\n\nThis one',
        createdAt: '2026-01-02',
        deliveredAt: null,
        answer: { inboxItemId: 'inb_1', question: 'Which?', answer: 'This one' },
      });
      expect(repos.messages.get('msg_new')?.answer).toEqual({
        inboxItemId: 'inb_1',
        question: 'Which?',
        answer: 'This one',
      });
      expect(repos.messages.list('AR').map((m) => [m.id, m.answer?.question])).toEqual([
        ['msg_old', undefined],
        ['msg_new', 'Which?'],
      ]);
    } finally {
      db.close();
    }
  });
});
