import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';

const withMailbox = { email: { enabled: true, mailbox: 'builder' }, complexityLimit: 5 };

describe('removal of the mailbox name from stored commands (PM-1039)', () => {
  it('drops email.mailbox from stored super commands and approvals and leaves the rest as it was', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version <= 121)) db.exec(migration.sql);
      db.pragma('user_version = 121');
      db.exec(
        `INSERT INTO projects (key, name, config_version, created_at, updated_at)
         VALUES ('AR', 'Example', 'v1', '2026-01-01', '2026-01-01');`,
      );
      const memberUpdate = { kind: 'member_update', request: { handle: 'dev-1', ...withMailbox } };
      const operate = { kind: 'operate', operation: { changes: withMailbox } };
      const untouched = { kind: 'member_update', request: { handle: 'dev-2', email: { enabled: true } } };
      db.prepare(
        `INSERT INTO super_handoffs (id, project_key, request_id, requested_by, reason, command, command_hash,
           state, created_at, updated_at)
         VALUES (?, 'AR', ?, '{}', 'Reason', ?, 'hash', 'pending', '2026-01-02', '2026-01-02')`,
      ).run('sho_1', 'req-1', JSON.stringify(memberUpdate));
      db.prepare(
        `INSERT INTO super_operations (id, project_key, key_id, request_id, command, command_hash, state,
           created_at, updated_at)
         VALUES (?, 'AR', 'ikey_1', ?, ?, 'hash', 'pending', '2026-01-02', '2026-01-02')`,
      ).run('sop_1', 'req-1', JSON.stringify(operate));
      db.prepare(
        `INSERT INTO super_operations (id, project_key, key_id, request_id, command, command_hash, state,
           created_at, updated_at)
         VALUES (?, 'AR', 'ikey_1', ?, ?, 'hash', 'pending', '2026-01-02', '2026-01-02')`,
      ).run('sop_2', 'req-2', JSON.stringify(untouched));
      const insertInbox = db.prepare(
        `INSERT INTO inbox_items (id, project_key, kind, assignees, source, title, payload, options, state,
           created_at, updated_at)
         VALUES (?, 'AR', ?, '[]', 'system', 'Title', ?, '[]', 'open', '2026-01-02', '2026-01-02')`,
      );
      insertInbox.run(
        'inb_1',
        'approval',
        JSON.stringify({ operator: { operation: { changes: withMailbox } } }),
      );
      insertInbox.run(
        'inb_2',
        'approval',
        JSON.stringify({
          operatorKnowledge: { operations: [{ changes: { complexityLimit: 3 } }, { changes: withMailbox }] },
        }),
      );
      // Not an approval: its payload is not ours to rewrite.
      insertInbox.run(
        'inb_3',
        'question',
        JSON.stringify({ operator: { operation: { changes: withMailbox } } }),
      );

      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);

      const command = (table: string, id: string) =>
        JSON.parse(
          (db.prepare(`SELECT command FROM ${table} WHERE id = ?`).get(id) as { command: string }).command,
        );
      const payload = (id: string) =>
        JSON.parse(
          (db.prepare('SELECT payload FROM inbox_items WHERE id = ?').get(id) as { payload: string }).payload,
        );
      expect(command('super_handoffs', 'sho_1')).toEqual({
        kind: 'member_update',
        request: { handle: 'dev-1', email: { enabled: true }, complexityLimit: 5 },
      });
      expect(command('super_operations', 'sop_1')).toEqual({
        kind: 'operate',
        operation: { changes: { email: { enabled: true }, complexityLimit: 5 } },
      });
      expect(command('super_operations', 'sop_2')).toEqual(untouched);
      expect(payload('inb_1')).toEqual({
        operator: { operation: { changes: { email: { enabled: true }, complexityLimit: 5 } } },
      });
      expect(payload('inb_2').operatorKnowledge.operations[1]).toEqual({
        changes: { email: { enabled: true }, complexityLimit: 5 },
      });
      expect(payload('inb_3').operator.operation.changes.email.mailbox).toBe('builder');
    } finally {
      db.close();
    }
  });
});
