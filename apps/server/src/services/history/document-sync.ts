import type { ProjectConfig } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { HistoryDocAt, HistoryDocumentReader, HistoryMainMoved, HistoryService } from '../../contracts';
import { HistoryDocumentReadSuperseded } from '../../contracts';

export const HISTORY_DOC_POLL_MS = 600_000;
export const HISTORY_DOC_RETRY_MS = 60_000;

export interface HistoryDocumentSyncDeps {
  projects: { keys: () => Promise<string[]>; config: (projectKey: string) => Promise<ProjectConfig> };
  reader: HistoryDocumentReader;
  history: Pick<
    HistoryService,
    'replaceDocuments' | 'markDocumentsUnavailable' | 'removeRepositoryDocuments' | 'documentStates'
  >;
  logger: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
  now: () => Date;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export interface HistoryDocumentSync {
  init(): Promise<void>;
  refresh(projectKey: string): Promise<void>;
  mainMoved(event: HistoryMainMoved): void;
  stop(): Promise<void>;
}

interface Slot {
  projectKey: string;
  repo: string;
  config: string;
  generation: number;
  active: boolean;
  pending: HistoryDocAt | null;
  running: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  lastNotification: number;
  retry: boolean;
}

/** One running read and at most one successor per repository; searches never enter this path. */
export function createHistoryDocumentSync(deps: HistoryDocumentSyncDeps): HistoryDocumentSync {
  const timers = deps.timers ?? { setTimeout, clearTimeout };
  const slots = new Map<string, Slot>();
  const revisions = new Map<string, number>();
  const controls = new Set<Promise<void>>();
  let stopped = false;
  let initialized = false;
  let notification = 0;

  const keyOf = (projectKey: string, repo: string) => JSON.stringify([projectKey, repo]);
  const revisionOf = (projectKey: string) => revisions.get(projectKey) ?? 0;

  function cancelTimer(slot: Slot): void {
    if (slot.timer !== null) timers.clearTimeout(slot.timer);
    slot.timer = null;
  }

  function schedule(slot: Slot, delay?: number): void {
    if (stopped || !slot.active) return;
    cancelTimer(slot);
    const states = deps.history.documentStates(slot.projectKey, slot.repo);
    const retry =
      slot.retry ||
      states.length < 2 ||
      states.some((s) => ['pending', 'stale', 'unavailable'].includes(s.status));
    slot.timer = timers.setTimeout(
      () => {
        slot.timer = null;
        enqueue(slot, { kind: 'head' });
      },
      delay ?? (retry ? HISTORY_DOC_RETRY_MS : HISTORY_DOC_POLL_MS),
    );
    slot.timer.unref?.();
  }

  async function current(slot: Slot, generation: number, config: string): Promise<boolean> {
    if (stopped || !slot.active || slot.generation !== generation) return false;
    const latest = await deps.projects.config(slot.projectKey);
    return !stopped && slot.active && slot.generation === generation && JSON.stringify(latest) === config;
  }

  async function read(slot: Slot, at: HistoryDocAt): Promise<void> {
    const { generation, config, projectKey, repo } = slot;
    slot.retry = false;
    try {
      if (!(await current(slot, generation, config))) return;
      const snapshot = await deps.reader.read(projectKey, repo, at);
      if (at.kind === 'commit') {
        const commits = new Set(
          deps.history.documentStates(projectKey, repo).flatMap((s) => (s.commit ? [s.commit] : [])),
        );
        for (const commit of commits) {
          if (
            commit !== snapshot.commit &&
            (await deps.reader.isAncestor(projectKey, repo, {
              ancestor: commit,
              commit: snapshot.commit,
            })) !== true
          ) {
            deps.logger.debug(
              { projectKey, repo, commit: snapshot.commit },
              'skipping a history document commit that does not follow the stored copy',
            );
            return;
          }
        }
      }
      if (
        (await current(slot, generation, config)) &&
        !stopped &&
        slot.active &&
        slot.generation === generation
      )
        deps.history.replaceDocuments(snapshot);
    } catch (err) {
      if (err instanceof HistoryDocumentReadSuperseded) {
        deps.logger.debug(
          { projectKey, repo },
          'discarding a history document reply from a superseded engine',
        );
        if (slot.generation === generation) {
          slot.retry = true;
          slot.pending = null;
        }
        return;
      }
      if (
        (await current(slot, generation, config).catch(() => false)) &&
        !stopped &&
        slot.active &&
        slot.generation === generation
      ) {
        deps.logger.warn({ err, projectKey, repo }, 'history documents could not be refreshed');
        deps.history.markDocumentsUnavailable(projectKey, repo, deps.now().toISOString());
      }
    }
  }

  function enqueue(slot: Slot, at: HistoryDocAt): void {
    if (stopped || !slot.active) return;
    cancelTimer(slot);
    // A head read is authoritative and cannot be displaced by a commit notification.
    if (slot.pending?.kind !== 'head') slot.pending = at;
    if (slot.running) return;
    slot.running = (async () => {
      while (!stopped && slot.active && slot.pending) {
        const next = slot.pending;
        slot.pending = null;
        await read(slot, next);
      }
    })()
      .catch((err: unknown) => {
        deps.logger.warn(
          { err, projectKey: slot.projectKey, repo: slot.repo },
          'history document synchronization failed',
        );
      })
      .finally(() => {
        slot.running = null;
        if (!slot.active) slots.delete(keyOf(slot.projectKey, slot.repo));
        else if (slot.pending) enqueue(slot, slot.pending);
        else schedule(slot);
      });
  }

  function track(operation: Promise<void>): Promise<void> {
    controls.add(operation);
    void operation.finally(() => controls.delete(operation));
    return operation;
  }

  function refresh(projectKey: string): Promise<void> {
    if (stopped) return Promise.resolve();
    const revision = revisionOf(projectKey) + 1;
    revisions.set(projectKey, revision);
    // Invalidate before the first await, including a read whose engine reply is already queued.
    for (const slot of slots.values()) {
      if (slot.projectKey === projectKey) {
        slot.generation++;
        slot.pending = null;
        cancelTimer(slot);
      }
    }
    return track(
      (async () => {
        try {
          const config = await deps.projects.config(projectKey);
          if (stopped || revision !== revisionOf(projectKey)) return;
          const repos = new Set(config.project.repos.map((repo) => repo.name));
          for (const slot of slots.values()) {
            if (slot.projectKey !== projectKey || repos.has(slot.repo)) continue;
            slot.active = false;
            deps.history.removeRepositoryDocuments(projectKey, slot.repo);
            if (!slot.running) slots.delete(keyOf(projectKey, slot.repo));
          }
          for (const repo of repos) {
            const key = keyOf(projectKey, repo);
            let slot = slots.get(key);
            if (!slot) {
              slot = {
                projectKey,
                repo,
                config: '',
                generation: 0,
                active: true,
                pending: null,
                running: null,
                timer: null,
                lastNotification: 0,
                retry: false,
              };
              slots.set(key, slot);
            }
            slot.active = true;
            slot.config = JSON.stringify(config);
            if (slot.running) enqueue(slot, { kind: 'head' });
            else schedule(slot, 0);
          }
        } catch (err) {
          deps.logger.warn({ err, projectKey }, 'history document configuration could not be refreshed');
        }
      })(),
    );
  }

  function mainMoved(event: HistoryMainMoved): void {
    if (stopped) return;
    const revision = revisionOf(event.projectKey);
    const order = ++notification;
    void track(
      (async () => {
        try {
          const config = await deps.projects.config(event.projectKey);
          if (stopped || revision !== revisionOf(event.projectKey)) return;
          const repo = config.project.repos.find((r) => r.name === event.repo);
          if (!repo || repo.defaultBranch !== event.base) return;
          const slot = slots.get(keyOf(event.projectKey, event.repo));
          if (slot && order > slot.lastNotification) {
            slot.lastNotification = order;
            enqueue(slot, { kind: 'commit', commit: event.commit });
          }
        } catch (err) {
          deps.logger.debug(
            { err, projectKey: event.projectKey, repo: event.repo },
            'history document notification could not be read',
          );
        }
      })(),
    );
  }

  return {
    async init() {
      if (initialized || stopped) return;
      initialized = true;
      for (const projectKey of await deps.projects.keys()) await refresh(projectKey);
    },
    refresh,
    mainMoved,
    async stop() {
      stopped = true;
      for (const slot of slots.values()) {
        cancelTimer(slot);
        slot.pending = null;
      }
      await Promise.all([...controls, ...[...slots.values()].flatMap((s) => (s.running ? [s.running] : []))]);
    },
  };
}
