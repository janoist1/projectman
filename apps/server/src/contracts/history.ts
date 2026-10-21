import type {
  HistoryDocumentSnapshot,
  HistoryDocumentState,
  HistorySearchInput,
  HistorySearchResult,
  HistorySearchStats,
  HistorySemanticStatus,
  HistorySourceType,
  HistorySourceRead,
  HistoryStatsInput,
  HistoryViewer,
  ProjectConfig,
} from '@projectman/shared';

/** What embedding a question gave (PM-767): the vector, or the reason the search answers by its words only. */
export type HistoryQueryEmbedding =
  | { status: 'used'; indexKey: string; vector: Float32Array }
  | { status: Exclude<HistorySemanticStatus, 'used' | 'not_run'> };

/** Where a vector scan went on from: the last candidate of the previous page. */
export interface HistorySemanticCursor {
  distance: number;
  at: string;
  sourceId: string;
}

/**
 * The best chunk of one source for a question. The vector index never decides who may read the source: the
 * service re-reads the source and checks `contentHash` and `indexKey` against what it is today.
 */
export interface HistorySemanticCandidate {
  sourceId: string;
  indexKey: string;
  contentHash: string;
  chunkNo: number;
  startChar: number;
  endChar: number;
  fromLine: number;
  toLine: number;
  /** Cosine distance (0 = the same direction). */
  distance: number;
  at: string;
}

export interface HistoryVectorScan {
  projectKey: string;
  indexKey: string;
  vector: Float32Array;
  sourceTypes: readonly HistorySourceType[];
  taskKey?: string;
  since?: string;
  until?: string;
  /** Only these sources (the full-text hits, to tell which of them are also close in meaning). */
  sourceIds?: readonly string[];
  after?: HistorySemanticCursor;
  limit: number;
  /** Epoch milliseconds; the answer after it is dropped. */
  deadlineAt: number;
}

export interface HistoryVectorPage {
  /** One candidate per source, nearest first, none farther than the port's threshold. */
  candidates: HistorySemanticCandidate[];
  next: HistorySemanticCursor | null;
}

/**
 * The local embedding of the history (PM-767): a worker thread that makes the vectors of the sources in the
 * background and answers a question with its vector and the nearest chunks. Every failure is a status, never
 * an exception: the search then answers by its words only.
 */
export interface HistorySemanticPort {
  /** Starts following the database; never waits for the model or the backfill. */
  start(): void;
  embedQuery(projectKey: string, query: string, deadlineAt: number): Promise<HistoryQueryEmbedding>;
  /** The nearest chunks; rejects with a `HistorySemanticFailure` when the worker cannot answer in time. */
  scan(input: HistoryVectorScan): Promise<HistoryVectorPage>;
  stop(): Promise<void>;
}

/** A scan the worker could not answer; the status is what the search log keeps. */
export class HistorySemanticFailure extends Error {
  readonly status: Exclude<HistorySemanticStatus, 'used' | 'not_run'>;
  constructor(status: Exclude<HistorySemanticStatus, 'used' | 'not_run'>, message?: string) {
    super(message ?? `the semantic history search failed: ${status}`);
    this.name = 'HistorySemanticFailure';
    this.status = status;
  }
}

/** The project's current configuration, as the history service needs it (its roster and its repositories). */
export type HistoryConfigSource = (projectKey: string) => ProjectConfig | null;

export type HistoryDocAt = { kind: 'head' } | { kind: 'commit'; commit: string };

/** The reply belongs to an engine assignment that is no longer current; it must not update any copy state. */
export class HistoryDocumentReadSuperseded extends Error {
  constructor() {
    super('The history document engine selection changed');
    this.name = 'HistoryDocumentReadSuperseded';
  }
}

/** Engine document reads for the cloud search copy; both fixed paths come from one commit. */
export interface HistoryDocumentReader {
  read(projectKey: string, repo: string, at: HistoryDocAt): Promise<HistoryDocumentSnapshot>;
  isAncestor(
    projectKey: string,
    repo: string,
    input: { ancestor: string; commit: string },
  ): Promise<boolean | null>;
}

export interface HistoryMainMoved {
  projectKey: string;
  repo: string;
  base: string;
  commit: string;
}

/**
 * The searchable history of a project (PM-744, PM-786): one durable full-text index of cards, notes, closed
 * questions, team messages and the two project documents, searched and read through the one visibility rule.
 * `read` is a synchronous database operation once `init` has run; `search` waits for the local embedding of the
 * question (PM-767) and answers by the words alone when that is not available. The viewer must be a current
 * member of the project; their access is recomputed from the roster on every call, so a change applies at once.
 */
export interface HistoryService {
  /** Prepares the index: back-fills what it does not hold yet, then starts following the sources. */
  init(): Promise<void>;
  /** Applies every source change recorded so far to the index. */
  flush(): void;
  stop(): Promise<void>;
  search(projectKey: string, viewer: HistoryViewer, input: HistorySearchInput): Promise<HistorySearchResult>;
  read(
    projectKey: string,
    viewer: HistoryViewer,
    input: { sourceId: string; fromLine?: number; lineCount?: number; commit?: string },
  ): HistorySourceRead;
  /**
   * The private statistics of the search log (PM-787). Every `search` is recorded once, whatever door it came
   * through; only a current human owner or admin without `via` may read the statistics, otherwise
   * `history_stats_forbidden`. The log is purged after 90 days.
   */
  stats(projectKey: string, viewer: HistoryViewer, input: HistoryStatsInput): HistorySearchStats;
  /** Replaces the stored copy of the two documents of one repository (a missing file has `null` text). */
  replaceDocuments(input: HistoryDocumentSnapshot): void;
  /** Records a failed read: the stored copies turn stale, a repository never read turns unavailable. */
  markDocumentsUnavailable(projectKey: string, repo: string, checkedAt: string): void;
  /** Removes the stored copies and the state of a repository that left the project. */
  removeRepositoryDocuments(projectKey: string, repo: string): void;
  /** Stored document states, including their commits, for the synchronizer's monotonicity check. */
  documentStates(projectKey: string, repo: string): HistoryDocumentState[];
}
