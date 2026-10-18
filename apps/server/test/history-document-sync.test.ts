import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BranchMerger } from '../src/contracts';
import { historyHarness, as, OWNER_ACTOR } from './helpers/history';
import { restartDomainHarness, type DomainHarness } from './helpers/domain-harness';

let h: DomainHarness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

function fakeMerger() {
  let head = 'a'.repeat(40);
  let offline = false;
  const trees = new Map([
    [
      head,
      { decisions: '# Decisions\n\nAlpaca decision', lessons: '# Lessons\n\nAlpaca lesson' } as {
        decisions: string | null;
        lessons: string | null;
      },
    ],
  ]);
  const readFile = vi.fn<BranchMerger['readFile']>(async (_ref, input) => {
    if (offline) throw new Error('offline');
    const commit = 'commit' in input.at ? input.at.commit : head;
    const tree = trees.get(commit)!;
    return { commit, text: input.path === 'docs/DECISIONS.md' ? tree.decisions : tree.lessons };
  });
  const merger = { readFile, isAncestor: vi.fn(async () => true) } as unknown as BranchMerger;
  return {
    merger,
    readFile,
    setOffline: () => {
      offline = true;
    },
    set: (commit: string, decisions: string | null, lessons: string | null) => {
      head = commit;
      trees.set(head, { decisions, lessons });
    },
  };
}
const search = () => h!.domain.history.search('AR', as('owner'), { query: 'alpaca' });
const publish = (commit: string, mergeCommit?: string) =>
  h!.domain.bus.publish({
    type: 'timeline_appended',
    projectKey: 'AR',
    event: {
      id: 'event',
      projectKey: 'AR',
      taskKey: 'AR-1',
      sessionId: null,
      actor: OWNER_ACTOR,
      type: 'task_merged',
      createdAt: new Date().toISOString(),
      data: {
        via: 'tool',
        repo: 'web',
        base: 'main',
        commit,
        ...(mergeCommit ? { mergeCommit } : {}),
        at: new Date().toISOString(),
      },
    },
  });

describe('history document copy through the domain', () => {
  it('searches and reads synchronized copies, preserves indexing time, removes missing files and keeps database sources fresh offline', async () => {
    const engine = fakeMerger();
    h = await historyHarness({ merger: engine.merger });
    await vi.waitFor(() => expect(search().matches).toHaveLength(2));
    const first = search();
    for (const hit of first.matches) {
      expect(hit.document).toMatchObject({ repo: 'web', commit: 'a'.repeat(40), line: 3 });
      expect(
        h.domain.history.read('AR', as('owner'), {
          sourceId: hit.sourceId,
          commit: hit.document!.commit,
          fromLine: 3,
        }).text,
      ).toMatch(/^Alpaca (decision|lesson)$/);
    }
    expect(h.domain.history.search('AR', as('acme'), { query: 'alpaca' })).toMatchObject({
      matches: [],
      documents: [],
    });
    const indexed = first.documents.map((s) => s.indexedAt);
    engine.readFile.mockClear();
    const second = 'b'.repeat(40);
    engine.set(second, '# Decisions\n\nAlpaca decision', '# Lessons\n\nAlpaca lesson');
    publish('branch-commit', second);
    await vi.waitFor(() => expect(search().documents.every((s) => s.commit === second)).toBe(true));
    expect(engine.readFile.mock.calls.map(([, input]) => input.at)).toEqual([
      { commit: second },
      { commit: second },
    ]);
    expect(search().documents.map((s) => s.indexedAt)).toEqual(indexed);
    const third = 'c'.repeat(40);
    engine.set(third, null, '# Lessons\n\nAlpaca lesson');
    publish(third);
    await vi.waitFor(() => expect(search().matches).toHaveLength(1));
    expect(search().documents.find((s) => s.path === 'docs/DECISIONS.md')?.status).toBe('missing');
    await h.domain.tasks.create('AR', { title: 'Alpaca database source' }, OWNER_ACTOR);
    engine.setOffline();
    publish('d'.repeat(40));
    await vi.waitFor(() =>
      expect(search().documents.find((s) => s.path === 'docs/LESSONS.md')?.status).toBe('stale'),
    );
    expect(
      search()
        .matches.map((m) => m.sourceType)
        .sort(),
    ).toEqual(['document', 'task']);
  });

  it('retains the last searchable snapshot across an offline restart', async () => {
    const engine = fakeMerger();
    h = await historyHarness({ merger: engine.merger, persistent: true });
    await vi.waitFor(() => expect(search().matches).toHaveLength(2));
    const commits = search().documents.map((s) => s.commit);
    h = await restartDomainHarness(h, { merger: null });
    await vi.waitFor(() => expect(search().documents.every((s) => s.status === 'stale')).toBe(true));
    expect(search().matches).toHaveLength(2);
    expect(search().documents.map((s) => s.commit)).toEqual(commits);
  });
});
