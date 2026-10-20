import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistorySemanticFailure } from '../contracts';
import type { Db } from '../db';
import { openDatabase } from '../db';
import type { Embedder } from './embedder';
import { loadVectorExtension } from './embedder';
import { createSemanticEngine } from './engine';
import { EMBEDDING_DIMENSION } from './model';

/** A topic word picks an axis: texts about the same topic are identical vectors, other topics are orthogonal. */
const TOPICS = ['alpaca', 'zebra', 'quokka'];
const unit = (axis: number) => {
  const vector = new Float32Array(EMBEDDING_DIMENSION);
  vector[axis] = 1;
  return vector;
};
const topicVector = (text: string) => {
  const index = TOPICS.findIndex((topic) => text.toLowerCase().includes(topic));
  return unit(index < 0 ? TOPICS.length : index);
};

interface FakeEmbedder extends Embedder {
  passages: string[];
  failNext: number;
  beforeEmbed?: () => void;
}

function fakeEmbedder(): FakeEmbedder {
  const embedder: FakeEmbedder = {
    passages: [],
    failNext: 0,
    countTokens: (text) => Math.ceil(text.length / 4) + 2,
    async embedPassage(text) {
      embedder.passages.push(text);
      embedder.beforeEmbed?.();
      if (embedder.failNext > 0) {
        embedder.failNext--;
        throw new Error('the model failed');
      }
      return topicVector(text);
    },
    async embedQuery(text) {
      return topicVector(text);
    },
  };
  return embedder;
}

const INDEX_KEY = 'test-model|rev|q8|d384|c256o32|p1';

describe('semantic engine', () => {
  let db: Db;
  let embedder: FakeEmbedder;
  let clock: number;
  const warnings: string[] = [];

  const addSource = (id: string, title: string, body: string, at = '2026-10-01T09:00:00.000Z') =>
    db
      .prepare(
        `INSERT INTO history_documents (source_id, project_key, source_type, entity_id, task_key, author, at, title, body)
         VALUES (?, 'AR', 'note', ?, NULL, 'owner', ?, ?, ?)`,
      )
      .run(id, id, at, title, body);
  const engineOf = (indexKey = INDEX_KEY, minCosine = 0.8) =>
    createSemanticEngine({
      db,
      embedder,
      indexKey,
      minCosine,
      now: () => new Date(clock),
      warn: (message) => warnings.push(message),
    });
  const scanFor = (engine: ReturnType<typeof engineOf>, topic: string, extra: object = {}) =>
    engine.scan({
      projectKey: 'AR',
      indexKey: INDEX_KEY,
      vector: topicVector(topic),
      sourceTypes: ['note'],
      limit: 20,
      deadlineAt: Number.MAX_SAFE_INTEGER,
      ...extra,
    });

  beforeEach(async () => {
    db = openDatabase(':memory:');
    await loadVectorExtension(db);
    db.exec(`INSERT INTO projects VALUES ('AR', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01')`);
    embedder = fakeEmbedder();
    clock = Date.parse('2026-10-01T10:00:00.000Z');
    warnings.length = 0;
  });
  afterEach(() => db.close());

  it('refuses a question until the project back-fill is complete, then finds the sources of the same topic', async () => {
    addSource('note:1', 'Alpaca farm', 'We keep an alpaca herd.');
    addSource('note:2', 'Zebra stripes', 'Zebra stripes are black and white.');
    const engine = engineOf();

    await expect(engine.embedQuery('AR', 'alpaca')).rejects.toMatchObject({ status: 'backfill' });
    await engine.drain();
    expect(engine.counts()).toMatchObject({ sources: 2, dirty: 0 });

    const vector = await engine.embedQuery('AR', 'alpaca');
    const { candidates, next } = scanFor(engine, 'alpaca', { vector });
    expect(candidates.map((c) => c.sourceId)).toEqual(['note:1']);
    expect(candidates[0]).toMatchObject({ indexKey: INDEX_KEY, chunkNo: 0, fromLine: 1, distance: 0 });
    expect(next).toBeNull();
  });

  it('re-indexes a changed source and forgets the old text', async () => {
    addSource('note:1', 'Farm', 'We keep an alpaca herd.');
    const engine = engineOf();
    await engine.drain();
    expect(scanFor(engine, 'alpaca').candidates).toHaveLength(1);

    db.prepare(
      `UPDATE history_documents SET body = 'Now it is a zebra herd.' WHERE source_id = 'note:1'`,
    ).run();
    expect(engine.counts().dirty).toBe(1);
    await engine.drain();

    expect(scanFor(engine, 'alpaca').candidates).toEqual([]);
    expect(scanFor(engine, 'zebra').candidates.map((c) => c.sourceId)).toEqual(['note:1']);
  });

  it('drops the vectors of a deleted source', async () => {
    addSource('note:1', 'Alpaca farm', 'We keep an alpaca herd.');
    const engine = engineOf();
    await engine.drain();
    db.prepare(`DELETE FROM history_documents WHERE source_id = 'note:1'`).run();
    await engine.drain();
    expect(engine.counts()).toMatchObject({ sources: 0, chunks: 0, dirty: 0 });
  });

  it('cuts a long source into chunks that know their lines, and reports the best chunk', async () => {
    const filler = Array.from({ length: 120 }, (_, i) => `line ${i} about nothing in particular`).join('\n');
    addSource('note:1', 'Long note', `${filler}\nThe quokka sits here.\n${filler}`);
    const engine = engineOf();
    await engine.drain();
    expect(engine.counts().chunks).toBeGreaterThan(2);

    const [hit] = scanFor(engine, 'quokka').candidates;
    expect(hit).toBeDefined();
    expect(hit!.fromLine).toBeLessThanOrEqual(122);
    expect(hit!.toLine).toBeGreaterThanOrEqual(122);
  });

  it('pages the candidates by distance and narrows them to the given sources', async () => {
    for (const id of ['note:1', 'note:2', 'note:3'])
      addSource(id, `Alpaca ${id}`, 'alpaca', `2026-10-01T09:0${id.slice(-1)}:00.000Z`);
    const engine = engineOf();
    await engine.drain();

    const first = scanFor(engine, 'alpaca', { limit: 2 });
    expect(first.candidates).toHaveLength(2);
    expect(first.next).not.toBeNull();
    const second = scanFor(engine, 'alpaca', { limit: 2, after: first.next });
    expect([...first.candidates, ...second.candidates].map((c) => c.sourceId).sort()).toEqual([
      'note:1',
      'note:2',
      'note:3',
    ]);
    expect(scanFor(engine, 'alpaca', { sourceIds: ['note:2'] }).candidates.map((c) => c.sourceId)).toEqual([
      'note:2',
    ]);
  });

  it('does not match a vector of another generation', async () => {
    addSource('note:1', 'Alpaca farm', 'alpaca');
    const engine = engineOf();
    await engine.drain();
    expect(scanFor(engine, 'alpaca', { indexKey: 'another-generation' }).candidates).toEqual([]);
  });

  it('retries a failed source later with a backoff and warns', async () => {
    addSource('note:1', 'Alpaca farm', 'alpaca');
    const engine = engineOf();
    embedder.failNext = 1;
    await engine.drain();
    expect(warnings).toHaveLength(1);
    expect(engine.counts().dirty).toBe(1);

    clock += 60_000;
    await engine.drain();
    expect(engine.counts()).toMatchObject({ sources: 1, dirty: 0 });
  });

  it('retries a source that changed while it was embedded and keeps nothing of the old text', async () => {
    addSource('note:1', 'Farm', 'alpaca');
    const engine = engineOf();
    let changed = false;
    embedder.beforeEmbed = () => {
      if (changed) return;
      changed = true;
      db.prepare(`UPDATE history_documents SET body = 'zebra' WHERE source_id = 'note:1'`).run();
    };
    await engine.drain();
    expect(scanFor(engine, 'alpaca').candidates).toEqual([]);

    clock += 5_000;
    await engine.drain();
    expect(scanFor(engine, 'zebra').candidates.map((c) => c.sourceId)).toEqual(['note:1']);
  });

  it('builds a new generation and drops the older one once the project is complete', async () => {
    addSource('note:1', 'Alpaca farm', 'alpaca');
    const old = engineOf('old-generation');
    await old.drain();
    const engine = engineOf();
    await engine.drain();
    expect(scanFor(engine, 'alpaca', { indexKey: 'old-generation' }).candidates).toEqual([]);
    expect(db.prepare('SELECT DISTINCT index_key AS k FROM history_semantic_sources').all()).toEqual([
      { k: INDEX_KEY },
    ]);
  });

  it('is a failure the caller can read when the question is not ready', async () => {
    const engine = engineOf();
    const error = await engine.embedQuery('AR', 'alpaca').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HistorySemanticFailure);
  });
});
