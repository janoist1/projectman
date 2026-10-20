import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_EXCERPT_MAX_CHARS, HistorySearchResult } from '@projectman/shared';
import type { HistorySearchInput, HistoryViewer } from '@projectman/shared';
import type { DomainHarness } from './helpers/domain-harness';
import type { BranchMerger } from '../src/contracts';
import { as, historyHarness, OWNER_ACTOR } from './helpers/history';

const OWNER: HistoryViewer = { handle: 'owner', access: 'owner' };
const COMMIT = 'a'.repeat(40);
const COMMIT_2 = 'b'.repeat(40);

describe('history search behaviour', () => {
  let h: DomainHarness;
  const search = (input: Partial<HistorySearchInput> & { query: string }, viewer = OWNER) =>
    h.domain.history.search('AR', viewer, input);
  const task = async (
    title: string,
    description = '',
    extra: { visibility?: 'shared' | 'internal' } = {},
  ) => {
    const created = await h.domain.tasks.create('AR', { title, description, ...extra }, OWNER_ACTOR);
    h.domain.history.flush();
    return created;
  };
  const excerpts = async (input: Partial<HistorySearchInput> & { query: string }, viewer = OWNER) =>
    (await search(input, viewer)).matches.map((match) => match.excerpt);

  let clock: Date;
  beforeEach(async () => {
    clock = new Date('2026-10-01T09:00:00.000Z');
    h = await historyHarness({ now: () => clock });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.cleanup();
  });

  describe('words', () => {
    it('matches the base form and the inflected forms in both directions, with or without accents', async () => {
      await task('A beállítás oldala');
      await task('A beállításnál hiba van');
      await task('Egy beállítást javítunk');
      await task('Teljesen más szöveg');
      for (const query of [
        'beallitas',
        'beállítás',
        'BEÁLLÍTÁS',
        'beállítást',
        'beállításnál',
        'beallitasnal',
      ]) {
        expect((await excerpts({ query })).sort(), query).toEqual([
          'A beállítás oldala',
          'A beállításnál hiba van',
          'Egy beállítást javítunk',
        ]);
      }
    });

    it('finds a word by its start only, and ANDs the words', async () => {
      await task('Release notes for the checkout');
      await task('Checkout redesign');
      expect(await excerpts({ query: 'chec' })).toHaveLength(2);
      expect(await excerpts({ query: 'eckout' })).toEqual([]);
      expect(await excerpts({ query: 'release checkout' })).toEqual(['Release notes for the checkout']);
    });

    it('does not cut a suffix off a short word', async () => {
      await task('Hat szürke egér');
      await task('Ha ma jó idő van');
      expect(await excerpts({ query: 'hat' })).toEqual(['Hat szürke egér']);
    });

    it.each([
      '"',
      '""',
      '*',
      'a*',
      '"unterminated',
      'OR',
      'AND NOT',
      'NEAR(a b)',
      'title:alpha',
      '^alpha',
      'alpha -beta',
      '(alpha',
      'alpha)',
      "alpha' OR '1'='1",
      'alpha; DROP TABLE history_documents',
      '{title body}: alpha',
    ])('treats %j as plain text and never as query syntax or an error', async (query) => {
      await task('alpha beta');
      const run = search({ query });
      if (/[\p{L}\p{N}]/u.test(query)) await expect(run).resolves.toBeDefined();
      else
        await expect(run).rejects.toThrowError(
          expect.objectContaining({ status: 422, code: 'invalid_request' }),
        );
      expect((await search({ query: 'alpha' })).matches).toHaveLength(1);
    });

    it('refuses a query without a word or with more than twelve', async () => {
      const invalid = expect.objectContaining({ status: 422, code: 'invalid_request' });
      await expect(search({ query: '   ' })).rejects.toThrowError(invalid);
      await expect(search({ query: '- * "' })).rejects.toThrowError(invalid);
      await expect(search({ query: 'a b c d e f g h i j k l m' })).rejects.toThrowError(invalid);
      await expect(search({ query: 'x'.repeat(401) })).rejects.toThrowError(invalid);
      await expect(search({ query: 'a b c d e f g h i j k l' })).resolves.toBeDefined();
    });
  });

  describe('input', () => {
    it('refuses a bad filter with 422', async () => {
      const invalid = expect.objectContaining({ status: 422, code: 'invalid_request' });
      const bad: Array<Partial<HistorySearchInput>> = [
        { limit: 0 },
        { limit: 51 },
        { limit: 1.5 },
        { sourceTypes: [] },
        { sourceTypes: ['task', 'task'] },
        { sourceTypes: ['bogus' as never] },
        { since: 'yesterday' },
        { since: '2026-10-01T10:00:00' },
        { since: '2026-10-02T10:00:00Z', until: '2026-10-01T10:00:00Z' },
        { taskKey: 'not a key' },
      ];
      for (const input of bad)
        await expect(search({ query: 'alpha', ...input }), JSON.stringify(input)).rejects.toThrowError(
          invalid,
        );
      await expect(
        search({ query: 'alpha', since: '2026-10-01T10:00:00Z', until: '2026-10-01T10:00:00Z' }),
      ).resolves.toBeDefined();
      await expect(search({ query: 'alpha', since: '2026-10-01T12:00:00+02:00' })).resolves.toBeDefined();
    });

    it('answers an unknown card, and a card the viewer cannot see, with not found', async () => {
      await task('alpha internal');
      const missing = expect.objectContaining({ status: 404, code: 'not_found' });
      await expect(search({ query: 'alpha', taskKey: 'AR-99' })).rejects.toThrowError(missing);
      await expect(search({ query: 'alpha', taskKey: 'AR-1' }, as('acme'))).rejects.toThrowError(missing);
      expect((await search({ query: 'alpha', taskKey: 'AR-1' })).matches).toHaveLength(1);
    });

    it('treats an empty result as a success', async () => {
      expect(await search({ query: 'nothingmatches' })).toEqual({
        projectKey: 'AR',
        matches: [],
        hasMore: false,
        documents: expect.any(Array),
      });
    });
  });

  describe('filters, order and limit', () => {
    it('filters by card and by source type', async () => {
      const first = await task('alpha one');
      await task('alpha two');
      await h.domain.tasks.addNote('AR', first.key, 'alpha note', OWNER_ACTOR);
      h.domain.history.flush();
      expect((await search({ query: 'alpha' })).matches).toHaveLength(3);
      expect((await search({ query: 'alpha', taskKey: first.key })).matches).toHaveLength(2);
      expect(
        (await search({ query: 'alpha', sourceTypes: ['note'] })).matches.map((m) => m.sourceType),
      ).toEqual(['note']);
      expect(
        (await search({ query: 'alpha', sourceTypes: ['note', 'task'], taskKey: first.key })).matches,
      ).toHaveLength(2);
      expect((await search({ query: 'alpha', sourceTypes: ['message'] })).matches).toEqual([]);
    });

    it('filters by time, both ends inclusive, in any zone', async () => {
      for (const hour of [10, 11, 12]) {
        clock = new Date(Date.UTC(2026, 9, 1, hour));
        await task(`alpha at ${hour}`);
      }
      const hours = async (input: Partial<HistorySearchInput>) =>
        (await search({ query: 'alpha', ...input })).matches.map((hit) => hit.excerpt).sort();
      expect(await hours({})).toEqual(['alpha at 10', 'alpha at 11', 'alpha at 12']);
      expect(await hours({ since: '2026-10-01T11:00:00Z' })).toEqual(['alpha at 11', 'alpha at 12']);
      expect(await hours({ until: '2026-10-01T11:00:00Z' })).toEqual(['alpha at 10', 'alpha at 11']);
      expect(await hours({ since: '2026-10-01T11:00:00Z', until: '2026-10-01T11:00:00Z' })).toEqual([
        'alpha at 11',
      ]);
      // The same instant in another zone, with or without fractions.
      expect(
        await hours({ since: '2026-10-01T13:00:00+02:00', until: '2026-10-01T06:00:00.000-05:00' }),
      ).toEqual(['alpha at 11']);
      expect(await hours({ since: '2026-10-01T12:00:00.001Z' })).toEqual([]);
      expect(await hours({ until: '2026-10-01T09:59:59Z' })).toEqual([]);
    });

    it('breaks a tie of relevance by the newer first', async () => {
      for (const hour of [10, 12, 11]) {
        clock = new Date(Date.UTC(2026, 9, 1, hour));
        await task(`civet at ${hour}`);
      }
      expect(await excerpts({ query: 'civet' })).toEqual(['civet at 12', 'civet at 11', 'civet at 10']);
    });

    it('ranks a title match above a body match, then the newer first, then by source id', async () => {
      await task('Other card', 'the pelican is mentioned in the body only');
      await task('Pelican card');
      await task('Another pelican card');
      const order = (await search({ query: 'pelican' })).matches.map((hit) => hit.excerpt.slice(0, 12));
      expect(order.slice(0, 2).sort()).toEqual(['Another peli', 'Pelican card']);
      expect(order[2]).toBe('the pelican ');
      const again = (await search({ query: 'pelican' })).matches.map((hit) => hit.sourceId);
      expect(again).toEqual((await search({ query: 'pelican' })).matches.map((hit) => hit.sourceId));
    });

    it('stops at the limit and says whether there is more, from visible hits only', async () => {
      for (let i = 0; i < 5; i++) await task(`gazelle ${i}`);
      expect(await search({ query: 'gazelle', limit: 2 })).toMatchObject({ hasMore: true });
      expect((await search({ query: 'gazelle', limit: 2 })).matches).toHaveLength(2);
      expect(await search({ query: 'gazelle', limit: 5 })).toMatchObject({ hasMore: false });
      expect((await search({ query: 'gazelle', limit: 5 })).matches).toHaveLength(5);
      expect((await search({ query: 'gazelle' })).matches).toHaveLength(5);
    });

    it('reads past more than two hundred hidden candidates before the limit is filled', async () => {
      // 230 internal cards that match better than the one shared card a client may read.
      for (let i = 0; i < 230; i++) await task(`ibex ibex ibex ${i}`);
      await task('ibex shared one', '', { visibility: 'shared' });
      const found = await search({ query: 'ibex', limit: 1 }, as('acme'));
      expect(found.matches).toHaveLength(1);
      expect(found.matches[0]!.excerpt).toBe('ibex shared one');
      expect(found.hasMore).toBe(false);
      await task('ibex shared two', '', { visibility: 'shared' });
      const more = await search({ query: 'ibex', limit: 1 }, as('acme'));
      expect(more.matches).toHaveLength(1);
      expect(more.hasMore).toBe(true);
      // The owner reads the same data page by page without any hidden candidate in the way.
      expect((await search({ query: 'ibex', limit: 50 })).matches).toHaveLength(50);
      expect((await search({ query: 'ibex', limit: 50 })).hasMore).toBe(true);
    }, 60_000);
  });

  describe('the hit', () => {
    it('has a fixed shape without a score, a count of hidden hits or an index id', async () => {
      await task('Ocelot', 'first line\nsecond line has the ocelot word');
      const result = await search({ query: 'ocelot' });
      expect(HistorySearchResult.parse(result)).toEqual(result);
      expect(Object.keys(result).sort()).toEqual(['documents', 'hasMore', 'matches', 'projectKey']);
      const hit = result.matches[0]!;
      expect(Object.keys(hit).sort()).toEqual([
        'at',
        'author',
        'excerpt',
        'matchType',
        'reference',
        'sourceId',
        'sourceType',
        'taskKey',
      ]);
      expect(hit).toMatchObject({
        sourceType: 'task',
        taskKey: 'AR-1',
        author: 'owner',
        reference: { tool: 'get_task', arguments: { project_key: 'AR', task_key: 'AR-1' } },
      });
      expect(hit.sourceId).toMatch(/^hsrc_[0-9a-f]{64}$/);
    });

    it('points a note at the card and the event, and a message at the history reader', async () => {
      const card = await task('Quokka');
      const note = await h.domain.tasks.addNote('AR', card.key, 'quokka note', OWNER_ACTOR);
      h.domain.messages.record({
        projectKey: 'AR',
        from: 'dev-1',
        to: ['cr'],
        taskKey: null,
        body: 'quokka message',
        actor: OWNER_ACTOR,
        delivered: true,
      });
      h.domain.history.flush();
      const hits = (await search({ query: 'quokka' })).matches;
      expect(hits.find((hit) => hit.sourceType === 'note')!.reference).toEqual({
        tool: 'get_task',
        arguments: { project_key: 'AR', task_key: card.key, event_id: note.id },
      });
      const message = hits.find((hit) => hit.sourceType === 'message')!;
      expect(message.reference).toEqual({
        tool: 'read_history_source',
        arguments: { project_key: 'AR', source_id: message.sourceId },
      });
    });

    it('cuts a long text to an excerpt of at most 600 characters around the match', async () => {
      const long = `${'filler word '.repeat(200)}marmot${' trailing word'.repeat(200)}`;
      await task('Long card', long);
      const [excerpt] = await excerpts({ query: 'marmot' });
      expect([...excerpt!].length).toBeLessThanOrEqual(HISTORY_EXCERPT_MAX_CHARS);
      expect(excerpt).toContain('marmot');
      expect(excerpt!.startsWith('…')).toBe(true);
      expect(excerpt!.endsWith('…')).toBe(true);
    });
  });

  describe('following the sources', () => {
    it('finds a changed card by its new text only, and drops a deleted source', async () => {
      const card = await task('Wombat habitat');
      expect(await excerpts({ query: 'wombat' })).toEqual(['Wombat habitat']);
      await h.domain.tasks.update('AR', card.key, { title: 'Tapir habitat' }, OWNER_ACTOR);
      h.domain.history.flush();
      expect(await excerpts({ query: 'wombat' })).toEqual([]);
      expect(await excerpts({ query: 'tapir' })).toEqual(['Tapir habitat']);
    });

    it('finds a source written after the last flush, because a search brings the index up to date', async () => {
      await h.domain.tasks.create('AR', { title: 'Lemming news' }, OWNER_ACTOR);
      expect(await excerpts({ query: 'lemming' })).toEqual(['Lemming news']);
    });

    it('does not index a note without text or a message with a blank body', async () => {
      const card = await task('Okapi');
      await h.domain.tasks.addNote('AR', card.key, '   ', OWNER_ACTOR).catch(() => undefined);
      h.domain.history.flush();
      expect((await search({ query: 'okapi' })).matches).toHaveLength(1);
    });
  });

  describe('availability', () => {
    it('is unavailable (503) until the index is prepared and after it stops', async () => {
      await h.domain.history.stop();
      await expect(search({ query: 'alpha' })).rejects.toThrowError(
        expect.objectContaining({ status: 503, code: 'history_unavailable' }),
      );
    });
  });

  describe('documents', () => {
    const snapshot = (decisions: string | null, lessons: string | null, commit = COMMIT) => ({
      projectKey: 'AR',
      repo: 'web',
      commit,
      checkedAt: '2026-10-10T10:00:00Z',
      files: [
        { path: 'docs/DECISIONS.md' as const, text: decisions },
        { path: 'docs/LESSONS.md' as const, text: lessons },
      ],
    });
    const stateOf = async (path: string) =>
      (await search({ query: 'whatever', sourceTypes: ['document'] })).documents.find(
        (doc) => doc.path === path,
      )!;

    it('lists a registered repository as pending until the first engine read completes', async () => {
      await h.cleanup();
      let release!: (value: { commit: string; text: null }) => void;
      const firstRead = new Promise<{ commit: string; text: null }>((resolve) => {
        release = resolve;
      });
      h = await historyHarness({
        now: () => clock,
        merger: { readFile: () => firstRead } as unknown as BranchMerger,
      });
      try {
        expect((await search({ query: 'alpha', sourceTypes: ['document'] })).documents).toEqual([
          {
            repo: 'web',
            path: 'docs/DECISIONS.md',
            commit: null,
            checkedAt: null,
            indexedAt: null,
            status: 'pending',
          },
          {
            repo: 'web',
            path: 'docs/LESSONS.md',
            commit: null,
            checkedAt: null,
            indexedAt: null,
            status: 'pending',
          },
        ]);
        expect((await search({ query: 'alpha', sourceTypes: ['task'] })).documents).toEqual([]);
      } finally {
        release({ commit: COMMIT, text: null });
      }
    });

    it('stores a snapshot, finds its text with the commit and the line, and reads it in full', async () => {
      h.domain.history.replaceDocuments(
        snapshot('# Decisions\n\nfirst\nthe narwhal decision\nlast', '# Lessons'),
      );
      const result = await search({ query: 'narwhal', sourceTypes: ['document'] });
      expect(result.matches).toHaveLength(1);
      const hit = result.matches[0]!;
      expect(hit).toMatchObject({
        sourceType: 'document',
        taskKey: null,
        author: null,
        document: { repo: 'web', path: 'docs/DECISIONS.md', commit: COMMIT, line: 4 },
        reference: {
          tool: 'read_history_source',
          arguments: { project_key: 'AR', source_id: hit.sourceId, from_line: 4, commit: COMMIT },
        },
      });
      expect(result.documents.map((doc) => [doc.path, doc.status, doc.commit])).toEqual([
        ['docs/DECISIONS.md', 'ready', COMMIT],
        ['docs/LESSONS.md', 'ready', COMMIT],
      ]);
      const read = h.domain.history.read('AR', OWNER, {
        sourceId: hit.sourceId,
        commit: COMMIT,
        fromLine: 4,
        lineCount: 2,
      });
      expect(read).toMatchObject({
        sourceType: 'document',
        fromLine: 4,
        totalLines: 5,
        text: 'the narwhal decision\nlast',
        document: { repo: 'web', path: 'docs/DECISIONS.md', commit: COMMIT },
      });
    });

    it('replaces a snapshot idempotently: the same text keeps its indexing time', async () => {
      h.domain.history.replaceDocuments(snapshot('narwhal one', 'x'));
      const before = (await search({ query: 'narwhal' })).matches[0]!;
      h.domain.history.replaceDocuments(snapshot('narwhal one', 'x'));
      const same = await search({ query: 'narwhal' });
      expect(same.matches).toHaveLength(1);
      expect(same.matches[0]).toEqual(before);
      h.domain.history.replaceDocuments(snapshot('narwhal one', 'x', COMMIT_2));
      const moved = (await search({ query: 'narwhal' })).matches[0]!;
      expect(moved.document!.commit).toBe(COMMIT_2);
      expect(moved.at).toBe(before.at);
      expect(moved.sourceId).toBe(before.sourceId);
      h.domain.history.replaceDocuments(snapshot('narwhal two', 'x', COMMIT_2));
      expect((await search({ query: 'narwhal' })).matches).toHaveLength(1);
      expect(await excerpts({ query: 'narwhal' })).toEqual(['narwhal two']);
    });

    it('refuses a changed copy on a pinned read with 409 and a read of another source type with 422', async () => {
      h.domain.history.replaceDocuments(snapshot('narwhal one', null));
      const hit = (await search({ query: 'narwhal' })).matches[0]!;
      h.domain.history.replaceDocuments(snapshot('narwhal one', null, COMMIT_2));
      expect(() =>
        h.domain.history.read('AR', OWNER, { sourceId: hit.sourceId, commit: COMMIT }),
      ).toThrowError(expect.objectContaining({ status: 409, code: 'history_source_changed' }));
      const card = await task('narwhal card');
      const taskHit = (await search({ query: 'narwhal', sourceTypes: ['task'] })).matches[0]!;
      expect(taskHit.taskKey).toBe(card.key);
      expect(() =>
        h.domain.history.read('AR', OWNER, { sourceId: taskHit.sourceId, commit: COMMIT }),
      ).toThrowError(expect.objectContaining({ status: 422, code: 'invalid_request' }));
    });

    it('removes a missing file, and keeps an empty one as ready without text', async () => {
      h.domain.history.replaceDocuments(snapshot('narwhal one', 'narwhal two'));
      expect((await search({ query: 'narwhal' })).matches).toHaveLength(2);
      h.domain.history.replaceDocuments(snapshot(null, ''));
      expect((await search({ query: 'narwhal' })).matches).toEqual([]);
      expect(await stateOf('docs/DECISIONS.md')).toMatchObject({
        status: 'missing',
        commit: COMMIT,
        indexedAt: null,
      });
      expect(await stateOf('docs/LESSONS.md')).toMatchObject({ status: 'ready' });
    });

    it('keeps the indexing time of an unchanged empty document in a new commit', async () => {
      h.domain.history.replaceDocuments(snapshot('', null));
      const first = await stateOf('docs/DECISIONS.md');
      h.domain.history.replaceDocuments({
        ...snapshot('', null, COMMIT_2),
        checkedAt: '2026-10-12T10:00:00Z',
      });
      expect(await stateOf('docs/DECISIONS.md')).toMatchObject({
        indexedAt: first.indexedAt,
        checkedAt: '2026-10-12T10:00:00.000Z',
        commit: COMMIT_2,
        status: 'ready',
      });
    });

    it('marks the copy stale when the repository cannot be read, and unavailable when there is none', async () => {
      h.domain.history.markDocumentsUnavailable('AR', 'web', '2026-10-11T10:00:00Z');
      expect(await stateOf('docs/DECISIONS.md')).toMatchObject({ status: 'unavailable', commit: null });
      h.domain.history.replaceDocuments(snapshot('narwhal one', null));
      h.domain.history.markDocumentsUnavailable('AR', 'web', '2026-10-12T10:00:00Z');
      expect(await stateOf('docs/DECISIONS.md')).toMatchObject({
        status: 'stale',
        commit: COMMIT,
        checkedAt: '2026-10-12T10:00:00.000Z',
      });
      // The stale copy is still searched.
      expect((await search({ query: 'narwhal' })).matches).toHaveLength(1);
      expect(await stateOf('docs/LESSONS.md')).toMatchObject({ status: 'unavailable' });
    });

    it('drops the documents of a repository that is removed', async () => {
      h.domain.history.replaceDocuments(snapshot('narwhal one', 'narwhal two'));
      h.domain.history.removeRepositoryDocuments('AR', 'web');
      expect((await search({ query: 'narwhal' })).matches).toEqual([]);
      expect(await stateOf('docs/DECISIONS.md')).toMatchObject({ status: 'pending' });
    });

    it('refuses an invalid snapshot', () => {
      const invalid = expect.objectContaining({ status: 422, code: 'invalid_request' });
      const ok = snapshot('a', 'b');
      expect(() => h.domain.history.replaceDocuments({ ...ok, files: [ok.files[0]!] })).toThrowError(invalid);
      expect(() =>
        h.domain.history.replaceDocuments({ ...ok, files: [ok.files[0]!, ok.files[0]!] }),
      ).toThrowError(invalid);
      expect(() => h.domain.history.replaceDocuments({ ...ok, checkedAt: 'now' })).toThrowError(invalid);
    });

    it('never shows a client a document or the document states', async () => {
      h.domain.history.replaceDocuments(snapshot('narwhal one', null));
      const own = await search({ query: 'narwhal', sourceTypes: ['document'] }, as('acme'));
      expect(own).toEqual({ projectKey: 'AR', matches: [], hasMore: false, documents: [] });
      const hit = (await search({ query: 'narwhal' })).matches[0]!;
      expect(() => h.domain.history.read('AR', as('acme'), { sourceId: hit.sourceId })).toThrowError(
        expect.objectContaining({ status: 404 }),
      );
      expect((await search({ query: 'narwhal' }, as('dev'))).matches).toHaveLength(1);
    });
  });

  describe('read', () => {
    it('pages a long text by lines and reports the total', async () => {
      const body = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n');
      await task('Paged', body);
      const hit = (await search({ query: 'paged' })).matches[0]!;
      const first = h.domain.history.read('AR', OWNER, { sourceId: hit.sourceId });
      expect(first).toMatchObject({ fromLine: 1, totalLines: 252, sourceType: 'task', taskKey: 'AR-1' });
      expect(first.text.split('\n')).toHaveLength(80);
      const tail = h.domain.history.read('AR', OWNER, {
        sourceId: hit.sourceId,
        fromLine: 250,
        lineCount: 200,
      });
      expect(tail.text).toBe('line 248\nline 249\nline 250');
      const refused = expect.objectContaining({ status: 422, code: 'invalid_request' });
      expect(() =>
        h.domain.history.read('AR', OWNER, { sourceId: hit.sourceId, fromLine: 253 }),
      ).toThrowError(refused);
      expect(() =>
        h.domain.history.read('AR', OWNER, { sourceId: hit.sourceId, lineCount: 201 }),
      ).toThrowError(refused);
      expect(() => h.domain.history.read('AR', OWNER, { sourceId: hit.sourceId, fromLine: 0 })).toThrowError(
        refused,
      );
      expect(() => h.domain.history.read('AR', OWNER, { sourceId: '' })).toThrowError(refused);
    });

    it('reads the current text of a changed source, not the old index copy', async () => {
      const card = await task('Hedgehog', 'old description');
      const hit = (await search({ query: 'hedgehog' })).matches[0]!;
      await h.domain.tasks.update('AR', card.key, { description: 'new description' }, OWNER_ACTOR);
      expect(h.domain.history.read('AR', OWNER, { sourceId: hit.sourceId }).text).toBe(
        'Hedgehog\n\nnew description',
      );
    });
  });
});
