import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HistoryViewer } from '@projectman/shared';
import type { DomainHarness } from './helpers/domain-harness';
import { as, historyHarness, OWNER_ACTOR } from './helpers/history';
import { createHistoryService } from '../src/services/history';
import { createHistoryIndexer } from '../src/services/history/indexer';

/**
 * A synthetic data-size check of the history index: roughly ten times a long-lived project. It is a measurement,
 * not a regression test, so it runs only when HISTORY_TIMING is set (HISTORY_TIMING=1 npx vitest run ...).
 */
const ENABLED = Boolean(process.env.HISTORY_TIMING);
const SIZE = { tasks: 8000, notes: 40000, messages: 20000, questions: 4000 };

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

describe.skipIf(!ENABLED)('history index at ten times the data', () => {
  let h: DomainHarness;

  /** Copies the seed row `copies` times; `overrides` replace the named columns with SQL over `n`. */
  function clone(table: string, seedWhere: string, copies: number, overrides: Record<string, string>) {
    const columns = (h.repos.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name)
      .filter((name) => !(name === 'seq' && table !== 'tasks'));
    const select = columns.map((name) => overrides[name] ?? `seed.${name}`);
    h.repos.db
      .prepare(
        `WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM counter WHERE n < ${copies})
         INSERT INTO ${table} (${columns.join(', ')})
         SELECT ${select.join(', ')} FROM (SELECT * FROM ${table} WHERE ${seedWhere} LIMIT 1) AS seed, counter`,
      )
      .run();
  }

  beforeAll(async () => {
    h = await historyHarness();
    const seed = await h.domain.tasks.create(
      'AR',
      { title: 'seedtask common', description: 'seedtask body' },
      OWNER_ACTOR,
    );
    await h.domain.tasks.addNote('AR', seed.key, 'seednote common', OWNER_ACTOR);
    h.domain.messages.record({
      projectKey: 'AR',
      from: 'dev-1',
      to: ['cr'],
      taskKey: seed.key,
      body: 'seedmessage common',
      actor: OWNER_ACTOR,
      delivered: true,
    });
    const item = h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
      assignees: ['owner'],
      taskKey: seed.key,
      title: 'seedquestion common',
      payload: { question: 'seedquestion common' },
      options: [{ id: 'yes', label: 'Yes', style: 'primary' }],
    });
    await h.domain.inbox.resolve('AR', item.id, { optionId: 'yes' }, { handle: 'owner', access: 'owner' });
    await h.domain.history.stop();

    const topic = (n: string) => `'topic' || (${n} % 500) || ' kind' || (${n} % 7)`;
    clone('tasks', "key = 'AR-1'", SIZE.tasks, {
      id: "seed.id || '-' || n",
      key: "'AR-' || (1000 + n)",
      seq: '1000 + n',
      title: `'Card ' || n || ' ' || ${topic('n')}`,
      description: `'description of card ' || n || ' ' || ${topic('n + 3')}`,
    });
    clone('timeline_events', "type = 'task_note'", SIZE.notes, {
      id: "seed.id || '-' || n",
      data: `replace(seed.data, 'seednote', 'note ' || n || ' ' || ${topic('n')})`,
    });
    clone('team_messages', "body LIKE 'seedmessage%'", SIZE.messages, {
      id: "seed.id || '-' || n",
      body: `'message ' || n || ' ' || ${topic('n')}`,
    });
    clone('inbox_items', "title LIKE 'seedquestion%'", SIZE.questions, {
      id: "seed.id || '-' || n",
      title: `'question ' || n || ' ' || ${topic('n')}`,
      payload: `replace(seed.payload, 'seedquestion', 'question ' || n || ' ' || ${topic('n')})`,
    });
    h.repos.db.exec(
      'DELETE FROM history_documents; DELETE FROM history_dirty; DELETE FROM history_index_state;',
    );
  }, 600_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  it('backfills and searches in good time', async () => {
    const indexer = createHistoryIndexer({ repos: h.repos });
    const started = performance.now();
    let steps = 0;
    while (!indexer.backfillStep('AR')) steps++;
    const backfillMs = performance.now() - started;
    const documents = h.repos.history.documentCount('AR');

    // The harness's own service is stopped; the search runs on a service of its own.
    const config = await h.domain.projects.config('AR');
    const service = createHistoryService({
      repos: h.repos,
      config: () => config,
      logger: h.log.logger,
      now: () => new Date(),
    });
    await service.init();
    const time = (viewer: HistoryViewer, query: string, rounds = 15) => {
      const times: number[] = [];
      let found = 0;
      for (let i = 0; i < rounds; i++) {
        const begin = performance.now();
        found = service.search('AR', viewer, { query, limit: 20 }).matches.length;
        times.push(performance.now() - begin);
      }
      return { median: Math.round(median(times)), max: Math.round(Math.max(...times)), found };
    };
    const owner: HistoryViewer = { handle: 'owner', access: 'owner' };
    const report = {
      documents,
      backfillMs: Math.round(backfillMs),
      backfillSteps: steps,
      selectiveOwner: time(owner, 'topic42'),
      selectiveClient: time(as('acme'), 'topic42'),
      commonOwner: time(owner, 'common'),
      commonClient: time(as('acme'), 'common'),
      prefixDeveloper: time(as('dev'), 'topi kind3'),
      twoWords: time(owner, 'card topic7'),
    };
    console.info(`HISTORY TIMING ${JSON.stringify(report)}`);
    await service.stop();
    expect(documents).toBeGreaterThan(SIZE.tasks + SIZE.notes);
  }, 600_000);
});
