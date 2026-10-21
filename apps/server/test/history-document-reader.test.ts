import { describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import type { BranchMerger, EngineDirectory, EngineHost } from '../src/contracts';
import { createHistoryDocumentReader } from '../src/assembly';
import { HistoryDocumentReadSuperseded } from '../src/contracts';

function harness(operator = true) {
  const config = {
    project: { key: 'AR', repos: [{ name: 'web', defaultBranch: 'main', path: '.' }] },
    team: { members: operator ? [{ kind: 'ai', handle: 'operator', role: 'ai_operator' }] : [] },
  } as unknown as ProjectConfig;
  const merger = {
    readFile: vi.fn<BranchMerger['readFile']>(async (_ref, input) => ({
      commit: 'commit' in input.at ? input.at.commit : 'first',
      text: input.path,
    })),
    isAncestor: vi.fn<BranchMerger['isAncestor']>(async () => null),
  };
  const engines = {
    engineFor: vi.fn(() => 'remote'),
    ids: vi.fn(() => ['remote']),
    get: vi.fn((id: string) => (id === 'remote' ? ({ merger } as unknown as EngineHost) : null)),
    onChange: vi.fn(),
  } as unknown as EngineDirectory;
  const projects = { config: async () => config, cachedConfig: () => config };
  const reader = createHistoryDocumentReader({
    projects,
    engines,
    now: () => new Date('2026-10-18T12:00:00Z'),
  });
  return { config, reader, merger, engines };
}

describe('history engine reader', () => {
  it.each([false, true])(
    'discards an engine reply after reassignment, including failures (%s)',
    async (failure) => {
      const h = harness();
      h.merger.readFile.mockImplementation(async (_ref, input) => {
        vi.mocked(h.engines.engineFor).mockReturnValue('other');
        if (failure) throw new Error('old engine failed');
        return { commit: 'fixed', text: input.path };
      });
      await expect(h.reader.read('AR', 'web', { kind: 'head' })).rejects.toBeInstanceOf(
        HistoryDocumentReadSuperseded,
      );
    },
  );

  it.each([false, true])(
    'checks the engine assignment after ancestry queries, including failures (%s)',
    async (failure) => {
      const h = harness();
      h.merger.isAncestor.mockImplementation(async () => {
        vi.mocked(h.engines.engineFor).mockReturnValue('other');
        if (failure) throw new Error('old engine failed');
        return true;
      });
      await expect(
        h.reader.isAncestor('AR', 'web', { ancestor: 'old', commit: 'new' }),
      ).rejects.toBeInstanceOf(HistoryDocumentReadSuperseded);
    },
  );

  it('pins the second path to the first result even when the head moves between reads', async () => {
    const h = harness();
    let head = 'first';
    h.merger.readFile.mockImplementation(async (_ref, input) => {
      const commit = 'commit' in input.at ? input.at.commit : head;
      head = 'second';
      return { commit, text: `${input.path} at ${commit}` };
    });
    expect(await h.reader.read('AR', 'web', { kind: 'head' })).toMatchObject({
      commit: 'first',
      files: [
        { path: 'docs/DECISIONS.md', text: 'docs/DECISIONS.md at first' },
        { path: 'docs/LESSONS.md', text: 'docs/LESSONS.md at first' },
      ],
    });
    expect(h.merger.readFile.mock.calls.map(([, input]) => input.at)).toEqual([
      { base: 'main' },
      { commit: 'first' },
    ]);
    expect(h.engines.engineFor).toHaveBeenCalledWith('AR', 'operator');
  });

  it('reads a commit without a base read and retains a missing first file', async () => {
    const h = harness();
    h.merger.readFile.mockResolvedValueOnce({ commit: 'fixed', text: null });
    expect(await h.reader.read('AR', 'web', { kind: 'commit', commit: 'fixed' })).toMatchObject({
      commit: 'fixed',
      files: [
        { path: 'docs/DECISIONS.md', text: null },
        { path: 'docs/LESSONS.md', text: 'docs/LESSONS.md' },
      ],
    });
    expect(h.merger.readFile.mock.calls.map(([, input]) => input.at)).toEqual([
      { commit: 'fixed' },
      { commit: 'fixed' },
    ]);
    expect(await h.reader.isAncestor('AR', 'web', { ancestor: 'old', commit: 'new' })).toBeNull();
    expect(h.merger.isAncestor).toHaveBeenCalledWith(
      { projectKey: 'AR', repo: 'web' },
      { ancestor: 'old', commit: 'new' },
    );
  });

  it('never falls back to local git when the selected remote engine is offline', async () => {
    const h = harness();
    vi.mocked(h.engines.get).mockReturnValue(null);
    await expect(h.reader.read('AR', 'web', { kind: 'head' })).rejects.toMatchObject({
      code: 'engine_offline',
    });
    expect(h.engines.get).toHaveBeenCalledWith('remote');
    expect(h.merger.readFile).not.toHaveBeenCalled();
  });

  it('only uses the local fallback if a local engine is actually registered', async () => {
    const h = harness(false);
    await expect(h.reader.read('AR', 'web', { kind: 'head' })).rejects.toMatchObject({
      code: 'engine_offline',
    });
    expect(h.engines.get).not.toHaveBeenCalled();
    vi.mocked(h.engines.ids).mockReturnValue(['local']);
    vi.mocked(h.engines.get).mockReturnValue({ merger: h.merger } as unknown as EngineHost);
    await h.reader.read('AR', 'web', { kind: 'head' });
    expect(h.engines.get).toHaveBeenCalledWith('local');
  });

  it('rejects repositories outside the project configuration before reading git', async () => {
    const h = harness();
    await expect(h.reader.read('AR', 'unknown', { kind: 'head' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(h.merger.readFile).not.toHaveBeenCalled();
  });
});
