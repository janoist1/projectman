import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryDocumentSnapshot, HistoryDocumentState, ProjectConfig } from '@projectman/shared';
import type { HistoryDocumentReader } from '../../contracts';
import { HistoryDocumentReadSuperseded } from '../../contracts';
import { createHistoryDocumentSync, HISTORY_DOC_POLL_MS, HISTORY_DOC_RETRY_MS } from './document-sync';

const turn = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const snapshot = (commit = 'first'): HistoryDocumentSnapshot => ({
  projectKey: 'AR',
  repo: 'web',
  commit,
  checkedAt: new Date().toISOString(),
  files: [
    { path: 'docs/DECISIONS.md', text: 'decision' },
    { path: 'docs/LESSONS.md', text: 'lesson' },
  ],
});

function harness() {
  let config = {
    project: { key: 'AR', repos: [{ name: 'web', defaultBranch: 'main', path: '.' }] },
    team: { members: [] },
  } as unknown as ProjectConfig;
  let states: HistoryDocumentState[] = [];
  const reader = {
    read: vi.fn<HistoryDocumentReader['read']>(async (_project, _repo, at) =>
      snapshot(at.kind === 'commit' ? at.commit : 'head'),
    ),
    isAncestor: vi.fn<HistoryDocumentReader['isAncestor']>(async () => true),
  };
  const history = {
    documentStates: vi.fn(() => states),
    replaceDocuments: vi.fn((copy: HistoryDocumentSnapshot) => {
      states = copy.files.map((f) => ({
        repo: copy.repo,
        path: f.path,
        commit: copy.commit,
        checkedAt: copy.checkedAt,
        indexedAt: copy.checkedAt,
        status: f.text === null ? 'missing' : 'ready',
      }));
    }),
    markDocumentsUnavailable: vi.fn(() => {
      states = snapshot().files.map((f) => ({
        repo: 'web',
        path: f.path,
        commit: states.find((s) => s.path === f.path)?.commit ?? null,
        checkedAt: new Date().toISOString(),
        indexedAt: null,
        status: states.find((s) => s.path === f.path)?.commit ? 'stale' : 'unavailable',
      }));
    }),
    removeRepositoryDocuments: vi.fn(() => {
      states = [];
    }),
  };
  const projects = { keys: async () => ['AR'], config: vi.fn(async () => config) };
  const logger = { warn: vi.fn(), debug: vi.fn() };
  const sync = createHistoryDocumentSync({ projects, history, reader, logger, now: () => new Date() });
  const moved = (commit: string, base = 'main', repo = 'web') =>
    sync.mainMoved({ projectKey: 'AR', repo, base, commit });
  return {
    sync,
    reader,
    history,
    logger,
    projects,
    moved,
    change: () => {
      config = structuredClone(config);
      return config;
    },
  };
}

describe('history document synchronization', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    vi.useFakeTimers();
    h = harness();
  });
  afterEach(async () => {
    await h.sync.stop();
    vi.useRealTimers();
  });
  const start = async () => {
    await h.sync.init();
    await vi.advanceTimersByTimeAsync(0);
  };

  it('discards a superseded engine result without changing stored state, then retries the head in one minute', async () => {
    await start();
    const rejected = deferred<HistoryDocumentSnapshot>();
    h.reader.read.mockImplementationOnce(async () => {
      await rejected.promise;
      throw new HistoryDocumentReadSuperseded();
    });
    h.moved('second');
    await turn();
    h.moved('third');
    await turn();
    rejected.resolve(snapshot('second'));
    await turn();
    expect(h.reader.read).toHaveBeenCalledTimes(2);
    expect(h.history.replaceDocuments).toHaveBeenCalledTimes(1);
    expect(h.history.markDocumentsUnavailable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HISTORY_DOC_RETRY_MS - 1);
    expect(h.reader.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reader.read).toHaveBeenLastCalledWith('AR', 'web', { kind: 'head' });
  });

  it('preserves a configuration refresh queued while the old engine read is superseded', async () => {
    await start();
    const pending = deferred<HistoryDocumentSnapshot>();
    h.reader.read.mockImplementationOnce(async () => {
      await pending.promise;
      throw new HistoryDocumentReadSuperseded();
    });
    h.moved('second');
    await turn();
    await h.sync.refresh('AR');
    pending.resolve(snapshot('second'));
    await turn();
    expect(h.reader.read).toHaveBeenCalledTimes(3);
    expect(h.reader.read).toHaveBeenLastCalledWith('AR', 'web', { kind: 'head' });
    expect(h.history.replaceDocuments).toHaveBeenCalledTimes(2);
  });

  it('keeps the latest notification when asynchronous configuration lookups finish out of order', async () => {
    await start();
    const config = await h.projects.config();
    const older = deferred<ProjectConfig>();
    h.projects.config.mockReturnValueOnce(older.promise);
    h.moved('older');
    h.moved('newer');
    await turn();
    older.resolve(config);
    await turn();
    expect(h.reader.read).toHaveBeenCalledTimes(2);
    expect(h.history.replaceDocuments).toHaveBeenLastCalledWith(snapshot('newer'));
  });

  it('initializes without waiting for the engine, then polls healthy repositories every ten minutes', async () => {
    const pending = deferred<HistoryDocumentSnapshot>();
    h.reader.read.mockReturnValueOnce(pending.promise);
    await h.sync.init();
    expect(h.reader.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.history.replaceDocuments).not.toHaveBeenCalled();
    pending.resolve(snapshot());
    await turn();
    await vi.advanceTimersByTimeAsync(HISTORY_DOC_POLL_MS - 1);
    expect(h.reader.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reader.read).toHaveBeenCalledTimes(2);
    expect(h.reader.read).toHaveBeenLastCalledWith('AR', 'web', { kind: 'head' });
  });

  it('uses commit reads for default-branch notifications, ignoring other branches and unknown repositories', async () => {
    await start();
    h.moved('wrong', 'feature');
    h.moved('wrong', 'main', 'unknown');
    await turn();
    expect(h.reader.read).toHaveBeenCalledTimes(1);
    h.moved('next');
    await turn();
    expect(h.reader.read).toHaveBeenLastCalledWith('AR', 'web', { kind: 'commit', commit: 'next' });
    expect(h.history.replaceDocuments).toHaveBeenLastCalledWith(snapshot('next'));
  });

  it.each([false, null])('does not replace a newer copy when ancestry is %s', async (ancestry) => {
    await start();
    h.reader.isAncestor.mockResolvedValue(ancestry);
    h.moved('older');
    await turn();
    expect(h.history.replaceDocuments).toHaveBeenCalledTimes(1);
    expect(h.logger.debug).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HISTORY_DOC_POLL_MS);
    expect(h.history.replaceDocuments).toHaveBeenCalledTimes(2);
  });

  it('publishes an identical commit without an ancestry query', async () => {
    await start();
    h.moved('head');
    await turn();
    expect(h.reader.isAncestor).not.toHaveBeenCalled();
    expect(h.history.replaceDocuments).toHaveBeenCalledTimes(2);
  });

  it('keeps only the latest successor commit while a read is running', async () => {
    await start();
    const pending = deferred<HistoryDocumentSnapshot>();
    h.reader.read.mockReturnValueOnce(pending.promise);
    h.moved('second');
    await turn();
    h.moved('third');
    h.moved('fourth');
    h.moved('fifth');
    await turn();
    expect(h.reader.read).toHaveBeenCalledTimes(2);
    pending.resolve(snapshot('second'));
    await turn();
    expect(h.reader.read).toHaveBeenCalledTimes(3);
    expect(h.reader.read).toHaveBeenLastCalledWith('AR', 'web', { kind: 'commit', commit: 'fifth' });
  });

  it('keeps a queued head read stronger than later commit notifications', async () => {
    await start();
    const pending = deferred<HistoryDocumentSnapshot>();
    h.reader.read.mockReturnValueOnce(pending.promise);
    h.moved('second');
    await turn();
    await h.sync.refresh('AR');
    h.moved('third');
    h.moved('fourth');
    await turn();
    pending.resolve(snapshot('second'));
    await turn();
    expect(h.reader.read).toHaveBeenCalledTimes(3);
    expect(h.reader.read).toHaveBeenLastCalledWith('AR', 'web', { kind: 'head' });
    expect(h.history.replaceDocuments).toHaveBeenCalledTimes(2);
  });

  it('marks an offline first read unavailable and retries after one minute, then marks existing text stale', async () => {
    h.reader.read.mockRejectedValueOnce(new Error('offline'));
    await start();
    expect(h.history.markDocumentsUnavailable).toHaveBeenCalledOnce();
    expect(h.history.documentStates()[0]?.status).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(HISTORY_DOC_RETRY_MS - 1);
    expect(h.reader.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.history.documentStates()[0]?.status).toBe('ready');
    h.reader.read.mockRejectedValueOnce(new Error('offline'));
    h.moved('next');
    await turn();
    expect(h.history.documentStates()[0]?.status).toBe('stale');
    await vi.advanceTimersByTimeAsync(HISTORY_DOC_RETRY_MS);
    expect(h.history.documentStates()[0]?.status).toBe('ready');
  });

  it('discards an old reply after configuration changes and reads the new configuration', async () => {
    await start();
    const pending = deferred<HistoryDocumentSnapshot>();
    h.reader.read.mockReturnValueOnce(pending.promise);
    h.moved('second');
    await turn();
    h.change().project.repos[0]!.path = 'new-path';
    await h.sync.refresh('AR');
    pending.resolve(snapshot('second'));
    await turn();
    expect(h.history.replaceDocuments).toHaveBeenCalledTimes(2);
    expect(h.history.replaceDocuments).toHaveBeenLastCalledWith(snapshot('head'));
    expect(h.history.markDocumentsUnavailable).not.toHaveBeenCalled();
  });

  it('removes a repository and rejects its late reply, including after it is re-added', async () => {
    await start();
    const pending = deferred<HistoryDocumentSnapshot>();
    h.reader.read.mockReturnValueOnce(pending.promise);
    h.moved('second');
    await turn();
    const repo = h.change().project.repos.pop()!;
    await h.sync.refresh('AR');
    expect(h.history.removeRepositoryDocuments).toHaveBeenCalledWith('AR', 'web');
    h.change().project.repos.push(repo);
    await h.sync.refresh('AR');
    pending.resolve(snapshot('second'));
    await turn();
    expect(h.history.replaceDocuments).toHaveBeenCalledTimes(2);
    expect(h.history.replaceDocuments).toHaveBeenLastCalledWith(snapshot('head'));
  });

  it('waits for an in-flight read at shutdown and publishes nothing after stop', async () => {
    const pending = deferred<HistoryDocumentSnapshot>();
    h.reader.read.mockReturnValueOnce(pending.promise);
    await start();
    let finished = false;
    const stopped = h.sync.stop().then(() => {
      finished = true;
    });
    await turn();
    expect(finished).toBe(false);
    h.moved('later');
    await h.sync.refresh('AR');
    pending.resolve(snapshot());
    await stopped;
    expect(h.history.replaceDocuments).not.toHaveBeenCalled();
    expect(h.history.markDocumentsUnavailable).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(HISTORY_DOC_POLL_MS);
    expect(h.reader.read).toHaveBeenCalledTimes(1);
  });
});
