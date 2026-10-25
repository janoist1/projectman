import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistorySemanticStatus, HistorySourceType, HistoryViewer } from '@projectman/shared';
import { HistorySemanticFailure } from '../src/contracts';
import type {
  HistoryQueryEmbedding,
  HistorySemanticCandidate,
  HistorySemanticPort,
  HistoryVectorPage,
  HistoryVectorScan,
} from '../src/contracts';
import { historyContentHash, historyFullText } from '../src/db';
import type { DomainHarness } from './helpers/domain-harness';
import { as, historyHarness, OWNER_ACTOR } from './helpers/history';

const OWNER: HistoryViewer = { handle: 'owner', access: 'owner' };
const INDEX_KEY = 'fake-model|rev|q8|d384|c256o32|p1';

interface Row {
  source_id: string;
  source_type: string;
  task_key: string | null;
  at: string;
  title: string;
  body: string;
  commit_sha: string | null;
}

/**
 * A port whose "meaning" is a word: every source that contains `target` is a candidate, nearest (earliest in the
 * list) first. It reads the index's own documents, so its content hashes are the real ones.
 */
function fakePort(h: DomainHarness) {
  const port = {
    target: 'automobile',
    embedding: {
      status: 'used',
      indexKey: INDEX_KEY,
      vector: new Float32Array(384),
    } as HistoryQueryEmbedding,
    scanFailure: null as HistorySemanticFailure | Error | null,
    beforeScan: undefined as undefined | (() => void),
    scans: [] as HistoryVectorScan[],
    start() {},
    async stop() {},
    async embedQuery(): Promise<HistoryQueryEmbedding> {
      return port.embedding;
    },
    async scan(input: HistoryVectorScan): Promise<HistoryVectorPage> {
      port.scans.push(input);
      port.beforeScan?.();
      if (port.scanFailure) throw port.scanFailure;
      const rows = h.repos.db
        .prepare(
          `SELECT source_id, source_type, task_key, at, title, body, commit_sha FROM history_documents
           WHERE project_key = ? ORDER BY at, source_id`,
        )
        .all(input.projectKey) as Row[];
      const all = rows
        .filter((row) => input.sourceTypes.includes(row.source_type as never))
        .filter((row) => (input.sourceIds ? input.sourceIds.includes(row.source_id) : true))
        .filter((row) => historyFullText(row.title, row.body).toLowerCase().includes(port.target))
        .map((row, index): HistorySemanticCandidate => {
          const text = historyFullText(row.title, row.body);
          const startChar = text.toLowerCase().indexOf(port.target);
          return {
            sourceId: row.source_id,
            indexKey: INDEX_KEY,
            contentHash: historyContentHash(row.title, row.body, row.commit_sha),
            chunkNo: 0,
            startChar,
            endChar: Math.min(text.length, startChar + 80),
            fromLine: 1,
            toLine: 1,
            distance: 0.05 + index * 0.01,
            at: row.at,
          };
        });
      const from = input.after ? all.findIndex((c) => c.sourceId === input.after!.sourceId) + 1 : 0;
      const candidates = all.slice(from, from + input.limit);
      const last = candidates[candidates.length - 1];
      return {
        candidates,
        next:
          last && from + input.limit < all.length
            ? { distance: last.distance, at: last.at, sourceId: last.sourceId }
            : null,
      };
    },
  } satisfies HistorySemanticPort & Record<string, unknown>;
  return port;
}

describe('history search by meaning', () => {
  let h: DomainHarness;
  let port: ReturnType<typeof fakePort>;

  const task = async (
    title: string,
    description = '',
    extra: { visibility?: 'shared' | 'internal' } = {},
  ) => {
    const created = await h.domain.tasks.create('AR', { title, description, ...extra }, OWNER_ACTOR);
    h.domain.history.flush();
    return created;
  };
  const search = (
    input: { query: string; limit?: number; taskKey?: string; sourceTypes?: HistorySourceType[] },
    viewer = OWNER,
  ) => h.domain.history.search('AR', viewer, input);
  const loggedStatuses = () =>
    (
      h.repos.db.prepare('SELECT semantic_status AS status FROM history_searches ORDER BY id').all() as {
        status: HistorySemanticStatus;
      }[]
    ).map((row) => row.status);

  beforeEach(async () => {
    h = await historyHarness({
      historySemantic: {
        start() {},
        stop: async () => {},
        embedQuery: () => port.embedQuery(),
        scan: (input) => port.scan(input),
      },
    });
    port = fakePort(h);
  });
  afterEach(() => h.cleanup());

  it('adds a source that says the same in other words, after the word hits, marked as found by meaning', async () => {
    await task('Vehicle policy', 'Nothing about cars here');
    const meaning = await task('Fleet note', 'Every automobile must be insured.');
    const result = await search({ query: 'vehicle' });
    expect(result.matches.map((m) => [m.taskKey, m.matchType])).toEqual([
      ['AR-1', 'text'],
      [meaning.key, 'semantic'],
    ]);
    expect(result.matches[1]!.excerpt).toContain('automobile');
    // Found by meaning only, it opens at the chunk's line, not at the card as a whole.
    expect(result.matches[1]!.reference).toMatchObject({
      tool: 'read_history_source',
      arguments: { from_line: 1 },
    });
    expect(result.hasMore).toBe(false);
  });

  it('opens a document found by meaning at the chunk line of its commit', async () => {
    const commit = 'a'.repeat(40);
    h.domain.history.replaceDocuments({
      projectKey: 'AR',
      repo: 'web',
      commit,
      checkedAt: '2026-10-10T10:00:00Z',
      files: [
        { path: 'docs/DECISIONS.md', text: '# Decisions\n\nfirst\nEvery automobile is insured.\nlast' },
        { path: 'docs/LESSONS.md', text: '# Lessons' },
      ],
    });
    port.target = 'automobile';
    const result = await search({ query: 'vehicle', sourceTypes: ['document'] });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      matchType: 'semantic',
      document: { path: 'docs/DECISIONS.md', commit, line: 1 },
      reference: {
        tool: 'read_history_source',
        arguments: { source_id: result.matches[0]!.sourceId, from_line: 1, commit },
      },
    });
  });

  it('marks a word hit that is also close in meaning as both', async () => {
    await task('Automobile policy', 'The automobile rules');
    const result = await search({ query: 'automobile' });
    expect(result.matches.map((m) => m.matchType)).toEqual(['both']);
  });

  it('answers by the words only, with the reason in the private log, when the meaning is not available', async () => {
    await task('Fleet note', 'Every automobile must be insured.');
    const statuses = ['loading', 'backfill', 'busy', 'timeout', 'disabled'] as const;
    for (const status of statuses) {
      port.embedding = { status };
      expect((await search({ query: 'vehicle' })).matches).toEqual([]);
    }
    port.embedding = { status: 'used', indexKey: INDEX_KEY, vector: new Float32Array(384) };
    port.scanFailure = new HistorySemanticFailure('resource_limit');
    expect((await search({ query: 'vehicle' })).matches).toEqual([]);
    port.scanFailure = new Error('boom');
    expect((await search({ query: 'vehicle' })).matches).toEqual([]);
    expect(loggedStatuses().sort()).toEqual([...statuses, 'resource_limit', 'error'].sort());
  });

  it('logs the search once, not run when there is no port', async () => {
    const plain = await historyHarness();
    try {
      await plain.domain.tasks.create('AR', { title: 'Fleet note' }, OWNER_ACTOR);
      plain.domain.history.flush();
      await plain.domain.history.search('AR', OWNER, { query: 'fleet' });
      const rows = plain.repos.db.prepare('SELECT semantic_status AS s FROM history_searches').all();
      expect(rows).toEqual([{ s: 'not_run' }]);
    } finally {
      await plain.cleanup();
    }
  });

  it('logs one row per search with the status of the meaning part', async () => {
    await task('Fleet note', 'Every automobile must be insured.');
    await search({ query: 'vehicle' });
    expect(loggedStatuses()).toEqual(['used']);
  });

  it('keeps to the limit and says there is more', async () => {
    await task('Note one', 'automobile one');
    await task('Note two', 'automobile two');
    await task('Note three', 'automobile three');
    const result = await search({ query: 'vehicle', limit: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.hasMore).toBe(true);
  });

  it('finds the same sources for a client as for the owner (PM-79)', async () => {
    await task('Internal one', 'automobile secret', { visibility: 'internal' });
    await task('Shared one', 'automobile public');
    const client = await search({ query: 'vehicle' }, as('acme'));
    expect(client.matches).toHaveLength(2);
    const owner = await search({ query: 'vehicle' });
    expect(owner.matches).toHaveLength(2);
  });

  it('narrows the candidates to the card and drops those outside the time bounds', async () => {
    const first = await task('Note one', 'automobile one');
    await task('Note two', 'automobile two');
    const byCard = await search({ query: 'vehicle', taskKey: first.key });
    expect(byCard.matches.map((m) => m.taskKey)).toEqual([first.key]);
    const future = await h.domain.history.search('AR', OWNER, {
      query: 'vehicle',
      since: '2999-01-01T00:00:00Z',
    });
    expect(future.matches).toEqual([]);
  });

  it('drops a candidate whose text changed while the search waited', async () => {
    const note = await task('Fleet note', 'Every automobile must be insured.');
    port.beforeScan = () => {
      h.repos.db
        .prepare(`UPDATE history_documents SET body = 'nothing here now' WHERE task_key = ?`)
        .run(note.key);
    };
    expect((await search({ query: 'vehicle' })).matches).toEqual([]);
  });

  it('drops a candidate of another model generation', async () => {
    await task('Fleet note', 'Every automobile must be insured.');
    port.embedding = { status: 'used', indexKey: 'another-generation', vector: new Float32Array(384) };
    expect((await search({ query: 'vehicle' })).matches).toEqual([]);
  });
});
