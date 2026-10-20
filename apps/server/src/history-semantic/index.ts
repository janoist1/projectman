import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ResourceLimits } from 'node:worker_threads';
import type { HistorySemanticStatus } from '@projectman/shared';
import { HistorySemanticFailure } from '../contracts';
import type {
  HistoryQueryEmbedding,
  HistorySemanticPort,
  HistoryVectorPage,
  HistoryVectorScan,
} from '../contracts';
import { WorkerMessage } from './protocol';
import type { WorkerData, WorkerRequest } from './protocol';

type Failure = Exclude<HistorySemanticStatus, 'used' | 'not_run'>;

export interface HistorySemanticLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface HistorySemanticOptions {
  /** The runtime database file; null for an in-memory one, which the worker cannot share. */
  databasePath: string | null;
  /** The directory with the pinned model files and their manifest. */
  modelDirectory: string;
  enabled: boolean;
  /** The least cosine similarity of a hit (default `DEFAULT_MIN_COSINE`). */
  minCosine?: number;
  logger: HistorySemanticLogger;
  /** How long after a failure the worker is not started again (default 60 s). */
  cooldownMs?: number;
  /** Requests waiting for the worker at most; more are `busy` (default 4). */
  maxWaiting?: number;
  /** How long a stopping worker may take before it is terminated (default 5 s). */
  stopTimeoutMs?: number;
  /** Replaces the worker entry file (tests). */
  workerUrl?: URL;
  resourceLimits?: ResourceLimits;
  now?: () => number;
}

/** The similarity below which a chunk is not a hit; calibrated on the question set of `real-model.test.ts` (PM-767). */
export const DEFAULT_MIN_COSINE = 0.82;
const WARN_INTERVAL_MS = 60_000;

/** Heap limits of the worker; the model itself lives in native memory outside them. */
const DEFAULT_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 32 };

interface WorkerEntry {
  source: URL | string;
  eval: boolean;
}

/** A TypeScript entry (tests, `tsx`) is loaded through tsx registered inside the thread: a worker ignores `--import`. */
function sourceEntry(url: URL): WorkerEntry {
  // Joined from plain strings: a template literal with an `import(${…})` reads as a computed dependency.
  const load = "import('tsx/esm/api').then(({ register }) => { register(); return import(";
  return { eval: true, source: load + JSON.stringify(url.href) + '); });' };
}

function defaultWorkerEntry(): WorkerEntry {
  // Built: the bundle sits beside the worker bundle. From source: the TypeScript file.
  const worker = import.meta.url.endsWith('.ts')
    ? new URL('./worker.ts', import.meta.url)
    : new URL('./history-semantic-worker.js', import.meta.url);
  return worker.pathname.endsWith('.ts') ? sourceEntry(worker) : { eval: false, source: worker };
}

interface Pending {
  resolve(message: WorkerMessage): void;
  reject(error: HistorySemanticFailure): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The local embedding of the history (PM-767), as a worker thread behind a port. It starts without waiting for the
 * model, answers every request with a status when the worker cannot (loading, back-fill, busy, too slow, failed),
 * stays away for a cooldown after a failure, and never throws into the search.
 */
export function createHistorySemanticPort(options: HistorySemanticOptions): HistorySemanticPort {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 60_000;
  const maxWaiting = options.maxWaiting ?? 4;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  const databasePath = options.databasePath;
  const usable = options.enabled && databasePath !== null && databasePath !== ':memory:';

  let worker: Worker | null = null;
  let state: 'idle' | 'loading' | 'ready' | 'cooldown' | 'stopped' = 'idle';
  let cooldownUntil = 0;
  let lastFailure: Failure = 'unavailable';
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const warnedAt = new Map<string, number>();

  function warnOnce(cause: string, details: object, message: string): void {
    const last = warnedAt.get(cause);
    if (last !== undefined && now() - last < WARN_INTERVAL_MS) return;
    warnedAt.set(cause, now());
    options.logger.warn({ cause, ...details }, message);
  }

  function failPending(status: Failure): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new HistorySemanticFailure(status));
    }
  }

  function fail(status: Failure, cause: string, details: object): void {
    if (state === 'stopped') return;
    state = 'cooldown';
    lastFailure = status;
    cooldownUntil = now() + cooldownMs;
    failPending(status);
    warnOnce(cause, details, 'the semantic history search is off for now; searches use the words only');
  }

  function spawn(): void {
    if (!usable || state === 'stopped') return;
    // A build without the model needs no thread to say so.
    if (!existsSync(join(options.modelDirectory, 'manifest.json'))) {
      fail('unavailable', 'model_missing', { modelDirectory: options.modelDirectory });
      return;
    }
    const entry = options.workerUrl ? sourceEntry(options.workerUrl) : defaultWorkerEntry();
    const data: WorkerData = {
      databasePath: databasePath!,
      modelDirectory: options.modelDirectory,
      minCosine: options.minCosine ?? DEFAULT_MIN_COSINE,
    };
    state = 'loading';
    let started: Worker;
    try {
      started = new Worker(entry.source, {
        eval: entry.eval,
        workerData: data,
        resourceLimits: options.resourceLimits ?? DEFAULT_LIMITS,
      });
    } catch (error) {
      fail('unavailable', 'spawn', { err: error });
      return;
    }
    worker = started;
    started.unref();
    started.on('message', (raw: unknown) => {
      if (worker !== started) return;
      const parsed = WorkerMessage.safeParse(raw);
      if (!parsed.success) return;
      handle(parsed.data);
    });
    started.on('error', (error: Error & { code?: string }) => {
      if (worker !== started) return;
      fail(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'resource_limit' : 'error', 'worker_error', {
        err: error,
      });
    });
    started.on('exit', (code) => {
      if (worker !== started) return;
      worker = null;
      if (state !== 'stopped' && state !== 'cooldown') fail('unavailable', 'worker_exit', { code });
    });
  }

  function handle(message: WorkerMessage): void {
    switch (message.type) {
      case 'ready':
        if (state === 'loading') {
          state = 'ready';
          options.logger.info({ indexKey: message.indexKey }, 'the semantic history search is ready');
        }
        return;
      case 'fatal':
        fail('unavailable', 'worker_fatal', { message: message.message });
        void worker?.terminate();
        return;
      case 'log':
        warnOnce(`log:${message.message}`, { ...message.details }, message.message);
        return;
      case 'embedded':
      case 'scanned':
      case 'failed': {
        const entry = pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.type === 'failed')
          entry.reject(new HistorySemanticFailure(message.status, message.message));
        else entry.resolve(message);
      }
    }
  }

  /** Why no request can be sent now; null when the worker is ready. */
  function unavailable(): Failure | null {
    if (!usable) return 'disabled';
    switch (state) {
      case 'ready':
        return pending.size >= maxWaiting ? 'busy' : null;
      case 'loading':
        return 'loading';
      case 'cooldown':
        // A new thread starts only after the failed one has exited.
        if (now() < cooldownUntil || worker) return lastFailure;
        spawn();
        return 'loading';
      default:
        return 'unavailable';
    }
  }

  function call(
    build: (id: number) => Extract<WorkerRequest, { type: 'embed' | 'scan' }>,
    deadlineAt: number,
  ): Promise<WorkerMessage> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new HistorySemanticFailure('timeout'));
        },
        Math.max(0, deadlineAt - now()),
      );
      pending.set(id, { resolve, reject, timer });
      try {
        worker!.postMessage(build(id));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new HistorySemanticFailure('error', error instanceof Error ? error.message : String(error)));
      }
    });
  }

  const statusOf = (error: unknown): Failure =>
    error instanceof HistorySemanticFailure ? error.status : 'error';

  return {
    start() {
      if (!usable || state !== 'idle') return;
      spawn();
    },

    async embedQuery(projectKey, query, deadlineAt): Promise<HistoryQueryEmbedding> {
      const status = unavailable();
      if (status) return { status };
      try {
        const reply = await call((id) => ({ type: 'embed', id, projectKey, text: query }), deadlineAt);
        return reply.type === 'embedded'
          ? { status: 'used', indexKey: reply.indexKey, vector: reply.vector }
          : { status: 'error' };
      } catch (error) {
        return { status: statusOf(error) };
      }
    },

    async scan(input: HistoryVectorScan): Promise<HistoryVectorPage> {
      const status = unavailable();
      if (status) throw new HistorySemanticFailure(status);
      const { deadlineAt, sourceTypes, sourceIds, ...rest } = input;
      const reply = await call(
        (id) => ({
          type: 'scan',
          id,
          scan: {
            ...rest,
            sourceTypes: [...sourceTypes],
            ...(sourceIds ? { sourceIds: [...sourceIds] } : {}),
          },
        }),
        deadlineAt,
      );
      if (reply.type !== 'scanned') throw new HistorySemanticFailure('error');
      return { candidates: reply.candidates, next: reply.next };
    },

    async stop() {
      state = 'stopped';
      failPending('unavailable');
      const stopping = worker;
      worker = null;
      if (!stopping) return;
      const exited = new Promise<void>((resolve) => stopping.once('exit', () => resolve()));
      try {
        stopping.postMessage({ type: 'stop' } satisfies WorkerRequest);
      } catch {
        // already gone
      }
      const timer = setTimeout(() => void stopping.terminate(), stopTimeoutMs);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
