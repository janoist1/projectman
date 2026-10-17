import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDomainContext, createEventBus } from '../src/core/base';
import { createRepositories, migrate } from '../src/db';
import { CHANGE_TRIGGER_TABLES, changeTriggerName } from '../src/db/change-triggers';
import type { Repositories } from '../src/db';
import { capturingLogger } from './helpers/fakes';

const AT = '2026-10-14T10:00:00.000Z';

describe('project change journal (database)', () => {
  let db: Database.Database;
  let repos: Repositories;

  const addProject = (key: string) =>
    db
      .prepare(
        `INSERT INTO projects (key, name, template_id, config_version, created_at, updated_at) VALUES (?, ?, NULL, 'v1', ?, ?)`,
      )
      .run(key, `Project ${key}`, AT, AT);
  const addTask = (project: string, n: number) =>
    db
      .prepare(
        `INSERT INTO tasks (id, project_key, key, seq, title, description, stage_id, status, visibility, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Title', '', 'backlog', 'active', 'internal', 'owner', ?, ?)`,
      )
      .run(`id-${project}-${n}`, project, `${project}-${n}`, n, AT, AT);
  const journal = (project: string) => repos.projectChanges.list(project, 0, 500);

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    repos = createRepositories(db);
  });
  afterEach(() => db.close());

  it('has a trigger for every table and statement it announces (a table rebuild must create them again)', () => {
    const names = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]).map(
        (row) => row.name,
      ),
    );
    for (const entry of CHANGE_TRIGGER_TABLES)
      for (const statement of entry.on)
        expect(names.has(changeTriggerName(entry.table, statement)), `${entry.table} ${statement}`).toBe(
          true,
        );
  });

  it('keeps a stable generation and numbers the entries in commit order', () => {
    const generation = repos.projectChanges.generation();
    expect(generation).toMatch(/^[0-9a-f]{32}$/);
    expect(createRepositories(db).projectChanges.generation()).toBe(generation);
    addProject('AR');
    addTask('AR', 1);
    addTask('AR', 2);
    const rows = journal('AR');
    expect(rows.map((row) => [row.kind, row.entityId])).toEqual([
      ['configuration', 'AR'],
      ['task', 'AR-1'],
      ['task', 'AR-2'],
    ]);
    expect(rows.map((row) => row.seq)).toEqual([...rows.map((row) => row.seq)].sort((a, b) => a - b));
    expect(repos.projectChanges.latestSeq()).toBe(rows.at(-1)!.seq);
  });

  it('writes the entry of an update and of a delete, and only to the project it belongs to', () => {
    addProject('AR');
    addProject('BR');
    addTask('AR', 1);
    const before = journal('BR').length;
    db.prepare(`UPDATE tasks SET title = 'Other' WHERE key = 'AR-1'`).run();
    db.prepare(`DELETE FROM tasks WHERE key = 'AR-1'`).run();
    expect(
      journal('AR')
        .filter((row) => row.kind === 'task')
        .map((row) => row.entityId),
    ).toEqual(['AR-1', 'AR-1', 'AR-1']);
    expect(journal('BR')).toHaveLength(before);
  });

  it('announces a configuration version that the recovery writes into the project record', () => {
    addProject('AR');
    const before = journal('AR').length;
    repos.projects.update('AR', { name: 'Renamed', configVersion: 'v2', updatedAt: AT });
    expect(
      journal('AR')
        .slice(before)
        .map((row) => [row.kind, row.entityId]),
    ).toEqual([['configuration', 'AR']]);
  });

  it('names a pause of the whole instance in every project', () => {
    addProject('AR');
    addProject('BR');
    db.prepare(
      `INSERT INTO pauses (id, scope, project_key, kind, source, requested_at, force_after_ms)
       VALUES ('pause-1', 'instance', NULL, 'manual', 'app', ?, 1000)`,
    ).run(AT);
    for (const project of ['AR', 'BR'])
      expect(
        journal(project)
          .filter((row) => row.kind === 'pause')
          .map((row) => row.entityId),
      ).toEqual(['pause-1']);
  });

  it('writes no row for a link of a card that a cascade removes with it', () => {
    addProject('AR');
    addTask('AR', 1);
    addTask('AR', 2);
    db.prepare(
      `INSERT INTO task_links (task_id, kind, ref, repo, created_at, updated_at) VALUES ('id-AR-1', 'pr', '1', 'r', ?, ?)`,
    ).run(AT, AT);
    expect(
      journal('AR')
        .filter((row) => row.kind === 'task')
        .map((row) => row.entityId),
    ).toEqual(['AR-1', 'AR-2', 'AR-1']);
    expect(() => db.prepare(`DELETE FROM tasks WHERE key = 'AR-1'`).run()).not.toThrow();
  });

  describe('waiting reader', () => {
    const context = () =>
      createDomainContext({
        repos,
        bus: createEventBus(),
        logger: capturingLogger().logger,
        now: () => new Date(AT),
      });

    it('does not miss a change that commits between its first read and its listening', async () => {
      addProject('AR');
      const ctx = context();
      const start = ctx.journal.read('AR', undefined, 500).nextCursor;
      const started = Date.now();
      const page = await ctx.journal.poll({
        projectKey: 'AR',
        after: start,
        limit: 10,
        waitMs: 10_000,
        recheck: () => undefined,
        // Runs after the first read, before the reader sleeps: the commit falls into the gap.
        subscribe: () => {
          ctx.journal.record('AR', 'timeline', 'evt-gap');
          return () => undefined;
        },
      });
      expect(page.events.map((event) => event.entityId)).toEqual(['evt-gap']);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('checks the reader again when its key expires, without waiting for the safety poll', async () => {
      addProject('AR');
      const ctx = context();
      const start = ctx.journal.read('AR', undefined, 500).nextCursor;
      let expired = false;
      const started = Date.now();
      await expect(
        ctx.journal.poll({
          projectKey: 'AR',
          after: start,
          limit: 10,
          waitMs: 10_000,
          expiresInMs: () => (expired ? 0 : 50),
          recheck: () => {
            expired = true;
            throw new Error('expired');
          },
        }),
      ).rejects.toThrow('expired');
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('ends the wait with the server stopping, and leaves no waiter behind', async () => {
      addProject('AR');
      const ctx = context();
      const start = ctx.journal.read('AR', undefined, 500).nextCursor;
      const waiting = ctx.journal.poll({
        projectKey: 'AR',
        after: start,
        limit: 10,
        waitMs: 10_000,
        recheck: () => undefined,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      ctx.journal.stop();
      await expect(waiting).rejects.toMatchObject({ code: 'server_stopping' });
    });
  });

  it('leaves no row behind when the change rolls back, also inside nested units of work', () => {
    addProject('AR');
    const ctx = createDomainContext({
      repos,
      bus: createEventBus(),
      logger: capturingLogger().logger,
      now: () => new Date(AT),
    });
    const base = journal('AR').length;
    expect(() =>
      ctx.unitOfWork(() => {
        addTask('AR', 1);
        ctx.journal.record('AR', 'timeline', 'evt-1');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(journal('AR')).toHaveLength(base);

    // An inner unit that fails and is swallowed by the outer one takes only its own entries back.
    ctx.unitOfWork(() => {
      addTask('AR', 2);
      try {
        ctx.unitOfWork(() => {
          addTask('AR', 3);
          throw new Error('inner');
        });
      } catch {
        // The outer change goes on.
      }
    });
    expect(
      journal('AR')
        .slice(base)
        .map((row) => row.entityId),
    ).toEqual(['AR-2']);
  });
});
