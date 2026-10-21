import { z } from 'zod';
import { HISTORY_SEMANTIC_STATUSES, HISTORY_SOURCE_TYPES } from '@projectman/shared';
import { EMBEDDING_DIMENSION } from './model';

/** The statuses a failed request ends in (`used` and `not_run` are not failures). */
export const FAILURE_STATUSES = HISTORY_SEMANTIC_STATUSES.filter(
  (status): status is Exclude<(typeof HISTORY_SEMANTIC_STATUSES)[number], 'used' | 'not_run'> =>
    status !== 'used' && status !== 'not_run',
);
const FailureStatus = z.enum(FAILURE_STATUSES);

export const WorkerData = z.object({
  databasePath: z.string().min(1),
  modelDirectory: z.string().min(1),
  /** Candidates must be at least this similar (cosine) to the question. */
  minCosine: z.number().min(0).max(1),
});
export type WorkerData = z.infer<typeof WorkerData>;

/** Exactly one vector of the model's size, all finite: anything else is not a vector of this index. */
const VectorValue = z.custom<Float32Array>(
  (value) =>
    value instanceof Float32Array &&
    value.length === EMBEDDING_DIMENSION &&
    value.every((component) => Number.isFinite(component)),
);

const Cursor = z.object({ distance: z.number(), at: z.string(), sourceId: z.string() });

const ScanRequest = z.object({
  projectKey: z.string().min(1),
  indexKey: z.string().min(1),
  vector: VectorValue,
  sourceTypes: z.array(z.enum(HISTORY_SOURCE_TYPES)).min(1),
  taskKey: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  sourceIds: z.array(z.string()).optional(),
  after: Cursor.optional(),
  limit: z.number().int().min(1).max(500),
});

export const WorkerRequest = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('embed'),
    id: z.number().int(),
    projectKey: z.string().min(1),
    text: z.string(),
  }),
  z.object({ type: z.literal('scan'), id: z.number().int(), scan: ScanRequest }),
  z.object({ type: z.literal('stop') }),
]);
export type WorkerRequest = z.infer<typeof WorkerRequest>;

const Candidate = z.object({
  sourceId: z.string(),
  indexKey: z.string(),
  contentHash: z.string(),
  chunkNo: z.number().int(),
  startChar: z.number().int(),
  endChar: z.number().int(),
  fromLine: z.number().int(),
  toLine: z.number().int(),
  distance: z.number(),
  at: z.string(),
});

export const WorkerMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), indexKey: z.string() }),
  z.object({
    type: z.literal('embedded'),
    id: z.number().int(),
    indexKey: z.string(),
    vector: VectorValue,
  }),
  z.object({
    type: z.literal('scanned'),
    id: z.number().int(),
    candidates: z.array(Candidate),
    next: Cursor.nullable(),
  }),
  z.object({ type: z.literal('failed'), id: z.number().int(), status: FailureStatus, message: z.string() }),
  z.object({ type: z.literal('fatal'), message: z.string() }),
  z.object({
    type: z.literal('log'),
    level: z.enum(['info', 'warn']),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type WorkerMessage = z.infer<typeof WorkerMessage>;
