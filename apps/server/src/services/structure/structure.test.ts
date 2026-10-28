import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { ProjectConfig, Task } from '@projectman/shared';
import { MergeError } from '../../contracts';
import type { BranchMerger, EngineDirectory, EngineHost } from '../../contracts';
import { createStructureService } from './index';
const start = Date.parse('2026-10-14T12:00:00Z');
const map = {
  version: 1,
  areas: [{ id: 'app', name: 'App' }],
  modules: [{ id: 'app', area: 'app', name: 'App', summary: 'Application', paths: ['src/'] }],
  ignore: ['ignored/'],
};
const card = (key: string, extra: Partial<Task> = {}): Task =>
  ({
    key,
    repo: 'app',
    status: 'active',
    updatedAt: new Date(start).toISOString(),
    links: [{ kind: 'branch', ref: key }],
    ...extra,
  }) as Task;
function harness(tasks: Task[] = []) {
  let time = start;
  const config = {
    project: { repos: [{ name: 'app', defaultBranch: 'main' }] },
    team: { members: [] },
  } as unknown as ProjectConfig;
  const listPaths = vi.fn(async () => ({
    commit: 'base',
    paths: ['src/a.ts', 'ignored/a', 'other'],
    truncated: false,
  }));
  const readFile = vi.fn(async (): Promise<{ commit: string; text: string | null }> => ({
    commit: 'base',
    text: stringify(map),
  }));
  const changedPaths = vi.fn<BranchMerger['changedPaths']>(async (_ref, input) =>
    input.items.map((item) => ({
      id: item.id,
      ok: true as const,
      commit: 'merge' in item.at ? item.at.merge : 'head',
      paths: ['src/a.ts', 'other'],
      truncated: false,
    })),
  );
  const merger = { listPaths, readFile, changedPaths } as unknown as BranchMerger;
  const remoteChanged = vi.fn<BranchMerger['changedPaths']>(async (ref, input) => changedPaths(ref, input));
  const engines = {
    get: vi.fn(
      (id: string) =>
        ({ merger: id === 'remote' ? { ...merger, changedPaths: remoteChanged } : merger }) as EngineHost,
    ),
    engineFor: vi.fn(() => 'local'),
  } as unknown as EngineDirectory;
  const sessions = {
    cardEngineId: vi.fn((_key: string, task: Task) => (task.key === 'AR-2' ? 'remote' : 'local')),
  };
  const logger = { warn: vi.fn() };
  const service = createStructureService({
    projects: { config: async () => config },
    tasks: { list: () => tasks },
    engines,
    sessions,
    logger,
    now: () => time,
  });
  return {
    service,
    listPaths,
    readFile,
    changedPaths,
    remoteChanged,
    engines,
    sessions,
    config,
    logger,
    advance: () => {
      time += 30_000;
    },
  };
}
describe('structure service', () => {
  it.each([
    ['merge_not_allowed', 'not_allowed'],
    ['repo_not_registered', 'not_allowed'],
    ['link_down', 'engine_offline'],
    ['timeout', 'engine_offline'],
    ['internal', 'failed'],
  ])('classifies %s and logs no error text', async (linkCode, reason) => {
    const h = harness();
    h.readFile.mockRejectedValue(Object.assign(new Error('sensitive text'), { linkCode, code: 'different' }));
    expect((await h.service.view('AR')).repos[0]).toMatchObject({
      status: 'unavailable',
      reason,
      commit: null,
      problem: null,
    });
    expect(h.logger.warn).toHaveBeenCalledWith(
      { projectKey: 'AR', repo: 'app', engine: 'local', code: linkCode, tasks: [] },
      'Structure repository read failed',
    );
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain('sensitive text');
  });
  it('uses the coordinator engine for base reads and preserves repository order', async () => {
    const h = harness();
    h.config.team.members.push({
      kind: 'ai',
      handle: 'pm',
      role: 'project_manager',
    } as ProjectConfig['team']['members'][number]);
    h.config.project.repos.push({ ...h.config.project.repos[0]!, name: 'second' });
    vi.mocked(h.engines.engineFor).mockReturnValue('remote');
    expect((await h.service.view('AR')).repos.map((r) => r.repo)).toEqual(['app', 'second']);
    expect(h.engines.engineFor).toHaveBeenCalledWith('AR', 'pm');
    expect(h.engines.get).toHaveBeenCalledWith('remote');
  });
  it('limits cards to 300, prioritizing review then latest branch cards', async () => {
    const tasks = Array.from({ length: 302 }, (_, i) =>
      card(`AR-${i + 10}`, { updatedAt: new Date(start + i * 1000).toISOString() }),
    );
    tasks.push(card('AR-1', { reviewPin: { commit: 'pin', branch: 'branch', pinnedAt: '' } }));
    const h = harness(tasks);
    const cards = (await h.service.view('AR')).repos[0]!.cards;
    expect(cards).toHaveLength(300);
    expect(cards[0]!.taskKey).toBe('AR-1');
    expect(cards[1]!.taskKey).toBe('AR-311');
    expect(cards.some((c) => c.taskKey === 'AR-10')).toBe(false);
  });
  it('limits unmapped examples and preserves truncation', async () => {
    const h = harness([card('AR-1')]);
    const paths = Array.from({ length: 15 }, (_, i) => `unknown-${i}`);
    h.listPaths.mockResolvedValue({ commit: 'base', paths, truncated: true });
    h.changedPaths.mockResolvedValue([{ id: 'AR-1', ok: true, commit: 'head', paths, truncated: true }]);
    const repo = (await h.service.view('AR')).repos[0]!;
    expect(repo.unmapped).toEqual({ count: 15, examples: paths.slice(0, 10) });
    expect(repo.truncated).toBe(true);
    expect(repo.cards[0]!.unmapped).toEqual(paths.slice(0, 10));
    expect(repo.cards[0]!.truncated).toBe(true);
  });
  it('reads the descriptor at the listed commit and builds placement', async () => {
    const h = harness([card('AR-1')]);
    const repo = (await h.service.view('AR')).repos[0]!;
    expect(h.readFile).toHaveBeenCalledWith(
      { projectKey: 'AR', repo: 'app' },
      { at: { commit: 'base' }, path: 'projectman.structure.yaml' },
    );
    expect(repo).toMatchObject({
      status: 'ok',
      commit: 'base',
      reason: null,
      sizes: [{ id: 'app', files: 1 }],
      unmapped: { count: 1, examples: ['other'] },
      cards: [
        {
          taskKey: 'AR-1',
          source: 'branch',
          files: 2,
          modules: [{ id: 'app', files: 1 }],
          unmapped: ['other'],
        },
      ],
    });
  });
  it('reports missing and invalid YAML or schema', async () => {
    for (const [text, status] of [
      [null, 'missing'],
      ['[broken', 'invalid'],
      ['version: 2', 'invalid'],
    ] as const) {
      const h = harness();
      h.readFile.mockResolvedValue({ commit: 'base', text });
      const repo = (await h.service.view('AR')).repos[0]!;
      expect(repo).toMatchObject({ status, map: null, sizes: [], cards: [], commit: 'base' });
      if (status === 'invalid') expect(repo.problem!.length).toBeLessThanOrEqual(500);
    }
  });
  it('reports absent engines and base read failures', async () => {
    const h = harness();
    vi.mocked(h.engines.get).mockReturnValue(null);
    expect((await h.service.view('AR')).repos[0]).toMatchObject({
      status: 'unavailable',
      reason: 'engine_offline',
      commit: null,
    });
    const failed = harness();
    failed.listPaths.mockRejectedValue(new MergeError('git_failed', 'private error'));
    expect((await failed.service.view('AR')).repos[0]).toMatchObject({
      status: 'unavailable',
      reason: 'failed',
      problem: null,
    });
  });
  it('prefers review pins, latest branch links and the 14 day boundary', async () => {
    const merged = (days: number) =>
      ({
        mergeCommit: `merge-${days}`,
        at: new Date(start - days * 86_400_000).toISOString(),
      }) as Task['merged'];
    const h = harness([
      card('AR-1', {
        links: [
          { kind: 'branch', ref: 'old' },
          { kind: 'branch', ref: 'new' },
        ],
      }),
      card('AR-2', { reviewPin: { commit: 'pinned', branch: 'branch', pinnedAt: '' } }),
      card('AR-3', { status: 'done', merged: merged(14) }),
      card('AR-4', { status: 'done', merged: merged(15) }),
      card('AR-5', { status: 'cancelled' }),
      card('AR-6', { repo: 'other' }),
    ]);
    const repo = (await h.service.view('AR')).repos[0]!;
    expect(repo.cards.map((c) => [c.taskKey, c.source])).toEqual([
      ['AR-2', 'review'],
      ['AR-1', 'branch'],
      ['AR-3', 'merge'],
    ]);
    expect(h.remoteChanged.mock.calls[0]![1].items).toEqual([{ id: 'AR-2', at: { commit: 'pinned' } }]);
    expect(h.changedPaths.mock.calls.flatMap((call) => call[1].items)).toContainEqual({
      id: 'AR-1',
      at: { branch: 'new' },
    });
  });
  it('batches by 25 and isolates failed batches and items', async () => {
    const h = harness(Array.from({ length: 52 }, (_, i) => card(`AR-${i + 10}`)));
    h.changedPaths.mockRejectedValueOnce(new Error('private error'));
    h.changedPaths.mockResolvedValueOnce([{ id: 'AR-35', ok: false, reason: 'unknown' }]);
    const repo = (await h.service.view('AR')).repos[0]!;
    expect(h.changedPaths.mock.calls.map((call) => call[1].items.length)).toEqual([25, 25, 2]);
    expect(repo.status).toBe('ok');
    expect(repo.cards.map((c) => c.taskKey)).toEqual(['AR-60', 'AR-61']);
    expect(h.logger.warn.mock.calls).toHaveLength(2);
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain('private error');
  });
  it('shares requests and reuses immutable merge paths with a new map', async () => {
    const h = harness([
      card('AR-1', {
        status: 'done',
        merged: { mergeCommit: 'merged', at: new Date(start).toISOString() } as Task['merged'],
      }),
    ]);
    const [a, b] = await Promise.all([h.service.view('AR'), h.service.view('AR')]);
    expect(a).toBe(b);
    expect(h.listPaths).toHaveBeenCalledTimes(1);
    await h.service.view('AR');
    expect(h.listPaths).toHaveBeenCalledTimes(1);
    h.advance();
    h.readFile.mockResolvedValue({
      commit: 'base',
      text: stringify({ ...map, modules: [{ ...map.modules[0], id: 'renamed' }] }),
    });
    const next = await h.service.view('AR');
    expect(h.listPaths).toHaveBeenCalledTimes(2);
    expect(h.changedPaths).toHaveBeenCalledTimes(1);
    expect(next.repos[0]!.cards[0]!.modules).toEqual([{ id: 'renamed', files: 1 }]);
  });
  it('evicts the oldest merge after 5000 entries and scopes caches by project', async () => {
    const tasks: Task[] = [];
    const h = harness(tasks);
    const merged = (i: number) =>
      card(`AR-${i + 1}`, {
        status: 'done',
        merged: { mergeCommit: `merge-${i}`, at: new Date(start).toISOString() } as Task['merged'],
      });
    for (let i = 0; i < 5100; i += 300) {
      tasks.splice(0, tasks.length, ...Array.from({ length: 300 }, (_, j) => merged(i + j)));
      await h.service.view('AR');
      h.advance();
    }
    h.changedPaths.mockClear();
    tasks.splice(0, tasks.length, merged(0), merged(5099));
    await h.service.view('AR');
    expect(h.changedPaths.mock.calls.flatMap((call) => call[1].items).map((item) => item.id)).toEqual([
      'AR-1',
    ]);
    await h.service.view('OTHER');
    expect(h.changedPaths.mock.calls.at(-1)![1].items).toHaveLength(2);
  });
});
