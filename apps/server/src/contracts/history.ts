import type {
  HistoryDocumentSnapshot,
  HistoryDocumentState,
  HistorySearchInput,
  HistorySearchResult,
  HistorySearchStats,
  HistorySourceRead,
  HistoryStatsInput,
  HistoryViewer,
  ProjectConfig,
} from '@projectman/shared';

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
 * `search` and `read` are synchronous database operations once `init` has run. The viewer must be a current
 * member of the project; their access is recomputed from the roster on every call, so a change applies at once.
 */
export interface HistoryService {
  /** Prepares the index: back-fills what it does not hold yet, then starts following the sources. */
  init(): Promise<void>;
  /** Applies every source change recorded so far to the index. */
  flush(): void;
  stop(): Promise<void>;
  search(projectKey: string, viewer: HistoryViewer, input: HistorySearchInput): HistorySearchResult;
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
