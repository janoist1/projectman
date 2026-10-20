import { HistorySemanticFailure } from '../contracts';
import type { HistorySemanticCandidate, HistorySemanticCursor, HistoryVectorScan } from '../contracts';
import type { Db } from '../db';
import { createHistorySemanticRepository, historyContentHash, historyFullText } from '../db';
import { lineIndex, planChunk } from './chunker';
import type { Embedder } from './embedder';

export interface SemanticEngineDeps {
  /** The worker's own connection, with the vector extension loaded. */
  db: Db;
  embedder: Embedder;
  indexKey: string;
  /** Candidates must be at least this similar (cosine) to the question. */
  minCosine: number;
  now?: () => Date;
  warn?: (message: string, details?: Record<string, unknown>) => void;
  /** How often an idle engine looks for new work (default 1 s). */
  idlePollMs?: number;
}

export interface SemanticEngine {
  /** Starts the background work: the changed sources first, then the back-fill. */
  start(): void;
  stop(): Promise<void>;
  /** Embeds a question ahead of the background work; rejects with a `HistorySemanticFailure`. */
  embedQuery(projectKey: string, text: string): Promise<Float32Array>;
  scan(input: HistoryVectorScan): {
    candidates: HistorySemanticCandidate[];
    next: HistorySemanticCursor | null;
  };
  /** One unit of background work; false when there is nothing due. */
  step(): Promise<boolean>;
  /** Works until nothing is due (for tests and the measurement). */
  drain(): Promise<void>;
  counts(): { sources: number; chunks: number; dirty: number };
}

const BACKFILL_PAGE = 10;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const STALE_RETRY_MS = 1_000;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createSemanticEngine(deps: SemanticEngineDeps): SemanticEngine {
  const { embedder, indexKey } = deps;
  const repo = createHistorySemanticRepository(deps.db);
  const now = deps.now ?? (() => new Date());
  const warn = deps.warn ?? (() => undefined);
  let stopped = false;
  let loop: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  let waitingQueries = 0;
  let model: Promise<unknown> = Promise.resolve();

  /** The model runs one text at a time; a question never waits for more than the text being embedded. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = model.then(work, work);
    model = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function embedPassage(text: string): Promise<Float32Array> {
    while (waitingQueries > 0 && !stopped) await yieldToLoop();
    return exclusive(() => embedder.embedPassage(text));
  }

  const iso = (ms: number) => new Date(ms).toISOString();
  const backoffMs = (attempts: number) =>
    Math.min(BASE_BACKOFF_MS * 2 ** Math.min(attempts, 10), MAX_BACKOFF_MS);

  async function indexSource(sourceId: string): Promise<'done' | 'stale' | 'removed'> {
    const document = repo.documentOf(sourceId);
    const text = document ? historyFullText(document.title, document.body) : '';
    if (!document || text.trim() === '') {
      repo.removeSource(sourceId);
      return 'removed';
    }
    const contentHash = historyContentHash(document.title, document.body, document.commitSha);
    let state = repo.sourceState(sourceId);
    if (state && (state.indexKey !== indexKey || state.contentHash !== contentHash)) state = null;
    if (state?.complete) return 'done';
    if (state && state.nextChar >= text.length) state = null;
    if (!state) repo.startSource({ sourceId, projectKey: document.projectKey, indexKey, contentHash });
    let start = state?.nextChar ?? 0;
    let chunkNo = state?.chunks ?? 0;
    const lineOf = lineIndex(text);
    for (;;) {
      if (stopped) return 'stale';
      const plan = planChunk(text, start, embedder.countTokens);
      const embedding = await embedPassage(text.slice(plan.startChar, plan.endChar));
      const saved = repo.saveChunk({
        sourceId,
        indexKey,
        contentHash,
        chunkNo,
        startChar: plan.startChar,
        endChar: plan.endChar,
        fromLine: lineOf(plan.startChar),
        toLine: lineOf(Math.max(plan.startChar, plan.endChar - 1)),
        embedding,
        nextChar: plan.nextChar,
        complete: plan.last,
      });
      if (saved === 'stale') return 'stale';
      if (plan.last) return 'done';
      start = plan.nextChar;
      chunkNo++;
    }
  }

  async function workOnQueue(): Promise<boolean> {
    const [row] = repo.dueDirty(now().toISOString(), 1);
    if (!row) return false;
    try {
      const result = await indexSource(row.sourceId);
      if (result === 'stale')
        repo.deferDirty(row.sourceId, row.revision, iso(now().getTime() + STALE_RETRY_MS));
      else repo.ackDirty(row.sourceId, row.revision);
    } catch (error) {
      repo.deferDirty(row.sourceId, row.revision, iso(now().getTime() + backoffMs(row.attempts)));
      warn('a history source could not be embedded', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  async function backfillStep(): Promise<boolean> {
    for (const projectKey of repo.projectKeys()) {
      let state = repo.backfillState(projectKey);
      if (!state || state.indexKey !== indexKey)
        state = { projectKey, indexKey, lastSourceId: '', complete: false };
      if (state.complete) continue;
      const ids = repo.sourceIdsAfter(projectKey, state.lastSourceId, BACKFILL_PAGE);
      for (const sourceId of ids) {
        if (stopped) return true;
        try {
          await indexSource(sourceId);
        } catch (error) {
          repo.enqueueDirty(sourceId, iso(now().getTime() + backoffMs(1)));
          warn('a history source could not be embedded', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const lastSourceId = ids.length > 0 ? ids[ids.length - 1]! : state.lastSourceId;
      if (ids.length < BACKFILL_PAGE) repo.dropOtherGenerations(projectKey, indexKey);
      repo.putBackfillState({ projectKey, indexKey, lastSourceId, complete: ids.length < BACKFILL_PAGE });
      return true;
    }
    return false;
  }

  async function step(): Promise<boolean> {
    if (await workOnQueue()) return true;
    return backfillStep();
  }

  async function run(): Promise<void> {
    while (!stopped) {
      let worked = false;
      try {
        worked = await step();
      } catch (error) {
        warn('the history embedding work failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (worked) {
        await yieldToLoop();
        continue;
      }
      const next = repo.nextAttemptAt();
      const poll = deps.idlePollMs ?? 1_000;
      const wait = next ? Math.min(poll, Math.max(50, Date.parse(next) - now().getTime())) : poll;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  }

  return {
    start() {
      loop ??= run();
    },

    async stop() {
      stopped = true;
      wake?.();
      await loop;
      loop = null;
    },

    async embedQuery(projectKey, text) {
      if (!repo.projectBackfillComplete(projectKey, indexKey)) throw new HistorySemanticFailure('backfill');
      waitingQueries++;
      try {
        return await exclusive(() => embedder.embedQuery(text));
      } finally {
        waitingQueries--;
      }
    },

    scan(input) {
      const rows = repo.scan({
        projectKey: input.projectKey,
        indexKey: input.indexKey,
        vector: input.vector,
        maxDistance: 1 - deps.minCosine,
        sourceTypes: input.sourceTypes,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
        ...(input.since ? { since: input.since } : {}),
        ...(input.until ? { until: input.until } : {}),
        ...(input.sourceIds ? { sourceIds: input.sourceIds } : {}),
        ...(input.after ? { after: input.after } : {}),
        limit: input.limit,
      });
      const last = rows[rows.length - 1];
      return {
        candidates: rows,
        next:
          last && rows.length === input.limit
            ? { distance: last.distance, at: last.at, sourceId: last.sourceId }
            : null,
      };
    },

    step,

    async drain() {
      while (await step()) await yieldToLoop();
    },

    counts: () => repo.counts(indexKey),
  };
}
