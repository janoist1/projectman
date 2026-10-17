import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageKind } from '@projectman/shared';
import type { SuperActor, TeamMessage } from '@projectman/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createRepositories,
  migrate,
  migrations,
  openDatabase,
  schemaVersion,
  LATEST_SCHEMA_VERSION,
} from '../src/db';
import type { Db } from '../src/db';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';

const AT = '2026-10-17T08:00:00.000Z';
const SUPER: SuperActor = {
  kind: 'ai',
  handle: 'operator',
  via: 'integrator',
  operatorMode: 'super',
  credential: { id: 'ikey_fixture', prefix: 'pmi_fixture' },
};
const ACTOR_META = { operatorMode: SUPER.operatorMode, credential: SUPER.credential };
const receipt = (handle: string, kind: 'ai' | 'human' = 'ai', deliveredAt: string | null = null) => ({
  handle,
  kind,
  deliveredAt,
  readAt: null,
});
const message = (id: string, extra: Partial<TeamMessage> = {}): TeamMessage => ({
  id,
  projectKey: 'AR',
  from: 'owner',
  to: ['a', 'b', 'human'],
  taskKey: null,
  body: id,
  createdAt: AT,
  deliveredAt: null,
  ...extra,
});

function project(db: Db, key = 'AR') {
  db.prepare('INSERT INTO projects VALUES (?, ?, NULL, ?, ?, ?)').run(key, key, 'test', AT, AT);
}

const pendingPairs = (db: Db) =>
  db
    .prepare(
      `SELECT message_id, project_key, handle, seq
  FROM team_message_pending ORDER BY seq, handle`,
    )
    .all();

function parse(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

// Independent copy of the old predicate, including the parseJson(..., []) fallback.
function oldPending(db: Db, projectKey: string, handle: string) {
  const rows = db
    .prepare('SELECT * FROM team_messages WHERE project_key = ? ORDER BY seq')
    .all(projectKey) as Array<{
    id: string;
    to_handles: string;
    receipts: string | null;
    delivered_at: string | null;
  }>;
  return rows
    .filter((row) => {
      const to = parse(row.to_handles);
      if (!Array.isArray(to) || !to.includes(handle)) return false;
      const receipts = parse(row.receipts) as TeamMessage['receipts'];
      return receipts
        ? receipts.some((r) => r.handle === handle && r.kind === 'ai' && !r.deliveredAt)
        : !row.delivered_at;
    })
    .map((row) => row.id);
}

function expectEquivalent(repos: ReturnType<typeof createRepositories>) {
  for (const projectKey of ['AR', 'BR']) {
    for (const handle of ['a', 'b', 'human', 'outsider']) {
      const expected = oldPending(repos.db, projectKey, handle);
      expect(repos.messages.pending(projectKey, handle).map((m) => m.id)).toEqual(expected);
      expect(repos.messages.pendingCount(projectKey, handle)).toBe(expected.length);
    }
  }
}

describe('pending message recipient migration', () => {
  it('backfills legacy and receipt rows with the original fallbacks, then survives reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-pending-'));
    const path = join(dir, 'db.sqlite');
    let db = new Database(path);
    try {
      db.pragma('foreign_keys = ON');
      const migration = migrations.find((m) => m.name === 'pending message recipients')!;
      for (const m of migrations.filter((m) => m.version < migration.version)) db.exec(m.sql);
      db.pragma(`user_version = ${migration.version - 1}`);
      project(db);
      project(db, 'BR');
      const add = db.prepare(`INSERT INTO team_messages
        (id, project_key, from_handle, to_handles, body, created_at, delivered_at, receipts, kind)
        VALUES (?, ?, 'owner', ?, 'fixture', ?, ?, ?, ?)`);
      let n = 0;
      for (const receipts of [
        null,
        '',
        'null',
        '[]',
        '{',
        JSON.stringify([receipt('a'), receipt('b', 'ai', AT), receipt('human', 'human')]),
        JSON.stringify([receipt('a', 'ai', AT), receipt('b'), receipt('human', 'human', AT)]),
        JSON.stringify([receipt('a', 'human'), receipt('b', 'human'), receipt('outsider')]),
        JSON.stringify([receipt('a'), receipt('a', 'ai', AT), receipt('b', 'ai', '')]),
        JSON.stringify([{ handle: 'a', kind: 'ai' }]),
      ]) {
        for (const delivered of [null, '', AT])
          for (const kind of [null, 'info', 'action'])
            add.run(`msg_${n++}`, 'AR', '["a","a","b","human"]', AT, delivered, receipts, kind);
      }
      for (const to of ['{', '', 'null', '{}', '[1,null,true]'])
        add.run(`bad_to_${n++}`, 'AR', to, AT, null, null, null);
      add.run('other_project', 'BR', '["a"]', AT, null, null, 'info');
      add.run('super_origin', 'AR', '["a"]', AT, null, null, 'info');
      db.prepare('UPDATE team_messages SET from_handle = ?, via = ?, actor_meta = ? WHERE id = ?').run(
        SUPER.handle,
        SUPER.via,
        JSON.stringify(ACTOR_META),
        'super_origin',
      );
      const before = db.prepare('SELECT * FROM team_messages ORDER BY seq').all();
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(db.prepare('SELECT * FROM team_messages ORDER BY seq').all()).toEqual(before);
      const repos = createRepositories(db);
      expectEquivalent(repos);
      expect(repos.messages.pending('AR', 'a').find((m) => m.id === 'super_origin')?.actor).toEqual(SUPER);
      const pairs = pendingPairs(db);
      expect(pairs.length).toBeGreaterThan(0);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(pendingPairs(db)).toEqual(pairs);
      db.close();
      db = openDatabase(path);
      expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(pendingPairs(db)).toEqual(pairs);
      expectEquivalent(createRepositories(db));
      expect(createRepositories(db).messages.get('super_origin')?.actor).toEqual(SUPER);
      db.prepare('DELETE FROM team_messages WHERE id = ?').run('other_project');
      expect(
        db.prepare('SELECT * FROM team_message_pending WHERE message_id = ?').all('other_project'),
      ).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pending message repository', () => {
  it('decodes optional metadata once and preserves malformed-value fallbacks', () => {
    const db = openDatabase(':memory:');
    try {
      project(db);
      const repos = createRepositories(db);
      const version = { stageId: 'development', commit: null, reviewCommit: null };
      const subject = { type: 'permission' as const, inboxItemId: 'inb_fixture' };
      repos.messages.insert(
        message('metadata', {
          from: SUPER.handle,
          via: SUPER.via,
          actor: SUPER,
          kind: 'info',
          version,
          subject,
        }),
      );
      const parse = vi.spyOn(JSON, 'parse');
      try {
        for (const read of [
          () => repos.messages.get('metadata'),
          () => repos.messages.pending('AR', 'a')[0],
        ]) {
          parse.mockClear();
          expect(read()).toMatchObject({ kind: 'info', version, subject, actor: SUPER });
          for (const value of [version, subject, ACTOR_META])
            expect(parse.mock.calls.filter(([text]) => text === JSON.stringify(value))).toHaveLength(1);
        }
      } finally {
        parse.mockRestore();
      }
      db.prepare(
        'UPDATE team_messages SET kind = ?, version = ?, subject = ?, attachments = ?, actor_meta = ? WHERE id = ?',
      ).run('unknown', '{', 'null', '{', '{', 'metadata');
      const malformed = repos.messages.get('metadata');
      for (const field of ['kind', 'version', 'subject', 'attachments', 'actor'])
        expect(malformed).not.toHaveProperty(field);
    } finally {
      db.close();
    }
  });

  it('updates all recipients atomically for independent writes and nested transaction rollback', () => {
    const db = openDatabase(':memory:');
    try {
      project(db);
      project(db, 'BR');
      const repos = createRepositories(db);
      for (const kind of [undefined, 'info', 'action'] as const)
        repos.messages.insert(
          message(`msg_${kind}`, {
            kind,
            to: ['a', 'a', 'b', 'human'],
            receipts: [receipt('a'), receipt('b'), receipt('human', 'human')],
          }),
        );
      expectEquivalent(repos);
      expect(repos.messages.pendingCount('AR', 'a')).toBe(3);
      repos.messages.updateReceipts(
        'msg_info',
        [receipt('a', 'ai', AT), receipt('b'), receipt('human', 'human')],
        AT,
      );
      expectEquivalent(repos); // global timestamp must not hide b's undelivered receipt.
      repos.messages.markDelivered('msg_action', AT);
      expectEquivalent(repos); // markDelivered does not override pending AI receipts.
      repos.messages.insert(message('legacy'));
      repos.messages.markDelivered('legacy', AT);
      repos.messages.markDelivered('legacy', 'later');
      expect(repos.messages.get('legacy')?.deliveredAt).toBe(AT);
      expectEquivalent(repos);
      const source = db.prepare('SELECT * FROM team_messages ORDER BY seq').all();
      const pairs = pendingPairs(db);
      for (const write of [
        () => repos.messages.insert(message('rolled_back')),
        () => repos.messages.updateReceipts('msg_info', [receipt('b', 'ai', AT)], AT),
        () => repos.messages.markDelivered('msg_undefined', AT),
      ]) {
        expect(() =>
          repos.transaction(() => {
            write();
            throw new Error('outer rollback');
          }),
        ).toThrow('outer rollback');
        expect(db.prepare('SELECT * FROM team_messages ORDER BY seq').all()).toEqual(source);
        expect(pendingPairs(db)).toEqual(pairs);
      }
      expect(repos.messages.updateReceipts('missing', [], AT)).toBeNull();
      expect(repos.messages.markDelivered('missing', AT)).toBeNull();
      expect(pendingPairs(db)).toEqual(pairs);
    } finally {
      db.close();
    }
  });

  it('rolls back the source when derivation fails, even without an outer transaction', () => {
    const db = openDatabase(':memory:');
    try {
      project(db);
      const repos = createRepositories(db);
      repos.messages.insert(message('existing', { receipts: [receipt('a')] }));
      repos.messages.insert(message('legacy'));
      const source = db.prepare('SELECT * FROM team_messages ORDER BY seq').all();
      const pairs = pendingPairs(db);
      db.exec(`CREATE TRIGGER pending_insert_failure BEFORE INSERT ON team_message_pending
        WHEN NEW.handle = 'b' BEGIN SELECT RAISE(ABORT, 'pending derivation failed'); END;`);
      expect(() => repos.messages.insert(message('failed'))).toThrow('pending derivation failed');
      expect(() => repos.messages.updateReceipts('existing', [receipt('b')], AT)).toThrow(
        'pending derivation failed',
      );
      db.exec(`CREATE TRIGGER pending_delete_failure BEFORE DELETE ON team_message_pending
        BEGIN SELECT RAISE(ABORT, 'pending deletion failed'); END;`);
      expect(() => repos.messages.markDelivered('legacy', AT)).toThrow('pending deletion failed');
      expect(db.prepare('SELECT * FROM team_messages ORDER BY seq').all()).toEqual(source);
      expect(pendingPairs(db)).toEqual(pairs);
    } finally {
      db.close();
    }
  });

  it('uses the recipient index and decodes exactly the pending messages beyond a large delivered history', () => {
    const db = openDatabase(':memory:');
    try {
      project(db);
      const repos = createRepositories(db);
      repos.transaction(() => {
        for (let i = 0; i < 2000; i++)
          repos.messages.insert(
            message(`delivered_${i}`, { deliveredAt: AT, receipts: [receipt('a', 'ai', AT)] }),
          );
        repos.messages.insert(message('pending_1', { receipts: [receipt('a')] }));
        repos.messages.insert(message('pending_2', { kind: 'info', receipts: [receipt('a')] }));
        repos.messages.insert(message('other_handle', { receipts: [receipt('b')] }));
      });
      const parse = vi.spyOn(MessageKind, 'safeParse');
      try {
        expect(repos.messages.pendingCount('AR', 'a')).toBe(2);
        expect(parse).not.toHaveBeenCalled();
        expect(repos.messages.pending('AR', 'a').map((m) => m.id)).toEqual(['pending_1', 'pending_2']);
        expect(parse).toHaveBeenCalledTimes(2);
      } finally {
        parse.mockRestore();
      }
      // Inspect the actual repository SQL, not a separately maintained example query.
      const prepare = vi.spyOn(db, 'prepare');
      createRepositories(db);
      const queries = prepare.mock.calls
        .map(([sql]) => sql)
        .filter((sql) => /SELECT.*|SELECT\s/s.test(sql) && sql.includes('FROM team_message_pending'));
      prepare.mockRestore();
      expect(queries).toHaveLength(2);
      for (const sql of queries) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('AR', 'a') as Array<{ detail: string }>;
        expect(
          plan.some(
            (row) => row.detail.includes('SEARCH') && row.detail.includes('team_message_pending_recipient'),
          ),
        ).toBe(true);
        expect(plan.some((row) => /SCAN (m|team_messages)\b/.test(row.detail))).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});

it('keeps human reading, partial delivery, handoff and unitOfWork rollback consistent with pending counts', async () => {
  const h = await createDomainHarness();
  try {
    const record = (kind: 'info' | 'action') =>
      h.domain.messages.record({
        projectKey: 'AR',
        from: 'owner',
        to: ['dev-1', 'dev-2', 'owner'],
        taskKey: null,
        body: 'Synthetic delivery',
        actor: OWNER_ACTOR,
        humanRecipients: ['owner'],
        kind,
      });
    const info = record('info');
    const action = record('action');
    const count = () => h.domain.messaging.waitingForEngine('local');
    // Use the engine selected by the normal domain composition.
    const pending = () => ['dev-1', 'dev-2'].map((handle) => h.repos.messages.pendingCount('AR', handle));
    expect(pending()).toEqual([2, 2]);
    expect(count()).toBe(4);
    h.domain.messages.markRead('AR', info.id, 'owner');
    expect(pending()).toEqual([2, 2]);
    h.domain.messages.markRecipientDelivered(info.id, 'dev-1');
    expect(pending()).toEqual([1, 2]);
    expect(count()).toBe(3);
    h.domain.messages.markRecipientForwarded(info.id, 'dev-2', 'dev-1');
    expect(pending()).toEqual([1, 1]);
    expect(count()).toBe(2);
    expect(h.repos.messages.get(info.id)?.receipts?.find((r) => r.handle === 'dev-2')?.handedOffTo).toBe(
      'dev-1',
    );
    const before = pendingPairs(h.repos.db);
    expect(() =>
      h.domain.ctx.unitOfWork(() => {
        h.domain.messages.markRecipientDelivered(action.id, 'dev-1');
        h.domain.messages.markRecipientForwarded(action.id, 'dev-2', 'dev-1');
        record('info');
        throw new Error('unitOfWork rollback');
      }),
    ).toThrow('unitOfWork rollback');
    expect(pendingPairs(h.repos.db)).toEqual(before);
    h.domain.messages.markRecipientDelivered(action.id, 'dev-1');
    h.domain.messages.markRecipientDelivered(action.id, 'dev-2');
    h.domain.messages.markRecipientDelivered(action.id, 'dev-2');
    expect(pending()).toEqual([0, 0]);
    const hydrate = vi.spyOn(h.repos.messages, 'pending').mockImplementation(() => {
      throw new Error('must count without hydration');
    });
    try {
      expect(count()).toBe(0);
    } finally {
      hydrate.mockRestore();
    }
  } finally {
    await h.cleanup();
  }
});
