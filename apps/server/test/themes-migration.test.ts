import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate, schemaVersion } from '../src/db';
import { migrations } from '../src/db/migrations';

/** PM-205: the card kind and theme columns arrive next to the cards a database already holds. */
describe('card kind and theme migration', () => {
  it('keeps every card, link and timeline event of an older database, as plain cards with no theme', () => {
    const db = new Database(':memory:');
    try {
      // A database as the build before this migration left it.
      const before = migrations.filter((item) => item.version < 25);
      for (const migration of before) db.exec(migration.sql);
      db.pragma(`user_version = ${Math.max(...before.map((item) => item.version))}`);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at, parent_key)
        VALUES ('tsk_1', 'AR', 'AR-1', 1, 'Parent', 'A collecting card', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01', NULL),
               ('tsk_2', 'AR', 'AR-2', 2, 'Child', '', 'development', 'active', 'internal', 'owner', '2026-01-01', '2026-01-01', 'AR-1'),
               ('tsk_3', 'AR', 'AR-3', 3, 'Done one', '', 'done', 'done', 'shared', 'owner', '2026-01-01', '2026-01-02', NULL);
        INSERT INTO task_links (task_id, kind, ref, repo, created_at, updated_at)
        VALUES ('tsk_2', 'prerequisite', 'AR-3', '', '2026-01-01', '2026-01-01'),
               ('tsk_1', 'related', 'AR-3', '', '2026-01-01', '2026-01-01'),
               ('tsk_3', 'pull_request', '7', 'acme/shop', '2026-01-01', '2026-01-01');
        INSERT INTO timeline_events (id, project_key, task_key, actor_kind, actor_handle, type, data, created_at)
        VALUES ('evt_1', 'AR', 'AR-1', 'human', 'owner', 'task_created', '{"title":"Parent"}', '2026-01-01'),
               ('evt_2', 'AR', 'AR-2', 'human', 'owner', 'task_subtask_added', '{"parentKey":"AR-1","subtaskKey":"AR-2"}', '2026-01-01'),
               ('evt_3', 'AR', 'AR-3', 'human', 'owner', 'task_relation_added', '{"kind":"prerequisite_of","ref":"AR-2"}', '2026-01-01');`);
      const events = () => db.prepare('SELECT * FROM timeline_events ORDER BY seq').all();
      const links = () => db.prepare('SELECT * FROM task_links ORDER BY id').all();
      const eventsBefore = events();
      const linksBefore = links();

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

      // Every old row is a task, with no theme stored; its events and links are not touched.
      expect(db.prepare('SELECT key, kind, theme_key FROM tasks ORDER BY seq').all()).toEqual([
        { key: 'AR-1', kind: 'task', theme_key: null },
        { key: 'AR-2', kind: 'task', theme_key: null },
        { key: 'AR-3', kind: 'task', theme_key: null },
      ]);
      expect(events()).toEqual(
        eventsBefore.map((event) => ({ ...(event as Record<string, unknown>), actor_via: null })),
      );
      expect(links()).toEqual(linksBefore);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_theme'").all(),
      ).toHaveLength(1);

      // They read as they did: no kind, no theme, the parent and the links where they were.
      const repos = createRepositories(db);
      const parent = repos.tasks.get('AR-1')!;
      expect(parent.kind).toBeUndefined();
      expect(parent.themeKey).toBeUndefined();
      expect(repos.tasks.get('AR-2')).toMatchObject({
        parentKey: 'AR-1',
        links: [{ kind: 'prerequisite', ref: 'AR-3' }],
      });
      expect(repos.tasks.get('AR-3')).toMatchObject({
        status: 'done',
        links: [{ kind: 'pull_request', ref: '7', repo: 'acme/shop' }],
      });
      expect(repos.tasks.list('AR').map((task) => task.key)).toEqual(['AR-1', 'AR-2', 'AR-3']);

      // The new columns work next to them: a theme, a card in it and its subtask reading the theme.
      repos.tasks.insert({
        ...parent,
        id: 'tsk_4',
        key: 'AR-4',
        title: 'A theme',
        kind: 'theme',
        links: [],
      });
      repos.tasks.update('tsk_1', { themeKey: 'AR-4' });
      expect(repos.tasks.get('AR-4')).toMatchObject({ kind: 'theme' });
      expect(repos.tasks.get('AR-1')).toMatchObject({ themeKey: 'AR-4' });
      expect(repos.tasks.get('AR-2')).toMatchObject({ themeKey: 'AR-4', parentKey: 'AR-1' });

      // A second run applies nothing and keeps what was stored.
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(repos.tasks.get('AR-1')).toMatchObject({ themeKey: 'AR-4' });
    } finally {
      db.close();
    }
  });
});
