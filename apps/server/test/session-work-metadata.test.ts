import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories, LATEST_SCHEMA_VERSION, migrate } from '../src/db';
import { migrations } from '../src/db/migrations';
import { createDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/** PM-694: what a session's chat proves about its work, kept without text, and the migrations behind it. */
let h: DomainHarness;
let now: Date;
afterEach(async () => {
  await h?.cleanup();
});

const at = (seconds: number) => new Date(now.getTime() + seconds * 1000).toISOString();

describe('session work metadata', () => {
  async function start() {
    now = new Date('2026-10-14T10:00:00Z');
    h = await createDomainHarness({ now: () => now });
    await h.domain.tasks.create('AR', { title: 'Card', repo: 'web' }, { kind: 'human', handle: 'owner' });
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', {
      type: 'task',
      taskKey: 'AR-1',
    });
    return session;
  }
  const chat = (sessionId: string, ...items: Array<Record<string, unknown>>) =>
    h.runner.emit({ type: 'chat', sessionId, items } as never);
  const metadata = (sessionId: string) => h.domain.sessions.get('AR', sessionId).workMetadata;

  it('starts without metadata', async () => {
    const session = await start();
    expect(metadata(session.id)).toBeUndefined();
  });

  it('keeps the last step, tool and failure from the chat, with no text', async () => {
    const session = await start();
    chat(
      session.id,
      {
        id: 'c1',
        ts: at(-30),
        kind: 'tool_call',
        toolUseId: 't1',
        name: 'update_task',
        summary: 'confidential summary',
        input: { note: 'confidential input' },
      },
      {
        id: 'r1',
        ts: at(-29),
        kind: 'tool_result',
        toolUseId: 't1',
        ok: false,
        summary: 'confidential failure',
      },
    );
    expect(metadata(session.id)).toEqual({
      lastWorkAt: at(-30),
      lastTool: { name: 'update_task', at: at(-30) },
      lastError: { code: 'tool_failed', at: at(-29) },
    });
    const stored = h.repos.sessions.get(session.id)!;
    expect(JSON.stringify(stored)).not.toContain('confidential');
  });

  it('counts incoming messages and idle assistant text as no step', async () => {
    const session = await start();
    h.runner.setState(session.id, 'idle');
    chat(
      session.id,
      {
        id: 'm1',
        ts: at(-20),
        kind: 'team_message',
        direction: 'in',
        from: 'owner',
        to: ['dev-1'],
        text: 'Hi',
      },
      { id: 'a1', ts: at(-10), kind: 'assistant_text', text: 'Noted' },
    );
    expect(metadata(session.id)).toBeUndefined();
    h.runner.setState(session.id, 'working');
    chat(session.id, { id: 'a2', ts: at(-5), kind: 'assistant_text', text: 'Working' });
    expect(metadata(session.id)).toMatchObject({ lastWorkAt: at(-5), lastTool: null });
  });

  it('does not write forward when the same or earlier items come again', async () => {
    const session = await start();
    const call = (id: string, seconds: number) => ({
      id,
      ts: at(seconds),
      kind: 'tool_call',
      toolUseId: id,
      name: 'get_task',
      summary: '',
      input: {},
    });
    chat(session.id, call('c1', -10));
    const first = metadata(session.id);
    chat(session.id, call('c1', -10), call('c0', -50));
    expect(metadata(session.id)).toEqual(first);
    chat(session.id, call('c2', -2));
    expect(metadata(session.id)).toMatchObject({ lastWorkAt: at(-2) });
  });
});

describe('migrations 61 and 62', () => {
  it('keep the signals with their columns, allow the new kind and keep the open-case rule', () => {
    const db = new Database(':memory:');
    try {
      const before = migrations.filter((item) => item.version < 61);
      for (const migration of before) db.exec(migration.sql);
      db.pragma(`user_version = ${Math.max(...before.map((item) => item.version))}`);
      db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01');
        INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at, follow_up_at, decision_note, delivered_at)
          VALUES ('sig_1', 'AR', 'idle', 'idle:AR-1:development', 'dismissed', '2026-01-01T00:00:00.000Z',
          '2026-01-01T01:00:00.000Z', 'Not needed', '2026-01-01T00:00:05.000Z');`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      const repos = createRepositories(db);
      expect(repos.operatorSignals.get('sig_1')).toMatchObject({
        kind: 'idle',
        state: 'dismissed',
        followUpAt: '2026-01-01T01:00:00.000Z',
        decisionNote: 'Not needed',
        deliveredAt: '2026-01-01T00:00:05.000Z',
      });
      const insert = db.prepare(
        `INSERT INTO operator_signals (id, project_key, kind, case_key, state, raised_at)
          VALUES (?, 'AR', ?, ?, 'open', '2026-01-02T00:00:00.000Z')`,
      );
      insert.run('sig_2', 'answer_stalled', 'answer_stalled:AR-1:dev-1:msg_1');
      expect(() => insert.run('sig_3', 'answer_stalled', 'answer_stalled:AR-1:dev-1:msg_1')).toThrow();
      expect(() => insert.run('sig_4', 'bogus', 'bogus:1')).toThrow();
      expect(db.prepare('SELECT work_metadata FROM sessions LIMIT 1').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
