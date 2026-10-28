import {
  HISTORY_DOC_PATHS,
  HISTORY_READ_DEFAULT_LINES,
  HISTORY_SEARCH_DEFAULT_LIMIT,
  HISTORY_SEARCH_RETENTION_DAYS,
  HISTORY_SOURCE_TYPES,
  HISTORY_STATS_DEFAULT_DAYS,
  HISTORY_STATS_DEFAULT_LIMIT,
  HistoryDocumentSnapshot,
  HistoryReadInput,
  HistorySearchFilters,
  HistorySearchInput,
  HistoryStatsInput,
  canSeeHistorySearchStats,
  memberOf,
  visibleHistorySource,
} from '@projectman/shared';
import type {
  HistoryDocPath,
  HistoryDocumentState,
  HistoryHit,
  HistoryReference,
  HistorySearchResult,
  HistorySearchStats,
  HistorySemanticStatus,
  HistorySourceRead,
  HistorySourceType,
  HistoryText,
  HistoryViewer,
  ProjectConfig,
} from '@projectman/shared';
import type {
  EventBus,
  HistoryConfigSource,
  HistorySemanticCandidate,
  HistorySemanticPort,
  HistoryService,
} from '../../contracts';
import { HistorySemanticFailure } from '../../contracts';
import { historyContentHash, historyDocumentEntityId, historyFullText } from '../../db';
import type { HistoryDocumentRow, HistoryDocStateRow } from '../../db';
import { DomainError, conflict, forbidden, newId, notFound, unavailable } from '../../kernel';
import { chunkExcerpt, excerptOf } from './excerpt';
import { createHistoryIndexer } from './indexer';
import { QueryError, translateQuery } from './query';
import { loadRowSource, normalizeAt, relatedOf, taskOfProject } from './sources';
import type { HistorySourceRepos } from './sources';

type HistoryLogger = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

interface HistoryServiceDeps {
  repos: HistorySourceRepos;
  /** The project's current configuration: the roster and the registered repositories. */
  config: HistoryConfigSource;
  bus?: EventBus;
  logger: HistoryLogger;
  now: () => Date;
  /** The fallback sweep (default 1 s). */
  sweepMs?: number;
  /** Rows per backfill page (default 500). */
  pageSize?: number;
  /** The local embedding (PM-767); without it a search answers by its words only. */
  semantic?: HistorySemanticPort;
}

/** The whole semantic part of a search (the question's embedding and the scans) gets this long. */
const SEMANTIC_DEADLINE_MS = 1500;
/** A search reads at most this many pages of the vector scan, however many of its candidates are hidden. */
const SEMANTIC_MAX_PAGES = 6;
const SEMANTIC_MIN_PAGE = 20;
const SWEEP_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Coalesces the events of one write burst into one index run. */
const WAKE_MS = 20;
const WAKE_EVENTS: ReadonlySet<string> = new Set([
  'task_upserted',
  'timeline_appended',
  'inbox_upserted',
  'team_message',
  'team_message_updated',
]);

const invalidRequest = (message: string, details?: unknown) =>
  new DomainError('invalid_request', message, { status: 422, details });

const issueText = (error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) =>
  error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The text of a full read: the heading and the body. */
const fullTextOf = (text: HistoryText) => historyFullText(text.title, text.body);

/** How the semantic part of one search ended, for the search log. */
interface SemanticTrace {
  status: HistorySemanticStatus;
  durationMs: number | null;
}

/** What the vector scans found, to be checked again against the sources as they are when the answer is built. */
interface SemanticFindings {
  indexKey: string;
  /** Text hits that are also close in meaning. */
  both: Map<string, HistorySemanticCandidate>;
  /** Candidates that are no text hit, nearest first. */
  extras: HistorySemanticCandidate[];
}

export function createHistoryService(deps: HistoryServiceDeps): HistoryService {
  const { repos, logger } = deps;
  const history = repos.history;
  const indexer = createHistoryIndexer({
    repos,
    ...(deps.pageSize ? { pageSize: deps.pageSize } : {}),
    onError: (row, error) =>
      logger.error(
        { err: error, projectKey: row.projectKey, sourceType: row.sourceType },
        'a history source could not be indexed',
      ),
  });
  let ready = false;
  let stopped = false;
  let initializing: Promise<void> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let lastPurgeAt = 0;

  const nowIso = () => deps.now().toISOString();

  function flush(): void {
    if (!ready) return;
    try {
      indexer.drain();
    } catch (error) {
      logger.error({ err: error }, 'the history index could not follow the sources');
    }
  }

  function wake(): void {
    if (wakeTimer || stopped) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      flush();
    }, WAKE_MS);
    wakeTimer.unref?.();
  }

  async function backfill(): Promise<void> {
    for (const projectKey of history.projectKeys()) {
      while (!indexer.backfillStep(projectKey)) {
        if (stopped) return;
        await yieldToLoop();
      }
    }
    indexer.drain();
    ready = true;
  }

  async function init(): Promise<void> {
    if (ready) return;
    purgeSearchLogSafely();
    initializing ??= backfill()
      .catch((error: unknown) => {
        logger.error({ err: error }, 'the history index could not be prepared');
      })
      .finally(() => {
        initializing = null;
      });
    await initializing;
    if (stopped) return;
    sweepTimer ??= setInterval(() => {
      if (deps.now().getTime() - lastPurgeAt >= DAY_MS) purgeSearchLogSafely();
      if (ready) flush();
      else void init();
    }, deps.sweepMs ?? SWEEP_MS);
    sweepTimer.unref?.();
    if (deps.bus && !unsubscribe)
      unsubscribe = deps.bus.subscribe((event) => {
        if (WAKE_EVENTS.has(event.type)) wake();
      });
  }

  function configOf(projectKey: string): ProjectConfig {
    const config = deps.config(projectKey);
    // An unknown project is as unreachable as one the viewer is not in: the answer must not tell them apart.
    if (!config) throw forbidden('insufficient_access', 'not a member of the project');
    return config;
  }

  function ensureReady(projectKey: string): void {
    if (!ready) throw unavailable('history_unavailable', 'the history index is not ready');
    const state = history.indexState(projectKey);
    if (!state) indexer.markEmptyProjectComplete(projectKey);
    else if (!state.complete) throw unavailable('history_unavailable', 'the history index is not complete');
  }

  function ensureUsable(projectKey: string): ProjectConfig {
    if (!ready) throw unavailable('history_unavailable', 'the history index is not ready');
    const config = configOf(projectKey);
    ensureReady(projectKey);
    return config;
  }

  /** Deletes the searches older than the retention; the one made exactly at the cut-off stays. */
  function purgeSearchLog(): void {
    const cutoff = new Date(deps.now().getTime() - HISTORY_SEARCH_RETENTION_DAYS * DAY_MS).toISOString();
    lastPurgeAt = deps.now().getTime();
    repos.historySearches.purgeBefore(cutoff);
  }

  function purgeSearchLogSafely(): void {
    try {
      purgeSearchLog();
    } catch (error) {
      logger.error({ err: error }, 'the history search log could not be purged');
    }
  }

  /** The viewer as the current roster knows them: their access is never taken from the caller. */
  function viewerOf(config: ProjectConfig, viewer: HistoryViewer): HistoryViewer {
    const member = memberOf(config, viewer.handle);
    if (!member) throw forbidden('insufficient_access', 'not a member of the project');
    return {
      handle: member.handle,
      access: member.kind === 'ai' ? 'ai' : member.access,
      ...(viewer.via ? { via: viewer.via } : {}),
    };
  }

  function searchDocumentStates(config: ProjectConfig): HistoryDocumentState[] {
    const stored = new Map(
      history.docStates(config.project.key).map((state) => [`${state.repo}\u0000${state.path}`, state]),
    );
    return config.project.repos.flatMap((repo) =>
      HISTORY_DOC_PATHS.map((path): HistoryDocumentState => {
        const state = stored.get(`${repo.name}\u0000${path}`);
        return {
          repo: repo.name,
          path,
          commit: state?.commitSha ?? null,
          checkedAt: state?.checkedAt ?? null,
          indexedAt: state?.indexedAt ?? null,
          status: state?.status ?? 'pending',
        };
      }),
    );
  }

  /**
   * The call that opens a hit. A hit found by meaning only has no matching word to find again, so it opens the
   * source at the chunk's first line (`atLine`) instead of at the card or the note as a whole.
   */
  function referenceOf(
    projectKey: string,
    row: HistoryDocumentRow,
    line: number,
    atLine = false,
  ): HistoryReference {
    if (!atLine && row.sourceType === 'task' && row.taskKey)
      return { tool: 'get_task', arguments: { project_key: projectKey, task_key: row.taskKey } };
    if (!atLine && row.sourceType === 'note' && row.taskKey)
      return {
        tool: 'get_task',
        arguments: { project_key: projectKey, task_key: row.taskKey, event_id: row.entityId },
      };
    return {
      tool: 'read_history_source',
      arguments: {
        project_key: projectKey,
        source_id: row.sourceId,
        ...(row.sourceType === 'document' && row.commitSha
          ? { from_line: line, commit: row.commitSha }
          : atLine
            ? { from_line: line }
            : {}),
      },
    };
  }

  /** What the log keeps of the filters: normalized, so every door writes the same text for the same search. */
  function filtersOf(input: HistorySearchInput): HistorySearchFilters {
    const wanted = input.sourceTypes ?? HISTORY_SOURCE_TYPES;
    return {
      ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      sourceTypes: HISTORY_SOURCE_TYPES.filter((type) => wanted.includes(type)),
      ...(input.since ? { since: normalizeAt(input.since) } : {}),
      ...(input.until ? { until: normalizeAt(input.until) } : {}),
      limit: input.limit ?? HISTORY_SEARCH_DEFAULT_LIMIT,
    };
  }

  /**
   * One search, measured exactly once (PM-787): a call that is not a search (invalid, not a member, not found) leaves
   * no record; a search that ran is recorded as it ended, and its result leaves only after the record is written.
   */
  async function search(
    projectKey: string,
    viewerIn: HistoryViewer,
    rawInput: HistorySearchInput,
  ): Promise<HistorySearchResult> {
    const parsed = HistorySearchInput.safeParse(rawInput);
    if (!parsed.success) throw invalidRequest(issueText(parsed.error));
    const input = parsed.data;
    const config = configOf(projectKey);
    const viewer = viewerOf(config, viewerIn);
    const entry = {
      id: newId('hsr'),
      at: nowIso(),
      member: viewer.handle,
      projectKey,
      via: viewer.via ?? null,
      query: input.query,
      filters: JSON.stringify(filtersOf(input)),
    };
    const semantic: SemanticTrace = { status: 'not_run', durationMs: null };
    let result: HistorySearchResult;
    try {
      result = await runSearch(config, viewerIn, viewer, input, semantic);
    } catch (error) {
      // A refused request (invalid query, unknown card) is no search; a failure of the server is one that failed.
      if (error instanceof DomainError && error.status < 500) throw error;
      try {
        repos.historySearches.insert({
          ...entry,
          resultCount: null,
          hasMore: null,
          outcome: 'error',
          errorCode: error instanceof DomainError ? error.code : 'internal_error',
          semanticStatus: semantic.status,
          semanticDurationMs: semantic.durationMs,
        });
      } catch (recordError) {
        logger.error({ err: recordError, projectKey }, 'a failed history search could not be recorded');
      }
      throw error;
    }
    try {
      repos.historySearches.insert({
        ...entry,
        resultCount: result.matches.length,
        hasMore: result.hasMore,
        outcome: 'ok',
        errorCode: null,
        semanticStatus: semantic.status,
        semanticDurationMs: semantic.durationMs,
      });
    } catch (error) {
      logger.error({ err: error, projectKey }, 'a history search could not be recorded');
      throw unavailable('history_unavailable', 'the search could not be recorded');
    }
    return result;
  }

  /** The words part of a search: the full-text candidates the viewer may read, in rank order, up to the limit. */
  function textPhase(
    projectKey: string,
    viewer: HistoryViewer,
    input: HistorySearchInput,
    translated: { match: string; terms: string[] },
    requested: readonly HistorySourceType[],
  ): { matches: HistoryHit[]; hasMore: boolean } {
    flush();
    if (input.taskKey) {
      if (!taskOfProject(repos, projectKey, input.taskKey)) throw notFound('task', input.taskKey);
    }
    const limit = input.limit ?? HISTORY_SEARCH_DEFAULT_LIMIT;
    const matches: HistoryHit[] = [];
    let hasMore = false;
    if (requested.length > 0) {
      const related = relatedOf(repos, projectKey);
      const rows = history.scan({
        match: translated.match,
        projectKey,
        sourceTypes: requested,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
        ...(input.since ? { since: normalizeAt(input.since) } : {}),
        ...(input.until ? { until: normalizeAt(input.until) } : {}),
      });
      try {
        for (const row of rows) {
          const source = loadRowSource(repos, row);
          const visible = source && visibleHistorySource(viewer, source, related);
          // The index copy must be the text the viewer may read: a match in anything else is no hit.
          if (!visible || visible.title !== row.title || visible.body !== row.body) continue;
          if (matches.length === limit) {
            hasMore = true;
            break;
          }
          const { excerpt, line } = excerptOf(visible.title, visible.body, translated.terms);
          matches.push({
            sourceId: row.sourceId,
            sourceType: row.sourceType,
            taskKey: row.taskKey,
            author: row.author,
            at: row.at,
            excerpt,
            reference: referenceOf(projectKey, row, line),
            matchType: 'text',
            ...(row.sourceType === 'document' && row.repo && row.path && row.commitSha
              ? { document: { repo: row.repo, path: row.path, commit: row.commitSha, line } }
              : {}),
          });
        }
      } finally {
        rows.return?.();
      }
    }
    return { matches, hasMore };
  }

  /**
   * A candidate of the vector scan is a hit only if the source is, right now, readable by the viewer, is the very
   * text its index copy holds, and is the text and the model generation the vector was made from. The vector
   * index never decides who may read what.
   */
  function verifiedCandidate(
    projectKey: string,
    viewer: HistoryViewer,
    related: ReturnType<typeof relatedOf>,
    input: HistorySearchInput,
    candidate: HistorySemanticCandidate,
    indexKey: string,
  ): { row: HistoryDocumentRow; visible: HistoryText } | null {
    if (candidate.indexKey !== indexKey) return null;
    const row = history.documentBySourceId(projectKey, candidate.sourceId);
    if (!row) return null;
    if (input.taskKey && row.taskKey !== input.taskKey) return null;
    if (input.since && row.at < normalizeAt(input.since)) return null;
    if (input.until && row.at > normalizeAt(input.until)) return null;
    const source = loadRowSource(repos, row);
    const visible = source && visibleHistorySource(viewer, source, related);
    if (!visible || visible.title !== row.title || visible.body !== row.body) return null;
    if (historyContentHash(row.title, row.body, row.commitSha) !== candidate.contentHash) return null;
    return { row, visible };
  }

  /**
   * The meaning part of a search, up to the point it can be told: which text hits are also close in meaning, and
   * which other sources are. Any failure is a status, and the search then answers by its words only.
   */
  async function gatherSemantic(
    port: HistorySemanticPort,
    projectKey: string,
    viewerIn: HistoryViewer,
    input: HistorySearchInput,
    requested: readonly HistorySourceType[],
    first: { matches: HistoryHit[]; hasMore: boolean },
    trace: SemanticTrace,
  ): Promise<SemanticFindings | null> {
    const started = performance.now();
    const deadlineAt = Date.now() + SEMANTIC_DEADLINE_MS;
    const finish = (status: HistorySemanticStatus): null => {
      trace.status = status;
      trace.durationMs = Math.round(performance.now() - started);
      return null;
    };
    const embedding = await port.embedQuery(projectKey, input.query, deadlineAt);
    if (embedding.status !== 'used') return finish(embedding.status);
    const limit = input.limit ?? HISTORY_SEARCH_DEFAULT_LIMIT;
    const scope = {
      projectKey,
      indexKey: embedding.indexKey,
      vector: embedding.vector,
      sourceTypes: requested,
      ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      ...(input.since ? { since: normalizeAt(input.since) } : {}),
      ...(input.until ? { until: normalizeAt(input.until) } : {}),
      deadlineAt,
    };
    const findings: SemanticFindings = { indexKey: embedding.indexKey, both: new Map(), extras: [] };
    try {
      if (first.matches.length > 0) {
        const page = await port.scan({
          ...scope,
          sourceIds: first.matches.map((match) => match.sourceId),
          limit: first.matches.length,
        });
        for (const candidate of page.candidates) findings.both.set(candidate.sourceId, candidate);
      }
      if (!first.hasMore) {
        const seen = new Set(first.matches.map((match) => match.sourceId));
        const capacity = limit - first.matches.length;
        let after;
        for (let pageNo = 0; pageNo < SEMANTIC_MAX_PAGES; pageNo++) {
          const page = await port.scan({
            ...scope,
            ...(after ? { after } : {}),
            limit: Math.max(SEMANTIC_MIN_PAGE, limit),
          });
          // Whatever was awaited, the viewer is whoever the roster says they are now.
          const viewer = viewerOf(configOf(projectKey), viewerIn);
          const related = relatedOf(repos, projectKey);
          for (const candidate of page.candidates) {
            if (seen.has(candidate.sourceId)) continue;
            if (!verifiedCandidate(projectKey, viewer, related, input, candidate, embedding.indexKey))
              continue;
            seen.add(candidate.sourceId);
            findings.extras.push(candidate);
            if (findings.extras.length > capacity) break;
          }
          if (findings.extras.length > capacity || !page.next) break;
          after = page.next;
        }
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      logger.warn({ err: error, projectKey }, 'the semantic part of a history search failed');
      return finish(error instanceof HistorySemanticFailure ? error.status : 'error');
    }
    finish('used');
    return findings;
  }

  async function runSearch(
    config: ProjectConfig,
    viewerIn: HistoryViewer,
    viewer: HistoryViewer,
    input: HistorySearchInput,
    trace: SemanticTrace,
  ): Promise<HistorySearchResult> {
    const projectKey = config.project.key;
    ensureReady(projectKey);
    let translated;
    try {
      translated = translateQuery(input.query);
    } catch (error) {
      if (error instanceof QueryError) throw invalidRequest(error.message);
      throw error;
    }
    const requested = input.sourceTypes ?? HISTORY_SOURCE_TYPES;
    const wantsDocuments = requested.includes('document');
    const limit = input.limit ?? HISTORY_SEARCH_DEFAULT_LIMIT;
    let { matches, hasMore } = textPhase(projectKey, viewer, input, translated, requested);
    let current = { config, viewer };
    const findings =
      deps.semantic && requested.length > 0
        ? await gatherSemantic(
            deps.semantic,
            projectKey,
            viewerIn,
            input,
            requested,
            { matches, hasMore },
            trace,
          )
        : null;
    if (findings) {
      // One synchronous block after the last wait: the words part is read again, and every candidate is
      // checked against the sources as they are now.
      const fresh = configOf(projectKey);
      current = { config: fresh, viewer: viewerOf(fresh, viewerIn) };
      ensureReady(projectKey);
      ({ matches, hasMore } = textPhase(projectKey, current.viewer, input, translated, requested));
      const related = relatedOf(repos, projectKey);
      for (const match of matches) {
        const candidate = findings.both.get(match.sourceId);
        if (
          candidate &&
          verifiedCandidate(projectKey, current.viewer, related, input, candidate, findings.indexKey)
        )
          match.matchType = 'both';
      }
      const seen = new Set(matches.map((match) => match.sourceId));
      if (!hasMore) {
        for (const candidate of findings.extras) {
          if (seen.has(candidate.sourceId)) continue;
          const verified = verifiedCandidate(
            projectKey,
            current.viewer,
            related,
            input,
            candidate,
            findings.indexKey,
          );
          if (!verified) continue;
          if (matches.length === limit) {
            hasMore = true;
            break;
          }
          const { row, visible } = verified;
          matches.push({
            sourceId: row.sourceId,
            sourceType: row.sourceType,
            taskKey: row.taskKey,
            author: row.author,
            at: row.at,
            excerpt: chunkExcerpt(fullTextOf(visible), candidate.startChar, candidate.endChar),
            reference: referenceOf(projectKey, row, candidate.fromLine, true),
            matchType: 'semantic',
            ...(row.sourceType === 'document' && row.repo && row.path && row.commitSha
              ? {
                  document: {
                    repo: row.repo,
                    path: row.path,
                    commit: row.commitSha,
                    line: candidate.fromLine,
                  },
                }
              : {}),
          });
        }
      }
    }
    return {
      projectKey,
      matches,
      hasMore,
      documents: wantsDocuments ? searchDocumentStates(current.config) : [],
    };
  }

  function read(
    projectKey: string,
    viewerIn: HistoryViewer,
    rawInput: { sourceId: string; fromLine?: number; lineCount?: number; commit?: string },
  ): HistorySourceRead {
    const parsed = HistoryReadInput.safeParse(rawInput);
    if (!parsed.success) throw invalidRequest(issueText(parsed.error));
    const input = parsed.data;
    const config = ensureUsable(projectKey);
    const viewer = viewerOf(config, viewerIn);
    flush();
    const row = history.documentBySourceId(projectKey, input.sourceId);
    const source = row && loadRowSource(repos, row);
    const visible = row && source && visibleHistorySource(viewer, source, relatedOf(repos, projectKey));
    if (!row || !visible) throw notFound('history source', input.sourceId);
    if (input.commit !== undefined) {
      if (row.sourceType !== 'document') throw invalidRequest('commit applies to a document only');
      if (row.commitSha !== input.commit)
        throw conflict('history_source_changed', 'the document copy changed since the search', {
          sourceId: row.sourceId,
        });
    }
    const text = fullTextOf(visible);
    const lines = text === '' ? [] : text.split('\n');
    const fromLine = input.fromLine ?? 1;
    if (fromLine > Math.max(lines.length, 1))
      throw invalidRequest(`fromLine ${fromLine} is beyond the last of ${lines.length} lines`);
    const count = input.lineCount ?? HISTORY_READ_DEFAULT_LINES;
    return {
      projectKey,
      sourceId: row.sourceId,
      sourceType: row.sourceType,
      taskKey: row.taskKey,
      author: row.author,
      at: row.at,
      fromLine,
      totalLines: lines.length,
      text: lines.slice(fromLine - 1, fromLine - 1 + count).join('\n'),
      ...(row.sourceType === 'document' && row.repo && row.path && row.commitSha
        ? { document: { repo: row.repo, path: row.path, commit: row.commitSha } }
        : {}),
    };
  }

  function filtersOfRecord(text: string): HistorySearchFilters {
    try {
      const parsed = HistorySearchFilters.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // A record this build cannot read is shown without its filters.
    }
    return {};
  }

  /** The private statistics of the search log (PM-787): only a current owner or admin on their own request. */
  function stats(
    projectKey: string,
    viewerIn: HistoryViewer,
    rawInput: HistoryStatsInput,
  ): HistorySearchStats {
    const parsed = HistoryStatsInput.safeParse(rawInput);
    if (!parsed.success) throw invalidRequest(issueText(parsed.error));
    const input = parsed.data;
    const viewer = viewerOf(configOf(projectKey), viewerIn);
    if (!canSeeHistorySearchStats(viewer))
      throw forbidden('history_stats_forbidden', 'the search statistics are not for this caller');
    purgeSearchLog();
    const now = deps.now().getTime();
    const until = input.until ? normalizeAt(input.until) : new Date(now).toISOString();
    const since = input.since
      ? normalizeAt(input.since)
      : new Date(Date.parse(until) - HISTORY_STATS_DEFAULT_DAYS * DAY_MS).toISOString();
    if (since > until) throw invalidRequest('since must not be after until');
    const period = { projectKey, since, until, ...(input.member ? { member: input.member } : {}) };
    const limit = input.limit ?? HISTORY_STATS_DEFAULT_LIMIT;
    const byMember = repos.historySearches.byMember(period);
    const totalSearches = byMember.reduce((sum, row) => sum + row.searches, 0);
    const zeroResultCount = byMember.reduce((sum, row) => sum + row.zeroResultSearches, 0);
    const rows = repos.historySearches.zeroResults(
      period,
      input.cursor ? { at: normalizeAt(input.cursor.at), id: input.cursor.id } : null,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      since,
      until,
      retainedSince: new Date(now - HISTORY_SEARCH_RETENTION_DAYS * DAY_MS).toISOString(),
      totalSearches,
      failedSearches: repos.historySearches.failedCount(period),
      byMember,
      zeroResultCount,
      zeroResultRate: totalSearches === 0 ? 0 : zeroResultCount / totalSearches,
      zeroResults: page.map((row) => ({
        id: row.id,
        at: row.at,
        member: row.member,
        query: row.query,
        filters: filtersOfRecord(row.filters),
        via: row.via,
      })),
      nextCursor: rows.length > limit && last ? { at: last.at, id: last.id } : null,
    };
  }

  function replaceDocuments(rawInput: HistoryDocumentSnapshot): void {
    const parsed = HistoryDocumentSnapshot.safeParse(rawInput);
    if (!parsed.success) throw invalidRequest(issueText(parsed.error));
    const { projectKey, repo, commit, files } = parsed.data;
    const checkedAt = normalizeAt(parsed.data.checkedAt);
    history.transaction(() => {
      for (const file of files) {
        const entityId = historyDocumentEntityId(repo, file.path);
        const current = history.documentOfEntity(projectKey, 'document', entityId);
        if (file.text === null || file.text === '') {
          const previous = history.docState(projectKey, repo, file.path);
          const indexedAt =
            file.text === null
              ? null
              : !current && previous?.status === 'ready'
                ? (previous.indexedAt ?? checkedAt)
                : checkedAt;
          history.deleteDocument(projectKey, 'document', entityId);
          history.putDocState({
            projectKey,
            repo,
            path: file.path,
            commitSha: commit,
            checkedAt,
            indexedAt,
            status: file.text === null ? 'missing' : 'ready',
          });
          continue;
        }
        // The same text keeps its indexing time: only the commit and the check time move on.
        const unchanged = current !== null && current.body === file.text;
        const indexedAt = unchanged ? current.at : nowIso();
        history.upsertDocument({
          projectKey,
          sourceType: 'document',
          entityId,
          taskKey: null,
          author: null,
          at: indexedAt,
          title: '',
          body: file.text,
          repo,
          path: file.path,
          commitSha: commit,
        });
        history.putDocState({
          projectKey,
          repo,
          path: file.path,
          commitSha: commit,
          checkedAt,
          indexedAt,
          status: 'ready',
        });
      }
    });
  }

  function markDocumentsUnavailable(projectKey: string, repo: string, checkedAtIn: string): void {
    const checkedAt = normalizeAt(checkedAtIn);
    history.transaction(() => {
      for (const path of HISTORY_DOC_PATHS as readonly HistoryDocPath[]) {
        const current = history.documentOfEntity(projectKey, 'document', historyDocumentEntityId(repo, path));
        const state: HistoryDocStateRow | null = history.docState(projectKey, repo, path);
        history.putDocState({
          projectKey,
          repo,
          path,
          commitSha: current ? (current.commitSha ?? state?.commitSha ?? null) : null,
          checkedAt,
          indexedAt: current ? (state?.indexedAt ?? current.at) : null,
          status: current ? 'stale' : 'unavailable',
        });
      }
    });
  }

  function removeRepositoryDocuments(projectKey: string, repo: string): void {
    history.transaction(() => history.deleteRepositoryDocuments(projectKey, repo));
  }

  async function stop(): Promise<void> {
    stopped = true;
    ready = false;
    if (sweepTimer) clearInterval(sweepTimer);
    if (wakeTimer) clearTimeout(wakeTimer);
    sweepTimer = null;
    wakeTimer = null;
    unsubscribe?.();
    unsubscribe = null;
    await initializing;
  }

  return {
    init,
    flush,
    stop,
    search,
    read,
    stats,
    replaceDocuments,
    markDocumentsUnavailable,
    removeRepositoryDocuments,
    documentStates: (projectKey, repo) =>
      history
        .docStates(projectKey)
        .filter((state) => state.repo === repo)
        .map((state) => ({
          repo: state.repo,
          path: state.path,
          commit: state.commitSha,
          checkedAt: state.checkedAt,
          indexedAt: state.indexedAt,
          status: state.status,
        })),
  };
}
