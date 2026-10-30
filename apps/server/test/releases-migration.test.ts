import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

/** PM-491: the release records arrive next to the data a database already holds. */
describe('releases migration', () => {
  it('cancels only open legacy release approvals and retains their payloads', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      // Back to before migration 129; the later migration 130 (PM-1135) creates its table again, so drop it.
      db.exec('DROP TABLE task_acceptance_items');
      // Migration 131 (PM-1150) drops `senior_waits` and reads it on the way: give it an empty one back.
      db.exec(`CREATE TABLE senior_waits (id TEXT PRIMARY KEY, project_key TEXT, task_key TEXT, since TEXT,
        inbox_item_id TEXT, asked_at TEXT, ended_at TEXT)`);
      db.pragma('user_version = 128');
      db.exec(
        "INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at) VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01')",
      );
      const insert = db.prepare(`INSERT INTO inbox_items
        (id, project_key, kind, assignees, source, title, payload, options, state, created_at, updated_at)
        VALUES (?, 'AR', ?, '[]', 'devops', 'Historical release', ?, '[]', ?, '2026-01-01', '2026-01-01')`);
      const payload = JSON.stringify({ release: { releaseId: 'rel_legacy' } });
      insert.run('open-release', 'release', payload, 'open');
      insert.run('closed-release', 'release', payload, 'resolved');
      insert.run('open-question', 'question', '{}', 'open');
      migrate(db);
      expect(db.prepare('SELECT id, state, payload FROM inbox_items ORDER BY id').all()).toEqual([
        { id: 'closed-release', state: 'resolved', payload },
        { id: 'open-question', state: 'open', payload: '{}' },
        { id: 'open-release', state: 'cancelled', payload },
      ]);
    } finally {
      db.close();
    }
  });

  it('adds the table to an older database and keeps one open release for each project', () => {
    const db = new Database(':memory:');
    try {
      const before = migrations.filter((item) => item.version < 51);
      for (const migration of before) db.exec(migration.sql);
      db.pragma(`user_version = ${Math.max(...before.map((item) => item.version))}`);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');`);

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.releases.list('AR')).toEqual([]);
      expect(repos.releases.open('AR')).toBeNull();

      const release = {
        id: 'rel_1',
        projectKey: 'AR',
        repo: 'web',
        taskKey: 'AR-1',
        state: 'proposed' as const,
        commit: 'a'.repeat(40),
        baseCommit: null,
        tasks: ['AR-2'],
        summary: 'Summary',
        proposedBy: 'devops',
        proposedAt: '2026-01-01T00:00:00.000Z',
        decidedBy: null,
        decidedAt: null,
        deployStartedAt: null,
        previousCommit: null,
        liveAt: null,
        tag: null,
        url: null,
        publishedAt: null,
        failure: null,
        publishError: null,
      };
      repos.releases.insert(release, release.proposedAt);
      expect(repos.releases.get('rel_1')).toEqual(release);
      expect(repos.releases.open('AR')?.id).toBe('rel_1');
      // A second open release of the project is refused by the database itself.
      expect(() =>
        repos.releases.insert({ ...release, id: 'rel_2', taskKey: 'AR-3' }, release.proposedAt),
      ).toThrow();
      // Once the first one is over, the next can be recorded.
      repos.releases.save({ ...release, state: 'rejected' }, release.proposedAt);
      expect(repos.releases.open('AR')).toBeNull();
      repos.releases.insert({ ...release, id: 'rel_2', taskKey: 'AR-3' }, release.proposedAt);
      expect(repos.releases.open('AR')?.id).toBe('rel_2');
    } finally {
      db.close();
    }
  });
});
