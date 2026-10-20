import dns from 'node:dns';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db';
import type { Db } from '../src/db';
import { createHistoryRepository } from '../src/db/history';
import { createEmbedder, loadVectorExtension } from '../src/history-semantic/embedder';
import type { Embedder } from '../src/history-semantic/embedder';
import { createSemanticEngine } from '../src/history-semantic/engine';
import type { SemanticEngine } from '../src/history-semantic/engine';
import { DEFAULT_MIN_COSINE } from '../src/history-semantic/index';
import { historyIndexKey, readModelManifest } from '../src/history-semantic/model';
import { translateQuery } from '../src/services/history/query';

const MODEL_DIRECTORY = fileURLToPath(new URL('../models/history', import.meta.url));
const modelPrepared = existsSync(`${MODEL_DIRECTORY}/manifest.json`);

/** The project's own long documents are the real history this set is made from (the repository is public). */
const doc = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url)), 'utf8');

interface Source {
  id: string;
  title: string;
  body: string;
}

function split(text: string, prefix: string, boundary: RegExp): Source[] {
  return text
    .split(boundary)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part, index) => {
      const [title = '', ...rest] = part.split('\n');
      return { id: `${prefix}:${index}`, title: title.slice(0, 200), body: rest.join('\n') };
    });
}

const decisions = () =>
  doc('DECISIONS.md')
    .split(/^(?=\d+\. \*\*)/m)
    .filter((part) => /^\d+\. \*\*/.test(part))
    .map((part): Source => {
      const number = /^(\d+)\./.exec(part)![1]!;
      const [title = '', ...rest] = part.trim().split('\n');
      return { id: `decision:${number}`, title: title.slice(0, 200), body: rest.join('\n') };
    });

/** A question that says what the decision says in other words, and the decision that answers it. */
const QUESTIONS: { question: string; target: string }[] = [
  { question: 'Is it allowed to pay per request for the AI model usage?', target: 'decision:1' },
  { question: 'Miért nem GitHub Projectsben vezetjük a feladatokat?', target: 'decision:9' },
  { question: 'Milyen nyelven írjuk a kódot, és milyen nyelvű a felület?', target: 'decision:10' },
  { question: "Does merging a change restart the owner's running instance?", target: 'decision:20' },
  { question: 'Is there an upper limit on how many AI sessions run simultaneously?', target: 'decision:23' },
  { question: 'Ki jelölhet duplikátumnak egy még el nem kezdett kártyát?', target: 'decision:29' },
  { question: 'What happens to a heavy command when the queue is unusable?', target: 'decision:33' },
  { question: 'Hogyan nevezzük el a kiadások címkéit a verziókezelőben?', target: 'decision:35' },
  { question: 'Is the virtual machine approach still being pursued?', target: 'decision:36' },
  {
    question: 'Were old commits of the public repository altered to hide a customer?',
    target: 'decision:39',
  },
  { question: 'Hányszor fut le a teljes tesztcsomag egy kártya életében?', target: 'decision:40' },
  { question: 'Can one member be cut off from the internet individually?', target: 'decision:41' },
  { question: 'Mennyi ideje van a korábbi felelősnek átadási jegyzetet írni?', target: 'decision:43' },
  { question: 'Does the system itself integrate finished work into the main branch?', target: 'decision:47' },
  { question: 'Kinek megy egy üzenet, ha a kártyán senki sincs?', target: 'decision:49' },
  { question: 'Where is the board hosted and behind what access layer?', target: 'decision:51' },
  { question: 'Miért Operátornak hívják kifelé az integrátort?', target: 'decision:52' },
  { question: 'What should the application never do by itself, like writing code?', target: 'decision:48' },
  { question: 'Who is woken when an AI posts a card message?', target: 'decision:44' },
  { question: 'Hogyan kapcsolódik a NanoGPT, és melyik titokhoz fér hozzá?', target: 'decision:34' },
];

/** Questions about nothing the history holds: none of them should bring a hit. */
const OFF_TOPIC = [
  'How long should sourdough bread rise before baking?',
  'Mi a legjobb módszer a balatoni horgászatra?',
  'What is the capital of Australia?',
  'Recommend a good movie about space travel',
  'Hány fok van ma Budapesten?',
];

const PROJECT = 'AR';
const BULK_CHUNKS = 50_000;

describe.skipIf(!modelPrepared)(
  'search by meaning on the real documents (needs `npm run prepare:history-model`)',
  () => {
    let directory: string;
    let db: Db;
    let embedder: Embedder;
    let engine: SemanticEngine;
    let sourceCount = 0;
    let indexSeconds = 0;

    const semanticRanking = async (question: string) => {
      const vector = await engine.embedQuery(PROJECT, question);
      const { candidates } = engine.scan({
        projectKey: PROJECT,
        indexKey: INDEX_KEY(),
        vector,
        sourceTypes: ['note'],
        limit: 100,
        deadlineAt: Number.MAX_SAFE_INTEGER,
      });
      return candidates.map((candidate) => candidate.sourceId);
    };
    let indexKey = '';
    const INDEX_KEY = () => indexKey;

    // Any way out of the process is recorded and refused from here on: the model, the index and the searches
    // below must work without it (PM-767 K5, AC8).
    const networkAttempts: string[] = [];
    const refuse = (what: string) => {
      networkAttempts.push(what);
      throw new Error('the network is not available in this test');
    };

    beforeAll(async () => {
      vi.stubGlobal('fetch', (input: unknown) => refuse(`fetch ${String(input)}`));
      vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => refuse('socket connect'));
      vi.spyOn(dns, 'lookup').mockImplementation(() => refuse('dns lookup'));
      // The traps work: each way out is refused and recorded.
      expect(() => fetch('http://example.invalid/')).toThrow();
      expect(() => new net.Socket().connect(80, 'example.invalid')).toThrow();
      expect(() => dns.lookup('example.invalid', () => undefined)).toThrow();
      expect(networkAttempts).toHaveLength(3);
      networkAttempts.length = 0;
      directory = mkdtempSync(join(tmpdir(), 'pm-history-recall-'));
      db = openDatabase(join(directory, 'db.sqlite'));
      await loadVectorExtension(db);
      db.exec(
        `INSERT INTO projects VALUES ('${PROJECT}', 'Example', NULL, 'v1', '2026-01-01', '2026-01-01')`,
      );
      const sources = [
        ...decisions(),
        ...split(doc('LESSONS.md'), 'lesson', /^(?=## )/m),
        ...split(doc('ROADMAP.md'), 'roadmap', /^(?=## )/m),
        ...split(doc('ARCHITECTURE.md'), 'architecture', /^(?=## )/m),
      ];
      sourceCount = sources.length;
      const insert = db.prepare(
        `INSERT INTO history_documents (source_id, project_key, source_type, entity_id, task_key, author, at, title, body)
         VALUES (?, ?, 'note', ?, NULL, 'owner', '2026-10-01T09:00:00.000Z', ?, ?)`,
      );
      for (const source of sources) insert.run(source.id, PROJECT, source.id, source.title, source.body);
      const manifest = readModelManifest(MODEL_DIRECTORY);
      indexKey = historyIndexKey(manifest);
      embedder = await createEmbedder(MODEL_DIRECTORY, manifest);
      engine = createSemanticEngine({ db, embedder, indexKey, minCosine: DEFAULT_MIN_COSINE });
      const startedAt = performance.now();
      await engine.drain();
      indexSeconds = (performance.now() - startedAt) / 1000;
    }, 900_000);

    afterAll(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      db?.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    it('finds the source of at least 15 of 20 reworded questions in the first 10, where the words do not', async () => {
      const history = createHistoryRepository(db);
      const wordsRank = (question: string, target: string): number | null => {
        const rows = history.scan({
          match: translateQuery(question).match,
          projectKey: PROJECT,
          sourceTypes: ['note'],
        });
        try {
          let rank = 0;
          for (const row of rows) {
            rank++;
            if (row.sourceId === target) return rank;
          }
          return null;
        } finally {
          rows.return?.();
        }
      };

      let found = 0;
      const lines: string[] = [];
      for (const { question, target } of QUESTIONS) {
        // The set holds only questions the words search does not bring in the first 10.
        const byWords = wordsRank(question, target);
        expect(byWords === null || byWords > 10, `the words search finds "${question}"`).toBe(true);
        const ranking = await semanticRanking(question);
        const rank = ranking.indexOf(target) + 1;
        if (rank > 0 && rank <= 10) found++;
        lines.push(`${rank > 0 ? rank : '-'}\t${target}\t${question}`);
      }
      console.log(
        `PM-767 recall: ${found}/${QUESTIONS.length} in the first 10 (threshold ${DEFAULT_MIN_COSINE}; ${sourceCount} sources, ${engine.counts().chunks} chunks, indexed in ${indexSeconds.toFixed(0)} s)\n${lines.join('\n')}`,
      );
      expect(found).toBeGreaterThanOrEqual(15);
    });

    it('reports recall and false hits at each threshold (calibration of the default)', async () => {
      const wide = createSemanticEngine({ db, embedder, indexKey, minCosine: 0.5 });
      const scoresOf = async (question: string) => {
        const vector = await wide.embedQuery(PROJECT, question);
        const { candidates } = wide.scan({
          projectKey: PROJECT,
          indexKey,
          vector,
          sourceTypes: ['note'],
          limit: 100,
          deadlineAt: Number.MAX_SAFE_INTEGER,
        });
        return candidates.map((candidate) => ({ id: candidate.sourceId, cosine: 1 - candidate.distance }));
      };
      const answers = await Promise.all(
        QUESTIONS.map(async (item) => ({ item, scores: await scoresOf(item.question) })),
      );
      const offTopic = await Promise.all(OFF_TOPIC.map((question) => scoresOf(question)));
      const rows: string[] = [];
      for (const threshold of [0.78, 0.8, 0.81, 0.82, 0.83, 0.84]) {
        const found = answers.filter(({ item, scores }) => {
          const above = scores.filter((score) => score.cosine >= threshold);
          const rank = above.findIndex((score) => score.id === item.target) + 1;
          return rank > 0 && rank <= 10;
        }).length;
        const falseHits = offTopic.filter((scores) =>
          scores.some((score) => score.cosine >= threshold),
        ).length;
        rows.push(
          `${threshold}\trecall ${found}/${QUESTIONS.length}\toff-topic with a hit ${falseHits}/${OFF_TOPIC.length}`,
        );
      }
      const targetScores = answers.map(
        ({ item, scores }) => scores.find((score) => score.id === item.target)?.cosine ?? 0,
      );
      const bestOff = Math.max(...offTopic.map((scores) => scores[0]?.cosine ?? 0));
      console.log(
        `PM-767 threshold sweep\n${rows.join('\n')}\ntarget cosines: ${targetScores.map((value) => value.toFixed(3)).join(' ')}\nbest off-topic cosine: ${bestOff.toFixed(3)}`,
      );
    });

    it('brings no hit for questions about something else', async () => {
      const hits: string[] = [];
      for (const question of OFF_TOPIC) {
        const ranking = await semanticRanking(question);
        if (ranking.length > 0) hits.push(`${question} -> ${ranking.slice(0, 3).join(', ')}`);
      }
      console.log(`PM-767 off-topic hits: ${hits.length}/${OFF_TOPIC.length}\n${hits.join('\n')}`);
      expect(hits).toEqual([]);
    });

    it('answers within 2 seconds on a history of 50 000 chunks', async () => {
      const real = engine.counts().chunks;
      const vectors = Array.from({ length: 1000 }, (_, seed) => {
        const vector = new Float32Array(384);
        let norm = 0;
        for (let i = 0; i < vector.length; i++) {
          vector[i] = Math.sin((seed + 1) * (i + 1) * 12.9898) * 0.5;
          norm += vector[i]! * vector[i]!;
        }
        for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / Math.sqrt(norm);
        return Buffer.from(vector.buffer);
      });
      const insertDocument = db.prepare(
        `INSERT INTO history_documents (source_id, project_key, source_type, entity_id, task_key, author, at, title, body)
         VALUES (?, ?, 'note', ?, NULL, 'owner', ?, 'Filler', 'Filler text.')`,
      );
      const insertSource = db.prepare(
        `INSERT INTO history_semantic_sources (source_id, project_key, index_key, content_hash, next_char, complete)
         VALUES (?, ?, ?, 'filler', 12, 1)`,
      );
      const insertChunk = db.prepare(
        `INSERT INTO history_semantic_chunks (source_id, chunk_no, start_char, end_char, from_line, to_line, embedding)
         VALUES (?, ?, 0, 12, 1, 1, ?)`,
      );
      db.transaction(() => {
        for (let i = 0; i < BULK_CHUNKS / 5; i++) {
          const id = `filler:${i}`;
          const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
          insertDocument.run(id, PROJECT, id, at);
          insertSource.run(id, PROJECT, indexKey);
          for (let n = 0; n < 5; n++) insertChunk.run(id, n, vectors[(i * 5 + n) % vectors.length]);
        }
      })();

      const timings: number[] = [];
      let rssPeak = 0;
      for (const { question } of QUESTIONS) {
        const startedAt = performance.now();
        await semanticRanking(question);
        timings.push(performance.now() - startedAt);
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      }
      const sorted = [...timings].sort((a, b) => a - b);
      console.log(
        `PM-767 latency over ${real + BULK_CHUNKS} chunks (question embedding + scan, ms): p50 ${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)}, max ${sorted[sorted.length - 1]!.toFixed(0)}; RSS peak ${(rssPeak / 1048576).toFixed(0)} MiB`,
      );
      expect(Math.max(...timings)).toBeLessThan(2000);
    }, 300_000);

    it('made no network call while it loaded the model, indexed and searched', () => {
      expect(networkAttempts).toEqual([]);
    });
  },
);
