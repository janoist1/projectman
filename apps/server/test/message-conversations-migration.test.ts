import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

it('preserves legacy card messages and scopes client request uniqueness by project and sender', () => {
  const db = new Database(':memory:');
  try {
    for (const migration of migrations.filter((m) => m.version < 146)) db.exec(migration.sql);
    db.pragma('user_version = 145');
    db.exec(`INSERT INTO projects (key, name, config_version, created_at, updated_at) VALUES ('AR', 'Example', 'v1', '2026-01-01', '2026-01-01');
      INSERT INTO projects (key, name, config_version, created_at, updated_at) VALUES ('OTHER', 'Other', 'v1', '2026-01-01', '2026-01-01');
      INSERT INTO team_messages (id, project_key, from_handle, to_handles, task_key, body, created_at)
      VALUES ('old', 'AR', 'owner', '["pm"]', 'AR-1', 'Legacy message', '2026-01-01');`);
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    const repos = createRepositories(db);
    const old = repos.messages.get('old')!;
    expect(old).not.toHaveProperty('conversation');
    repos.messages.insert({ ...old, id: 'new', conversation: 'direct' }, 'request');
    expect(repos.messages.list('AR', { taskKey: 'AR-1', place: 'card' })).toEqual([old]);
    expect(repos.messages.byClientRequest('AR', 'owner', 'request')?.conversation).toBe('direct');
    expect(() => repos.messages.insert({ ...old, id: 'duplicate' }, 'request')).toThrow();
    repos.messages.insert({ ...old, id: 'other-sender', from: 'dev' }, 'request');
    repos.messages.insert({ ...old, id: 'other-project', projectKey: 'OTHER' }, 'request');
    expect(repos.messages.byClientRequest('OTHER', 'owner', 'request')?.id).toBe('other-project');
    expect(() =>
      db.prepare('UPDATE team_messages SET conversation = ? WHERE id = ?').run('card', 'old'),
    ).toThrow();
  } finally {
    db.close();
  }
});
