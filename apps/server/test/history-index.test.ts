import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { as, historyHarness } from './helpers/history';
import { HISTORY_INDEX_VERSION, LATEST_SCHEMA_VERSION, migrate, schemaVersion } from '../src/db';
import type { Repositories } from '../src/db';
import { createHistoryService } from '../src/services/history';
import { createHistoryIndexer } from '../src/services/history/indexer';

const OWNER = { handle: 'owner', access: 'owner' as const };

/** A history service of the test's own over the harness repositories, small pages, no timers of the domain. */
async function ownService(h: DomainHarness) {
  await h.domain.history.stop();
  const config: ProjectConfig = await h.domain.projects.config('AR');
  const service = createHistoryService({
    repos: h.repos,
    config: () => config,
    logger: h.log.logger,
    now: () => new Date('2026-10-01T10:00:00.000Z'),
    pageSize: 2,
  });
  return { service };
}

const count = (h: DomainHarness, where = '1 = 1') =>
  (h.repos.db.prepare(`SELECT COUNT(*) AS n FROM history_documents WHERE ${where}`).get() as { n: number }).n;
const titles = (h: DomainHarness, type: string) =>
  (
    h.repos.db
      .prepare('SELECT title, body FROM history_documents WHERE source_type = ? ORDER BY title, body')
      .all(type) as Array<{ title: string; body: string }>
  ).map((row) => (row.title === '' ? row.body : row.title));
const resetIndex = (h: DomainHarness) => {
  h.repos.db.exec(
    'DELETE FROM history_documents; DELETE FROM history_dirty; DELETE FROM history_index_state;',
  );
};

describe('history index', () => {
  let h: DomainHarness | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.cleanup();
    h = null;
  });

  it('indexes the sources of the database at start and follows later changes', async () => {
    h = await historyHarness();
    const card = await h.domain.tasks.create(
      'AR',
      { title: 'Alpaca card', description: 'wool' },
      OWNER_ACTOR,
    );
    h.domain.history.flush();
    expect(titles(h, 'task')).toEqual(['Alpaca card']);
    await h.domain.tasks.addNote('AR', card.key, 'a note about the alpaca', OWNER_ACTOR);
    h.domain.history.flush();
    expect(titles(h, 'note')).toEqual(['a note about the alpaca']);
    expect(h.repos.history.dirtyCount()).toBe(0);
    // A project that was empty at start has no checkpoint yet: the first call marks it complete.
    expect(h.repos.history.indexState('AR')).toBeNull();
    expect((await h.domain.history.search('AR', OWNER, { query: 'alpaca' })).matches).toHaveLength(2);
    expect(h.repos.history.indexState('AR')).toMatchObject({
      complete: true,
      version: HISTORY_INDEX_VERSION,
    });
  });

  it('does not queue a delivery receipt, a read mark or an unrelated task field', async () => {
    h = await historyHarness();
    const card = await h.domain.tasks.create('AR', { title: 'Receipts' }, OWNER_ACTOR);
    const message = h.domain.messages.record({
      projectKey: 'AR',
      from: 'dev-1',
      to: ['cr'],
      taskKey: null,
      body: 'receipts message',
      actor: OWNER_ACTOR,
    });
    h.domain.history.flush();
    expect(h.repos.history.dirtyCount()).toBe(0);
    h.repos.db
      .prepare('UPDATE team_messages SET delivered_at = ?, receipts = ? WHERE id = ?')
      .run('2026-10-02T10:00:00.000Z', '[]', message.id);
    h.repos.db
      .prepare('UPDATE tasks SET priority = ?, assignee = ? WHERE key = ?')
      .run('high', 'dev-1', card.key);
    expect(h.repos.history.dirtyCount()).toBe(0);
    h.repos.db.prepare('UPDATE team_messages SET body = ? WHERE id = ?').run('receipts changed', message.id);
    expect(h.repos.history.dirtyCount()).toBe(1);
  });

  it('removes the copy of a deleted source and of a note that stops being a note', async () => {
    h = await historyHarness();
    const card = await h.domain.tasks.create('AR', { title: 'Removal' }, OWNER_ACTOR);
    const note = await h.domain.tasks.addNote('AR', card.key, 'removable note', OWNER_ACTOR);
    h.domain.history.flush();
    expect(count(h, "source_type = 'note'")).toBe(1);
    h.repos.db.prepare("UPDATE timeline_events SET type = 'task_commented' WHERE id = ?").run(note.id);
    h.domain.history.flush();
    expect(count(h, "source_type = 'note'")).toBe(0);
    h.repos.db.prepare("UPDATE timeline_events SET type = 'task_note' WHERE id = ?").run(note.id);
    h.domain.history.flush();
    expect(count(h, "source_type = 'note'")).toBe(1);
    h.repos.db.prepare('DELETE FROM timeline_events WHERE id = ?').run(note.id);
    h.domain.history.flush();
    expect(count(h, "source_type = 'note'")).toBe(0);
    expect(h.repos.history.dirtyCount()).toBe(0);
  });

  describe('backfill', () => {
    async function fixture() {
      h = await historyHarness();
      for (let i = 0; i < 7; i++)
        await h.domain.tasks.create('AR', { title: `Backfill card ${i}` }, OWNER_ACTOR);
      for (let i = 0; i < 3; i++)
        await h.domain.tasks.addNote('AR', 'AR-1', `backfill note ${i}`, OWNER_ACTOR);
      for (let i = 0; i < 3; i++)
        h.domain.messages.record({
          projectKey: 'AR',
          from: 'dev-1',
          to: ['cr'],
          taskKey: null,
          body: `backfill message ${i}`,
          actor: OWNER_ACTOR,
          delivered: true,
        });
      const questions = [];
      for (let i = 0; i < 3; i++) {
        const item = h.domain.inbox.create({
          projectKey: 'AR',
          kind: 'question',
          source: 'dev-1',
          assignees: ['owner'],
          taskKey: null,
          title: `backfill question ${i}`,
          payload: { question: `backfill question ${i}` },
          options: [{ id: 'yes', label: 'Yes', style: 'primary' }],
        });
        await h.domain.inbox.resolve('AR', item.id, { optionId: 'yes' }, OWNER);
        questions.push(item);
      }
      await h.domain.history.stop();
      return h;
    }
    const snapshotOfIndex = (harness: DomainHarness) =>
      harness.repos.db
        .prepare(
          'SELECT source_id, source_type, task_key, author, at, title, body FROM history_documents ORDER BY source_id',
        )
        .all();

    it('reads the whole history into the index, page by page, and is the same index every time', async () => {
      const harness = await fixture();
      resetIndex(harness);
      const indexer = createHistoryIndexer({ repos: harness.repos, pageSize: 2 });
      let steps = 0;
      const seen = new Set<string>();
      while (!indexer.backfillStep('AR')) {
        steps++;
        const state = harness.repos.history.indexState('AR')!;
        expect(state.complete).toBe(false);
        seen.add(state.sourceType!);
        expect(steps).toBeLessThan(40);
      }
      expect([...seen]).toEqual(['task', 'note', 'question', 'message']);
      expect(harness.repos.history.indexState('AR')).toMatchObject({
        complete: true,
        sourceType: null,
        lastId: null,
      });
      const first = snapshotOfIndex(harness);
      expect(first.length).toBeGreaterThanOrEqual(7 + 3 + 3 + 3);
      // Repeated: a finished backfill reads nothing, and a forced second run writes the same index.
      expect(indexer.backfillStep('AR')).toBe(true);
      harness.repos.db.exec('DELETE FROM history_index_state');
      while (!indexer.backfillStep('AR'));
      expect(snapshotOfIndex(harness)).toEqual(first);
    });

    it('resumes from its checkpoint after an interruption, in a new indexer', async () => {
      const harness = await fixture();
      resetIndex(harness);
      const complete = (() => {
        const all = createHistoryIndexer({ repos: harness.repos, pageSize: 2 });
        while (!all.backfillStep('AR'));
        const rows = snapshotOfIndex(harness);
        resetIndex(harness);
        return rows;
      })();
      const interrupted = createHistoryIndexer({ repos: harness.repos, pageSize: 2 });
      for (let i = 0; i < 5; i++) expect(interrupted.backfillStep('AR')).toBe(false);
      const checkpoint = harness.repos.history.indexState('AR')!;
      expect(checkpoint.complete).toBe(false);
      const partial = count(harness);
      expect(partial).toBeGreaterThan(0);
      expect(partial).toBeLessThan(complete.length);
      // The process "restarts": a new indexer continues from the stored checkpoint, not from the start.
      const resumed = createHistoryIndexer({ repos: harness.repos, pageSize: 2 });
      expect(resumed.needsBackfill('AR')).toBe(true);
      while (!resumed.backfillStep('AR'));
      expect(snapshotOfIndex(harness)).toEqual(complete);
    });

    it('rolls a page back with its checkpoint when it fails, and finishes on the next try', async () => {
      const harness = await fixture();
      resetIndex(harness);
      let fail = false;
      const flaky = {
        ...harness.repos,
        history: {
          ...harness.repos.history,
          putIndexState: (state: Parameters<Repositories['history']['putIndexState']>[0]) => {
            if (fail) throw new Error('disk full');
            harness.repos.history.putIndexState(state);
          },
        },
      } as Repositories;
      const indexer = createHistoryIndexer({ repos: flaky, pageSize: 2 });
      expect(indexer.backfillStep('AR')).toBe(false);
      const stored = harness.repos.history.indexState('AR');
      const written = count(harness);
      fail = true;
      expect(() => indexer.backfillStep('AR')).toThrow('disk full');
      // Neither the page nor the checkpoint moved.
      expect(harness.repos.history.indexState('AR')).toEqual(stored);
      expect(count(harness)).toBe(written);
      fail = false;
      while (!indexer.backfillStep('AR'));
      expect(harness.repos.history.indexState('AR')?.complete).toBe(true);
      expect(titles(harness, 'task').length).toBe(7);
    });

    it('applies a change made in the middle of the backfill, before or after the checkpoint', async () => {
      const harness = await fixture();
      resetIndex(harness);
      const indexer = createHistoryIndexer({ repos: harness.repos, pageSize: 2 });
      expect(indexer.backfillStep('AR')).toBe(false);
      const { lastId } = harness.repos.history.indexState('AR')!;
      const ids = harness.repos.db.prepare('SELECT id, key FROM tasks ORDER BY id').all() as Array<{
        id: string;
        key: string;
      }>;
      const done = ids.filter((row) => row.id <= lastId!);
      const todo = ids.filter((row) => row.id > lastId!);
      expect(done.length).toBeGreaterThan(0);
      expect(todo.length).toBeGreaterThan(0);
      // One card behind the checkpoint and one ahead of it change; a new card appears.
      await harness.domain.tasks.update('AR', done[0]!.key, { title: 'Changed behind' }, OWNER_ACTOR);
      await harness.domain.tasks.update('AR', todo[0]!.key, { title: 'Changed ahead' }, OWNER_ACTOR);
      await harness.domain.tasks.create('AR', { title: 'Brand new card' }, OWNER_ACTOR);
      while (!indexer.backfillStep('AR'));
      indexer.drain();
      expect(titles(harness, 'task')).toEqual(
        expect.arrayContaining(['Changed behind', 'Changed ahead', 'Brand new card']),
      );
      expect(titles(harness, 'task')).toHaveLength(8);
      expect(harness.repos.history.dirtyCount()).toBe(0);
    });

    it('leaves a source that cannot be indexed in the queue and goes on with the others', async () => {
      const harness = await fixture();
      resetIndex(harness);
      const failing = {
        ...harness.repos,
        tasks: { ...harness.repos.tasks, get: harness.repos.tasks.get },
      } as Repositories;
      const errors: string[] = [];
      let broken = true;
      failing.timeline = {
        ...harness.repos.timeline,
        get: (project: string, id: string) => {
          if (broken) throw new Error('unreadable event');
          return harness.repos.timeline.get(project, id);
        },
      } as Repositories['timeline'];
      const indexer = createHistoryIndexer({ repos: failing, onError: (row) => errors.push(row.entityId) });
      harness.repos.db.exec(
        "INSERT INTO history_dirty (project_key, source_type, entity_id) SELECT project_key, 'note', id FROM timeline_events WHERE type = 'task_note'",
      );
      expect(indexer.drain()).toBe(0);
      expect(errors.length).toBe(3);
      expect(harness.repos.history.dirtyCount()).toBe(3);
      broken = false;
      expect(indexer.drain()).toBe(3);
      expect(harness.repos.history.dirtyCount()).toBe(0);
      expect(titles(harness, 'note')).toHaveLength(3);
    });
  });

  describe('a database from before the index existed', () => {
    it('is migrated and read into the index at start, with every source and a label comment', async () => {
      h = await historyHarness({ persistent: true });
      const card = await h.domain.tasks.create(
        'AR',
        { title: 'Heirloom card', description: 'old text' },
        OWNER_ACTOR,
      );
      await h.domain.tasks.addNote('AR', card.key, 'heirloom note', OWNER_ACTOR);
      await h.domain.tasks.update(
        'AR',
        card.key,
        { addLabels: ['needs-plan'], note: 'heirloom label comment' },
        OWNER_ACTOR,
      );
      h.domain.messages.record({
        projectKey: 'AR',
        from: 'dev-1',
        to: ['cr'],
        taskKey: card.key,
        body: 'heirloom message',
        actor: OWNER_ACTOR,
        delivered: true,
      });
      const item = h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source: 'dev-1',
        assignees: ['owner'],
        taskKey: card.key,
        title: 'heirloom question',
        payload: { question: 'heirloom question' },
        options: [{ id: 'yes', label: 'Yes', style: 'primary' }],
      });
      await h.domain.inbox.resolve('AR', item.id, { optionId: 'yes' }, OWNER);
      const directory = h.dir;
      await h.domain.stop();
      h.repos.db.close();

      // Take the database back before the index and later detector bookkeeping, at version 83.
      const old = new Database(join(directory, 'db.sqlite'));
      for (const row of old
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'history\\_%' ESCAPE '\\'",
        )
        .all() as Array<{ name: string }>)
        old.exec(`DROP TRIGGER ${row.name}`);
      for (const table of [
        'history_semantic_chunks',
        'history_semantic_sources',
        'history_semantic_dirty',
        'history_semantic_state',
        'history_fts',
        'history_documents',
        'history_dirty',
        'history_index_state',
        'history_doc_state',
        'history_searches',
        'operator_signal_arms',
        'obligations',
        'operator_grants',
        'merge_check_run_tasks',
        'merge_check_runs',
        'web_push_devices',
        'web_push_settings',
        'web_push_items',
        'member_queue_items',
        'email_contacts',
        'email_contact_events',
        'email_messages',
      ])
        old.exec(`DROP TABLE ${table}`);
      // Migration 99 (PM-925) dropped the pending recipients table, which version 83 still has and 84 to 98 read.
      old.exec(`CREATE TABLE team_message_pending (
        message_id TEXT NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
        project_key TEXT NOT NULL,
        handle TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (message_id, handle)
      )`);
      // The hot read indexes (migration 91) do not exist at version 83 either; migrating recreates them.
      for (const index of [
        'inbox_open',
        'task_merges_task',
        'task_loops_task_key',
        'timeline_project_type',
        'sessions_state',
      ])
        old.exec(`DROP INDEX ${index}`);
      // Migration 96 (PM-888) added a column; migrating adds it again.
      old.exec('ALTER TABLE operator_steps DROP COLUMN operation_id');
      // Migration 101 (PM-479) added a column and three tables; migrating creates them again.
      old.exec('ALTER TABLE operator_steps DROP COLUMN system_feedback');
      for (const table of [
        'system_feedback_forwarding',
        'system_feedback_occurrences',
        'system_feedback_items',
      ])
        old.exec(`DROP TABLE ${table}`);
      // Migration 103 (PM-909) added two columns; migrating adds them again.
      old.exec('ALTER TABLE full_test_runs DROP COLUMN runner');
      old.exec('ALTER TABLE full_test_runs DROP COLUMN external_url');
      old.pragma('user_version = 83');
      expect(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'history%'").get()).toEqual(
        { n: 0 },
      );
      expect(schemaVersion(old)).toBe(83);
      old.close();

      h = await createDomainHarness({ directory });
      expect(schemaVersion(h.repos.db)).toBe(LATEST_SCHEMA_VERSION);
      expect(migrate(h.repos.db)).toBe(LATEST_SCHEMA_VERSION);
      expect(h.repos.history.indexState('AR')).toMatchObject({
        complete: true,
        version: HISTORY_INDEX_VERSION,
      });
      const find = async (query: string) =>
        (await h!.domain.history.search('AR', OWNER, { query })).matches.map((hit) => hit.sourceType);
      expect(await find('heirloom')).toEqual(expect.arrayContaining(['task', 'note', 'message', 'question']));
      // The label comment is a note of the card like any other.
      expect(
        (await h.domain.history.search('AR', OWNER, { query: 'heirloom label comment' })).matches.map(
          (hit) => hit.sourceType,
        ),
      ).toContain('note');
      expect((await find('heirloom')).filter((type) => type === 'note')).toHaveLength(2);
      expect(h.repos.history.dirtyCount()).toBe(0);
      expect(as('owner').handle).toBe('owner');
    });
  });

  it('declares every history table to the change journal as local state', () => {
    // The journal test accounts for every table; this keeps the intent next to the index.
    const db = new Database(':memory:');
    migrate(db);
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'history%'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'history_documents',
        'history_dirty',
        'history_index_state',
        'history_doc_state',
        'history_fts',
      ]),
    );
    db.close();
  });

  it('uses the full-text index for the scan, not a table scan', async () => {
    h = await historyHarness();
    const plan = h.repos.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT d.* FROM history_fts CROSS JOIN history_documents d ON d.id = history_fts.rowid
         WHERE history_fts MATCH ? AND d.project_key = ? AND d.source_type IN ('task')
         ORDER BY bm25(history_fts, 5.0, 1.0), d.at DESC, d.source_id`,
      )
      .all('"alpha"*', 'AR') as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join('\n');
    expect(details).toMatch(/VIRTUAL TABLE INDEX .*history_fts|SCAN history_fts/);
    expect(details).not.toMatch(/SCAN d\b|SCAN history_documents/);
  });

  it('keeps a service of its own working over the same database', async () => {
    h = await historyHarness();
    await h.domain.tasks.create('AR', { title: 'Shared database card' }, OWNER_ACTOR);
    const { service } = await ownService(h);
    await service.init();
    expect((await service.search('AR', OWNER, { query: 'shared' })).matches).toHaveLength(1);
    await service.stop();
  });
});
