import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRepositories, migrate } from '../src/db';
import { handleColumns } from '../src/db/member-handles';
import type { Repositories } from '../src/db';
import type { MigrationFile } from '../src/db/migration-files';

const AT = '2026-10-27T10:00:00.000Z';
/** Column names that hold, or look like they hold, a member's handle. */
const HANDLE_LIKE =
  /handle|member|^author$|assignee|(^|_)by$|^by$|decider|^actor$|mover|merger|responsible|^contact$|^notified$|delivered_to|^cwd$|transcript_path|case_key|^spec$/;
/** `source` columns that hold a member (the rest name a kind). */
const SOURCE_OF_HANDLE = ['inbox_items.source'];

describe('member handle columns (PM-1025)', () => {
  let db: Database.Database;
  let repos: Repositories;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    repos = createRepositories(db);
  });

  it.each([false, true])('classifies every handle-like column (baseline only: %s)', (baselineOnly) => {
    if (baselineOnly) {
      db.close();
      db = new Database(':memory:');
      migrate(db, []);
    }
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    )
      .map((row) => row.name)
      .filter((name) => !name.startsWith('history_fts'));
    const { rewritten, json, unrewritten } = baselineOnly ? handleColumns([]) : handleColumns();
    const classified = new Set([
      ...rewritten.flatMap((entry) => entry.columns.map((column) => `${entry.table}.${column}`)),
      ...json.map((entry) => `${entry.table}.${entry.column}`),
      ...Object.keys(unrewritten),
    ]);
    const columns = tables.flatMap((table) =>
      (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
        (column) => `${table}.${column.name}`,
      ),
    );
    const existing = new Set(columns);
    const handleLike = columns.filter(
      (name) => HANDLE_LIKE.test(name.split('.')[1]!) || SOURCE_OF_HANDLE.includes(name),
    );
    expect(handleLike.filter((name) => !classified.has(name))).toEqual([]);
    expect([...classified].filter((name) => !existing.has(name))).toEqual([]);
    expect(Object.values(unrewritten).every((reason) => reason.length > 10)).toBe(true);
  });

  it('rewrites the handle in its own project only, plain columns and JSON lists alike', () => {
    for (const key of ['AR', 'BR'])
      db.prepare(
        `INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at) VALUES (?, ?, NULL, 'v1', ?, ?)`,
      ).run(key, key, AT, AT);
    const message = db.prepare(
      `INSERT INTO team_messages (id, project_key, from_handle, to_handles, body, created_at, receipts)
       VALUES (?, ?, ?, ?, 'hi', ?, ?)`,
    );
    const receipts = JSON.stringify([
      { handle: 'dev', kind: 'ai', deliveredAt: null, readAt: null, handedOffTo: 'dev' },
      { handle: 'other', kind: 'ai', deliveredAt: null, readAt: null },
    ]);
    message.run('m-ar', 'AR', 'dev', JSON.stringify(['other', 'dev']), AT, receipts);
    message.run('m-br', 'BR', 'dev', JSON.stringify(['dev']), AT, receipts);
    db.prepare(
      `INSERT INTO member_state (project_key, handle, status, updated_at) VALUES ('AR', 'dev', 'idle', ?)`,
    ).run(AT);

    repos.memberHandles.rename('AR', 'dev', 'haini');

    const row = (id: string) =>
      db.prepare('SELECT from_handle, to_handles, receipts FROM team_messages WHERE id = ?').get(id) as {
        from_handle: string;
        to_handles: string;
        receipts: string;
      };
    expect(row('m-ar').from_handle).toBe('haini');
    expect(JSON.parse(row('m-ar').to_handles)).toEqual(['other', 'haini']);
    expect(JSON.parse(row('m-ar').receipts)).toMatchObject([
      { handle: 'haini', handedOffTo: 'haini' },
      { handle: 'other' },
    ]);
    expect(row('m-br')).toMatchObject({ from_handle: 'dev', to_handles: '["dev"]' });
    expect(db.prepare(`SELECT handle FROM member_state WHERE project_key = 'AR'`).all()).toEqual([
      { handle: 'haini' },
    ]);

    repos.memberHandles.rename('AR', 'dev', 'haini');
    expect(JSON.parse(row('m-ar').to_handles)).toEqual(['other', 'haini']);
  });
});

it('applies handle additions, removals and table drops in version order', () => {
  const files: MigrationFile[] = [
    {
      version: 1,
      name: 'add',
      sql: '',
      meta: {
        tables: {
          example: {
            handles: {
              rewritten: ['author'],
              json: { watchers: 'handles' },
              unrewritten: { cwd: 'a stable storage path' },
              scope: 'id = @project',
            },
          },
        },
      },
    },
    {
      version: 2,
      name: 'remove',
      sql: '',
      meta: {
        tables: { example: { handles: { removed: ['author', 'watchers', 'cwd'], rewritten: ['member'] } } },
      },
    },
    { version: 3, name: 'drop', sql: '', meta: { tables: { example: { dropped: true } } } },
  ];
  expect(handleColumns(files.slice(0, 1)).rewritten.find((e) => e.table === 'example')).toEqual({
    table: 'example',
    columns: ['author'],
    scope: 'id = @project',
  });
  const removed = handleColumns(files.slice(0, 2));
  expect(removed.rewritten.find((e) => e.table === 'example')?.columns).toEqual(['member']);
  expect(removed.json.some((e) => e.table === 'example')).toBe(false);
  expect(removed.unrewritten['example.cwd']).toBeUndefined();
  expect(handleColumns([...files].reverse()).rewritten.some((e) => e.table === 'example')).toBe(false);
});
